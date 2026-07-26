/**
 * Metadata: fetch, cache, and query `api/reflection/types`.
 *
 * REQ-010, REQ-011 · STORY-24, STORY-61
 *
 * Two properties worth protecting:
 *   • The endpoint is [SignumAllowAnonymous], so discovery and dynamic help need NO
 *     credentials (AC-61.4). Someone can evaluate an app before being onboarded.
 *   • It sends Last-Modified and honours If-Modified-Since, so a warm cache makes
 *     discovery work fully offline (AC-61.3).
 *
 * ⚠️ The precise TypeInfoTS field names are read from ReflectionServer.cs but have NOT been
 * verified against a running server. Parsing is therefore deliberately tolerant: unknown
 * shapes degrade to "present but undescribed" rather than throwing.
 */

import { SignumHttp } from "./http.ts";
import { loadMetadataCache, saveMetadataCache } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { editDistance } from "./text.ts";

export interface MemberInfo {
  name: string;
  type: string | undefined;
  niceName: string | undefined;
}

export interface OperationInfo {
  /** Canonical key: `ContainerClass.FieldName` (Symbol.cs:22). */
  key: string;
  /** The verb half — the field name — used for `<verb> <Type>` dispatch. */
  verb: string;
  niceName: string | undefined;
}

export interface TypeInfo {
  name: string;
  kind: string | undefined;
  niceName: string | undefined;
  members: MemberInfo[];
  operations: OperationInfo[];
  hasQuery: boolean;
}

export interface Metadata {
  types: Map<string, TypeInfo>;
  /** Where it came from, for `--explain` and staleness reporting. */
  origin: { url: string; fetchedAt: string; fromCache: boolean; stale: boolean };
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
    return { name, type: typeName, niceName: str(i["niceName"]) };
  });
}

function parseOperations(raw: unknown): OperationInfo[] {
  if (raw === null || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([key, info]) => {
    const i = (info ?? {}) as Record<string, unknown>;
    const dot = key.lastIndexOf(".");
    return {
      key,
      verb: dot === -1 ? key : key.slice(dot + 1),
      niceName: str(i["niceName"]),
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
        niceName: str(t["niceName"]),
        members: parseMembers(t["members"]),
        operations: parseOperations(t["operations"]),
        hasQuery: t["queryDefined"] === true || t["hasQuery"] === true,
      });
    }
  }
  return { types, origin };
}

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
  const cached = loadMetadataCache(opts.url, opts.env);

  if (opts.offline === true) {
    if (cached === undefined) {
      throw new CliError("no cached metadata for this target", ExitCode.Transport, {
        hint: "Run a command online once to populate the cache.",
      });
    }
    return parseMetadata(cached.payload, {
      url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: true,
    });
  }

  try {
    const res = await opts.http.request<unknown>({
      method: "GET",
      path: "api/reflection/types",
      allowAnonymous: true, // anonymous endpoint — no credential needed (AC-61.4)
      ifModifiedSince: cached?.lastModified,
    });

    if (res.notModified && cached !== undefined) {
      return parseMetadata(cached.payload, {
        url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: false,
      });
    }

    const lastModified = res.headers.get("last-modified") ?? undefined;
    saveMetadataCache(opts.url, res.body, lastModified, opts.env);
    return parseMetadata(res.body, {
      url: opts.url, fetchedAt: new Date().toISOString(), fromCache: false, stale: false,
    });
  } catch (err) {
    // A stale cache is used and flagged, never discarded (AC-61.6).
    if (cached !== undefined) {
      opts.warn?.(`warning: could not refresh metadata, using cache from ${cached.fetchedAt}\n`);
      return parseMetadata(cached.payload, {
        url: opts.url, fetchedAt: cached.fetchedAt, fromCache: true, stale: true,
      });
    }
    throw err;
  }
}
