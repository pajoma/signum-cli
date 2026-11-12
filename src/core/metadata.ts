/**
 * Metadata: fetch, cache, and query `api/reflection/types`.
 *
 * REQ-010, REQ-011 · STORY-24, STORY-61
 *
 * Two properties worth protecting:
 *   • The endpoint is [SignumAllowAnonymous], so discovery needs NO credentials (AC-61.4).
 *     What it shows an anonymous caller is another matter: with Signum.Authorization, no entity
 *     at all (AuthServer.cs:70-75) — see `needsLogin`.
 *   • It sends Last-Modified and honours If-Modified-Since, so a warm cache makes
 *     discovery work fully offline (AC-61.3).
 *
 * ⚠️ The precise TypeInfoTS field names are read from ReflectionServer.cs but have NOT been
 * verified against a running server. Parsing is therefore deliberately tolerant: unknown
 * shapes degrade to "present but undescribed" rather than throwing.
 *
 * `queryDefined` is the exception — it IS verified: `TypeInfoTS.QueryDefined`
 * (ReflectionServer.cs:474) is camel-cased on the wire and carries
 * `[JsonIgnore(WhenWritingDefault)]`, so it is present-and-true or absent, never `false`.
 * It is also ROLE-DEPENDENT: `AuthServer.cs:161-176` clears it for any query the caller may
 * not run, and says so in `queryAllowed: "None"`; an anonymous caller may run none. That is why
 * the cache is split by auth state (config.ts `cachePath`) — a stale anonymous document would say
 * "nothing is queryable".
 */

import { Explained, SignumHttp } from "./http.ts";
import { loadMetadataCache, saveMetadataCache } from "./metadata-cache.ts";
import { CliError, ExitCode, NotAuthenticatedError, NotAuthorizedError, NotFoundError, UsageError } from "./errors.ts";
import { editDistance } from "./text.ts";

export interface MemberInfo {
  name: string;
  type: string | undefined;
  niceName: string | undefined;
  /** `TypeReferenceTS.IsLite` (`ReflectionServer.cs:548`): a value for it is a Lite, `{EntityType, id}`. */
  isLite?: boolean;
  /** An MList, or another collection: a setter cannot address one of its rows by position. */
  isCollection?: boolean;
}

/** `OperationType` (`Operation.cs:233-240`), serialized by name. */
export type OperationKind = "Execute" | "Delete" | "Constructor" | "ConstructorFrom" | "ConstructorFromMany";
const OPERATION_KINDS: ReadonlySet<string> = new Set<OperationKind>(["Execute", "Delete", "Constructor", "ConstructorFrom", "ConstructorFromMany"]);

export interface OperationInfo {
  /** Canonical key: `ContainerClass.FieldName` (Symbol.cs:22). */
  key: string;
  /** The verb half — the field name — used for `<verb> <Type>` dispatch. */
  verb: string;
  niceName: string | undefined;
  /** `OperationInfoTS.operationType` (`ReflectionServer.cs:518-543`); undefined when not sent. */
  kind: OperationKind | undefined;
  /**
   * `canBeModified`: the operation takes the ENTITY, edits included, so it goes to the `…Entity`
   * route; otherwise only its Lite (`EntityOperations.tsx:133-149`). A `Save` is `Execute` with this.
   */
  canBeModified: boolean;
  /** `canBeNew`: the operation may run on an entity that was never saved. */
  canBeNew: boolean;
  /**
   * `resultIsSaved`: a constructor's result is already in the database. When false the server hands
   * back an entity that does not exist yet, and saying "created" would be a lie (#118).
   */
  resultIsSaved: boolean;
}

export interface TypeInfo {
  name: string;
  /**
   * What the type IS — `Entity`, `Enum`, `Message`, `Query` or `SymbolContainer` (KindOfType,
   * `ReflectionServer.cs:629-636`). Not the entity kind: that is `entityKind`.
   */
  kind: string | undefined;
  /** For entities only: `Main`, `Part`, `String`, `System`, … (`TypeInfoTS.EntityKind`, `:469`). */
  entityKind: string | undefined;
  /**
   * For entities only: `Master` or `Transactional` (`TypeInfoTS.EntityData`, `ReflectionServer.cs:470`).
   * `api/fetchAll` refuses a Transactional type (`EntityController.cs:77-89`), so `get <Type>` asks first.
   */
  entityData?: string | undefined;
  niceName: string | undefined;
  members: MemberInfo[];
  operations: OperationInfo[];
  hasQuery: boolean;
  /** Absent without Signum.Authorization, and for a value it does not define. See `queryDenied`. */
  queryAllowed: QueryAllowed | undefined;
}

/**
 * May the caller's role run a type's query, as Signum.Authorization reports it (AuthServer.cs:161-176).
 * `None` also clears `queryDefined`, which is what tells "you may not" from "there is none". The API
 * runs `EmbeddedOnly` queries (DynamicQueryContainer.cs:29, `fullScreen: false`).
 */
export type QueryAllowed = "Allow" | "EmbeddedOnly" | "None";
const QUERY_ALLOWED: ReadonlySet<string> = new Set<QueryAllowed>(["Allow", "EmbeddedOnly", "None"]);

/** The caller's role may not run this type's query: the server cleared `queryDefined` and said why. */
export function queryDenied(t: TypeInfo): boolean {
  return !t.hasQuery && t.queryAllowed === "None";
}

export interface Metadata {
  types: Map<string, TypeInfo>;
  /** Where it came from, for `--explain` and staleness reporting. */
  origin: {
    url: string; fetchedAt: string; fromCache: boolean; stale: boolean;
    /** Fetched with a credential. Reflection answers depend on who asks (AuthServer.cs:70-176). */
    authenticated: boolean;
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function parseMembers(raw: unknown): MemberInfo[] {
  if (raw === null || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, info]) => {
    const i = (info ?? {}) as Record<string, unknown>;
    const t = i["type"];
    const typeName = t !== null && typeof t === "object"
      ? str((t as Record<string, unknown>)["name"])
      : str(t);
    const ref = t !== null && typeof t === "object" ? t as Record<string, unknown> : {};
    return {
      name, type: typeName, niceName: str(i["niceName"]),
      ...(ref["isLite"] === true ? { isLite: true } : {}),
      ...(ref["isCollection"] === true ? { isCollection: true } : {}),
    };
  });
}

function parseOperations(raw: unknown): OperationInfo[] {
  if (raw === null || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([key, info]) => {
    const i = (info ?? {}) as Record<string, unknown>;
    const dot = key.lastIndexOf(".");
    const kind = str(i["operationType"]);
    return {
      key,
      verb: dot === -1 ? key : key.slice(dot + 1),
      niceName: str(i["niceName"]),
      kind: kind !== undefined && OPERATION_KINDS.has(kind) ? kind as OperationKind : undefined,
      canBeModified: i["canBeModified"] === true,
      canBeNew: i["canBeNew"] === true,
      resultIsSaved: i["resultIsSaved"] === true,
    };
  });
}

export function parseMetadata(payload: unknown, origin: Metadata["origin"]): Metadata {
  const types = new Map<string, TypeInfo>();
  if (payload !== null && typeof payload === "object") {
    for (const [name, raw] of Object.entries(payload as Record<string, unknown>)) {
      const t = (raw ?? {}) as Record<string, unknown>;
      types.set(name.toLowerCase(), {
        name,
        kind: str(t["kind"]),
        entityKind: str(t["entityKind"]),
        ...(str(t["entityData"]) !== undefined ? { entityData: str(t["entityData"]) } : {}),
        niceName: str(t["niceName"]),
        members: parseMembers(t["members"]),
        operations: parseOperations(t["operations"]),
        hasQuery: t["queryDefined"] === true || t["hasQuery"] === true,
        queryAllowed: QUERY_ALLOWED.has(String(t["queryAllowed"])) ? t["queryAllowed"] as QueryAllowed : undefined,
      });
    }
  }
  return { types, origin };
}

/**
 * Is this type an entity — something a member can REFERENCE, i.e. an identity?
 *
 * Reflection lists enums, messages and symbol containers next to entities, so "a type exists by
 * this name" is not enough: an enum-typed member such as `State` would read as an identity. Nor is
 * `kind: "Entity"`: it covers every ModifiableEntity, embedded and model types included, and only
 * an IEntity carries `entityKind` (`ReflectionServer.cs:259-264`). An embedded value is part of its
 * owner, not a record of its own — it has no id to reference or retrieve.
 */
export function isEntityTypeInfo(t: TypeInfo | undefined): boolean {
  return t?.kind === "Entity" && t.entityKind !== undefined;
}

/** The `--kind` values `signum types` accepts, mapped to KindOfType. */
export const TYPE_KINDS: Readonly<Record<string, string>> = {
  entity: "Entity", enum: "Enum", message: "Message", query: "Query",
  symbol: "SymbolContainer", symbolcontainer: "SymbolContainer",
};

/** Case- and kebab-insensitive type lookup (AC-41.7). */
export function findType(md: Metadata, name: string): TypeInfo | undefined {
  const norm = (s: string) => s.toLowerCase().replaceAll("-", "");
  const target = norm(name);
  const direct = md.types.get(name.toLowerCase());
  if (direct !== undefined) return direct;
  for (const t of md.types.values()) {
    if (norm(t.name) === target) return t;
    // `Order` should also match the class name `OrderEntity` (AC-30.4).
    if (norm(t.name) === target + "entity" || norm(t.name) + "entity" === target) return t;
  }
  return undefined;
}

/**
 * Every type this application will accept as a query key, sorted. THE definition of "queryable"
 * — `signum queries` lists exactly this, and `resolveQueryKey` accepts exactly this. They used
 * to disagree: discovery filtered on `hasQuery` while `query` accepted anything `findType`
 * returned, so a type `signum queries` never offered still passed local validation and reached
 * the server (Brooks review: DRY).
 */
export function queryableTypes(md: Metadata): TypeInfo[] {
  return [...md.types.values()].filter((t) => t.hasQuery).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a query key against metadata, or fail with a message that says which problem it is
 * (AC-20.7, AC-63.4, AC-63.6).
 *
 * @throws NotAuthenticatedError when the key is missing from an anonymous view that hides entities.
 * @throws NotAuthorizedError when the caller's role may not run the query (REQ-051: exit 4).
 * @throws UsageError when the type is unknown, or known but defines no query.
 */
export function resolveQueryKey(md: Metadata, key: string): TypeInfo {
  const type = findType(md, key);
  if (type === undefined) {
    const hidden = needsLogin(md, `query key '${key}'`);
    if (hidden !== undefined) throw hidden;
    const near = suggestTypes(md, key);
    throw new UsageError(`unknown query key '${key}'`, {
      hint: near.length > 0
        ? `Did you mean: ${near.join(", ")}?\nRun \`signum queries\` for the list.`
        : "Run `signum queries` to see available queries.",
    });
  }
  if (queryDenied(type)) {
    // Refused here rather than sent: the server would answer 403 + UnauthorizedAccessException
    // (DynamicQueryContainer.cs:205-209), which is exit 4 too. Anonymously it means "log in": an app
    // with QueryAuthLogic but not TypeAuthLogic lists its entities to anyone, and denies every query.
    if (!md.origin.authenticated) {
      throw new NotAuthenticatedError(`query '${type.name}' needs a login`, {
        loginHint: { url: md.origin.url, render: (login) => `Log in and retry: ${login}` },
      });
    }
    throw new NotAuthorizedError(`your role may not run query '${type.name}'`, {
      hint:
        "The application's permissions deny this query to you (queryAllowed: None). That is a\n" +
        "permission, not a typo: retrying will not help. Ask an administrator for access, or run\n" +
        "`signum queries` for the queries you may run.",
    });
  }
  if (!type.hasQuery) {
    throw new UsageError(`'${type.name}' has no query you can run`, {
      hint:
        "The application's metadata reports no default query for this type.\n" +
        `Run \`signum queries\` for what IS available, or \`signum explain ${type.name}\` for the type itself.`,
    });
  }
  return type;
}

/**
 * The error for a name missing from an ANONYMOUS view that hides entities, else undefined.
 *
 * With Signum.Authorization, reflection lists no entity type to a caller who is not logged in
 * (AuthServer.cs:70-75). An anonymous document without a single entity is therefore that view,
 * not an application without entities, and "unknown type" would send the user hunting for a typo.
 * Logging in is what helps, which is what exit 3 means. Seen live: a handful of types and no
 * entity anonymously, hundreds logged in.
 */
export function needsLogin(md: Metadata, subject: string): NotAuthenticatedError | undefined {
  if (!hidesEntities(md)) return undefined;
  return new NotAuthenticatedError(`${subject} is not visible without a login`, {
    loginHint: { url: md.origin.url, render: (login) => `${anonymousViewNote(md)}\nLog in and retry: ${login}` },
  });
}

/**
 * The error for a type name `md` does not know — the one answer every lookup gives: "log in" when an
 * anonymous view hides it (exit 3), else "unknown type" with the nearest names (exit 5, AC-63.4).
 */
export function unknownTypeError(md: Metadata, name: string): NotAuthenticatedError | NotFoundError {
  const hidden = needsLogin(md, `type '${name}'`);
  if (hidden !== undefined) return hidden;
  const near = suggestTypes(md, name);
  return new NotFoundError(`unknown type '${name}'`, {
    hint: near.length > 0
      ? `Did you mean: ${near.join(", ")}?\nRun \`signum types\` for the full list.`
      : "Run `signum types` to see what this application exposes.",
  });
}

/** An anonymous view with no entity in it: what Signum.Authorization shows a caller not logged in. */
export function hidesEntities(md: Metadata): boolean {
  return !md.origin.authenticated && ![...md.types.values()].some(isEntityTypeInfo);
}

/** One line saying what an anonymous view leaves out. */
export function anonymousViewNote(md: Metadata): string {
  return `Without a login this application lists ${md.types.size} types and no entity: it shows its entities only to a logged-in user.`;
}

/**
 * Near matches for a mistyped name (AC-63.4). Substring containment alone is not enough —
 * it cannot suggest `Order` for `Ordr`, which is exactly the typo people make.
 */
export function suggestTypes(md: Metadata, name: string, limit = 5): string[] {
  const target = name.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const t of md.types.values()) {
    const candidate = t.name.toLowerCase();
    const bare = candidate.replace(/entity$/, "");
    let score: number;
    if (candidate.includes(target) || target.includes(candidate)) score = 0;
    else {
      score = Math.min(editDistance(target, candidate), editDistance(target, bare));
      // Allow roughly a third of the name to be wrong, with a floor for short names.
      if (score > Math.max(2, Math.floor(candidate.length / 3))) continue;
    }
    scored.push({ name: t.name, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}

export interface LoadMetadataOptions {
  url: string;
  http: SignumHttp;
  /** Skip the network entirely and use whatever is cached. */
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (line: string) => void;
}

export async function loadMetadata(opts: LoadMetadataOptions): Promise<Metadata> {
  // Reflection answers are role-dependent, so anonymous and authenticated responses are cached
  // separately — see the header note and config.ts `cachePath`.
  const authenticated = opts.http.hasToken;
  const cached = loadMetadataCache(opts.url, authenticated, opts.env);

  if (opts.offline === true) {
    if (cached === undefined) {
      throw new CliError("no cached metadata for this target", ExitCode.Transport, {
        hint: "Run a command online once to populate the cache.",
      });
    }
    return parseMetadata(cached.payload, {
      url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, authenticated,
    });
  }

  try {
    const res = await opts.http.request<unknown>({
      method: "GET",
      path: "api/reflection/types",
      allowAnonymous: true, // anonymous endpoint — no credential needed (AC-61.4)
      ifModifiedSince: cached?.lastModified,
      prepare: true, // metadata to build a request with; sent under --explain too (REQ-053)
    });

    if (res.notModified && cached !== undefined) {
      return parseMetadata(cached.payload, {
        url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: false, authenticated,
      });
    }

    const lastModified = res.headers.get("last-modified") ?? undefined;
    saveMetadataCache(opts.url, authenticated, res.body, lastModified, opts.env);
    return parseMetadata(res.body, {
      url: opts.url, fetchedAt: new Date().toISOString(), fromCache: false, stale: false, authenticated,
    });
  } catch (err) {
    if (err instanceof Explained) throw err;
    // A stale cache is used and flagged, never discarded (AC-61.6).
    if (cached !== undefined) {
      opts.warn?.(`warning: could not refresh metadata, using cache from ${cached.fetchedAt}\n`);
      return parseMetadata(cached.payload, {
        url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, authenticated,
      });
    }
    throw err;
  }
}
