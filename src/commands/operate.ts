/**
 * Invoking an operation: `signum ship order 42`, `signum OrderOperation.Ship --lite "Order;42"`.
 *
 * REQ-040 (#114) execute · REQ-041 (#116) naming · REQ-042 (#115) args · REQ-033 (#117) ticks ·
 * REQ-043 (#112) dry run · REQ-046 (#113) guard. Stories: docs/stories/operations.md.
 *
 * There is no save endpoint: every mutation, saving included, is an operation (STORY-40). This file
 * is therefore the whole write path, and every write leaves it through `send`, which takes a
 * `MutationPermit` only `confirmMutation` can mint.
 *
 * Choosing the route is the part that goes wrong (#114). The server says which an operation wants:
 * `canBeModified` sends the ENTITY to `executeEntity`, otherwise its Lite goes to `executeLite`
 * (`EntityOperations.tsx:133-149`). An edited graph must never go out as a Lite — the edits would be
 * dropped without a word — so `--edit` on an operation that takes only a Lite is refused.
 *
 * Construct, construct-from and delete (#118) go to their own endpoints. A Save that may run on a
 * new entity, with no record named, creates one from `--edit` values, as the web UI's "new" does.
 * More than one record makes it a bulk operation (#119), which `operate-bulk.ts` runs: one request,
 * one outcome per record. `--progress` sends one record to `executeLiteWithProgress` and shows the
 * server's progress as it streams (AC-45.2).
 */

import type { Ctx } from "../core/ctx.ts";
import { flag, opt, optAll } from "../core/ctx.ts";
import { ConcurrencyError, CliError, ExitCode, InterruptedError, NotFoundError, TransportError, UsageError } from "../core/errors.ts";
import {
  applyDocument, asEntity, fetchEntity, markAllModified, serializeEntity, setMember,
  type DocumentValue, type EntityJson, type MemberPath,
} from "../core/entity.ts";
import { assertPermit, confirmMutation, recordMutation, type MutationPermit } from "../core/guard.ts";
import { loadHandles } from "../core/handles.ts";
import { assertOneStdin, inputReader, isIndirect, type InputReader } from "../core/input.ts";
import { JsonNumber, parseLossless } from "../core/json.ts";
import { findType, loadMetadata, type Metadata } from "../core/metadata.ts";
import { kebab, resolveKey, resolveVerbNoun, type ArgValue, type ResolvedOperation } from "../core/operations.ts";
import { renderDocument } from "../core/output.ts";
import { looksLikeSurrogate, pseudonymizeDocument } from "../core/privacy.ts";
import { isHandle, resolveHandle } from "../core/reidentify.ts";
import { resolveTarget, type Target } from "../core/target.ts";
import { nearest, parseLiteKey } from "../core/text.ts";
import { bulkPlan, isBulkRequest, runBulk, type BulkPlan } from "./operate-bulk.ts";
import {
  argsOf, cleanName, DATA_KIND, explainSendError, failureOf, interruptible, liteJson, packCanExecute, parseEdits, permission,
  recordKey, renderPack, shownTarget, type Edit, type OperationTarget,
} from "./operate-common.ts";

/** What an operation command accepts besides the global flags. */
export const OPERATION_FLAGS = [
  "arg", "arg-string", "arg-lite", "arg-json", "allow-custom-arg",
  "lite", "id", "edit", "setters-json", "f", "filename", "yes", "y", "dry-run", "progress",
] as const;

function assertOperationFlags(ctx: Ctx): void {
  const known = new Set<string>(OPERATION_FLAGS);
  const unknown = [...ctx.args.options.keys(), ...ctx.args.booleans].filter((f) => !known.has(f));
  if (unknown.length === 0) return;
  const described = unknown.map((u) => {
    const near = nearest(u, known);
    return near !== undefined ? `--${u} (did you mean --${near}?)` : `--${u}`;
  });
  throw new UsageError(`unknown flag${unknown.length > 1 ? "s" : ""} for an operation: ${described.join(", ")}`, {
    hint: `An operation takes: ${OPERATION_FLAGS.map((f) => (f.length === 1 ? `-${f}` : `--${f}`)).join(", ")}.`,
  });
}

/** `Order;42`, `ref_…`, or a bare id for an already-known type. Handles resolve locally (AC-53.2). */
function parseTarget(written: string, typeHint: string | undefined, handles: Readonly<Record<string, string>>): OperationTarget {
  const real = isHandle(written) ? resolveHandle(written, handles) : written;
  const lite = parseLiteKey(real);
  if (lite !== undefined) return { type: lite.type, id: lite.id, shown: written };
  if (typeHint === undefined) {
    throw new UsageError(`'${written}' is not a Lite key`, { hint: 'Name the record as "Type;id", e.g. --lite "Order;42".' });
  }
  return { type: typeHint, id: written, shown: written };
}

/**
 * A list of records read from a file or stdin (#119, #120): a JSON array, or one per line. Each
 * entry is a Lite key, a handle, a bare id (for `--id`), a Lite object, or an object with an
 * `Entity` member — a row of `signum query … -o ndjson` — so a query's answer can be piped into the
 * operation that acts on it. Blank lines and `#` comments are skipped.
 */
export function parseRecordList(text: string, source: string): string[] {
  const entry = (v: unknown, where: string): string => {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o["EntityType"] === "string" && o["id"] !== undefined && o["id"] !== null) return `${o["EntityType"]};${String(o["id"])}`;
      if ("Entity" in o) return entry(o["Entity"], where);
    }
    throw new UsageError(`${source}, ${where}: not a record`, {
      hint: 'One per line: Order;42, a ref_ handle, or {"EntityType":"Order","id":42}. A query row with an Entity column works too.',
    });
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    let list: unknown;
    try {
      list = parseLossless(trimmed);
    } catch (err) {
      throw new UsageError(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return (list as unknown[]).map((v, i) => entry(v, `item ${i + 1}`));
  }
  const out: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("{")) {
      let o: unknown;
      try {
        o = parseLossless(line);
      } catch {
        throw new UsageError(`${source}, line ${i + 1}: not valid JSON`);
      }
      out.push(entry(o, `line ${i + 1}`));
    } else {
      out.push(entry(line, `line ${i + 1}`));
    }
  });
  if (out.length === 0) throw new UsageError(`${source} names no records`);
  return out;
}

/** `--lite`/`--id` values, with every `@file` and `-` among them expanded into the records it lists. */
async function expandRecords(input: InputReader, flagName: string, values: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const v of values) {
    if (!isIndirect(v)) {
      out.push(v);
      continue;
    }
    const where = v === "-" ? `--${flagName} - (stdin)` : `--${flagName} file '${v.slice(1)}'`;
    out.push(...parseRecordList(await input.read(flagName, v), where));
  }
  return out;
}

/**
 * The records an operation runs on: positionals after the noun, repeated `--lite`, or repeated `--id`
 * — one of the three, so a list is never half of one kind and half of another. `--lite` and `--id`
 * also take `@file` and `-` (#120). More than one record makes it a bulk operation (#119).
 */
async function targetsOf(ctx: Ctx, input: InputReader, noun: string | undefined, positionals: readonly string[]): Promise<OperationTarget[]> {
  const handles = loadHandles(ctx.io.env, ctx.target);
  const sources = [
    { from: "position", values: [...positionals] },
    { from: "--lite", values: await expandRecords(input, "lite", optAll(ctx, "lite")) },
    { from: "--id", values: await expandRecords(input, "id", optAll(ctx, "id")) },
  ].filter((s) => s.values.length > 0);
  if (sources.length > 1) {
    throw new UsageError(`name the records one way; got ${sources.map((s) => s.from).join(" and ")}`);
  }
  const source = sources[0];
  if (source === undefined) return [];
  const targets = source.values.map((v) => {
    if (source.from === "--id" && parseLiteKey(v) !== undefined) {
      throw new UsageError(`--id takes a bare id; '${v}' is a Lite key`, { hint: `Use --lite "${v}".` });
    }
    return parseTarget(v, noun, handles);
  });
  const seen = new Set<string>();
  for (const t of targets) {
    const key = recordKey(t.type, t.id);
    if (seen.has(key)) throw new UsageError(`${t.shown} is named twice`, { hint: "Each record once: a bulk operation runs once per record." });
    seen.add(key);
  }
  return targets;
}

/**
 * Spell an `--edit` path the way the WIRE does. Members are camelCase on the wire (`name`, `rASCI`)
 * while people, help and reflection say `Name`, `RASCI`; `setMember` is exact, so without this the
 * documented `--edit Name=…` would be refused. Matched case-insensitively against the fetched entity,
 * exact first, and an index into an MList steps into the row's element as `setMember` does.
 */
function wirePath(entity: EntityJson, path: MemberPath): MemberPath {
  const out: Array<string | number> = [];
  let node: unknown = entity;
  for (const segment of path) {
    if (typeof segment === "number") {
      out.push(segment);
      const item = Array.isArray(node) ? (node as unknown[])[segment] : undefined;
      node = item !== null && typeof item === "object" && Object.hasOwn(item, "rowId") && Object.hasOwn(item, "element")
        ? (item as Record<string, unknown>)["element"]
        : item;
      continue;
    }
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      out.push(segment);
      node = undefined;
      continue;
    }
    const o = node as Record<string, unknown>;
    const key = Object.hasOwn(o, segment) ? segment : Object.keys(o).find((k) => k.toLowerCase() === segment.toLowerCase()) ?? segment;
    out.push(key);
    node = o[key];
  }
  return out;
}

/**
 * Which endpoint an operation goes to. The server's own metadata decides: `operationType` picks the
 * family, `canBeModified` picks entity-or-Lite (`EntityOperations.tsx:133-149`), and a Save that may
 * run on a new entity (`canBeNew`) with no record named creates one, as the web UI's "new" does.
 */
type Route =
  | "executeEntity" | "executeLite" | "executeLiteWithProgress" | "saveNew"
  | "construct" | "constructFromEntity" | "constructFromLite"
  | "deleteEntity" | "deleteLite";

/** What each route sends, and what that implies. Every route-dependent rule reads it from here. */
interface RouteTraits {
  /** The `api/operation/<endpoint>/{key}` segment. */
  endpoint: string;
  /** The fetched entity, its Lite, a new entity built from `--edit`, or only the type. */
  sends: "entity" | "lite" | "new" | "type";
  /** A delete: the prompt says it cannot be undone, and the result is what is gone. */
  destructive: boolean;
  /** A constructor: its result may be unsaved, and it may decline (AC-44.5). */
  constructs: boolean;
  /** Saves the entity it is given, so an `--edit` reaches the server instead of being dropped (#114). */
  takesEdits: boolean;
}

const ROUTES: Record<Route, RouteTraits> = {
  executeEntity: { endpoint: "executeEntity", sends: "entity", destructive: false, constructs: false, takesEdits: true },
  executeLite: { endpoint: "executeLite", sends: "lite", destructive: false, constructs: false, takesEdits: false },
  executeLiteWithProgress: { endpoint: "executeLiteWithProgress", sends: "lite", destructive: false, constructs: false, takesEdits: false },
  saveNew: { endpoint: "executeEntity", sends: "new", destructive: false, constructs: false, takesEdits: true },
  construct: { endpoint: "construct", sends: "type", destructive: false, constructs: true, takesEdits: false },
  constructFromEntity: { endpoint: "constructFromEntity", sends: "entity", destructive: false, constructs: true, takesEdits: false },
  constructFromLite: { endpoint: "constructFromLite", sends: "lite", destructive: false, constructs: true, takesEdits: false },
  deleteEntity: { endpoint: "deleteEntity", sends: "entity", destructive: true, constructs: false, takesEdits: false },
  deleteLite: { endpoint: "deleteLite", sends: "lite", destructive: true, constructs: false, takesEdits: false },
};

/** The `--explain` / request body, built once for both. */
interface Plan {
  op: ResolvedOperation;
  /** Undefined for a constructor and for a Save that creates. */
  target: OperationTarget | undefined;
  route: Route;
  args: ArgValue[] | null;
  edits: Edit[];
  /** `-f`: the document the caller edited, applied to the record as it is when sent (#120). */
  document: EntityDocument | undefined;
}

interface EntityDocument {
  edited: EntityJson;
  /** Where it came from, for `--explain` and messages: `-f order.json`, `-f - (stdin)`. */
  source: string;
  value: DocumentValue;
}

function routeOf(op: ResolvedOperation, hasTarget: boolean): Route {
  const kind = op.info.kind ?? "Execute";
  const entity = op.info.canBeModified;
  switch (kind) {
    case "Execute":
      if (!hasTarget && entity && op.info.canBeNew) return "saveNew";
      return entity ? "executeEntity" : "executeLite";
    case "Constructor": return "construct";
    case "ConstructorFrom": return entity ? "constructFromEntity" : "constructFromLite";
    case "Delete": return entity ? "deleteEntity" : "deleteLite";
    case "ConstructorFromMany":
      // `plan` sends this kind to `bulkPlan` before a single route is asked for.
      throw new CliError(`internal: ${op.key} constructs from many records and has no single-record route`, ExitCode.Unexpected);
  }
}

async function plan(ctx: Ctx, md: Metadata, input: InputReader): Promise<Plan | BulkPlan> {
  const isKey = ctx.args.kind === "operation-key";
  const command = String(ctx.args.command);
  const noun = isKey ? undefined : ctx.args.positionals[0];
  const positionals = isKey ? ctx.args.positionals : ctx.args.positionals.slice(1);
  if (!isKey && noun === undefined) {
    throw new UsageError(`'${command}' needs a type: signum ${command} <Type> [id]`, {
      hint: "Run `signum operations` to see the operations and the types they run on.",
    });
  }
  // Before anything is read: a second reader of stdin must be refused, not fail to parse the first's input.
  assertOneStdin(["lite", "id", "f", "filename", "setters-json"].flatMap((f) => optAll(ctx, f).map((v) => [f, v] as const)));
  const document = await readDocument(ctx, md, input);
  const targets = await targetsOf(ctx, input, noun, positionals);
  if (document !== undefined) adoptDocumentTarget(document, targets, loadHandles(ctx.io.env, ctx.target));
  // A key alone names no type; for a constructor the noun or the key's only type does (AC-44.1).
  const op = isKey
    ? resolveKey(md, command, targets[0]?.type)
    : resolveVerbNoun(md, command, noun as string);
  assertTargetsOfType(op, targets);
  if (document !== undefined && cleanName(document.edited.Type).toLowerCase() !== cleanName(op.type.name).toLowerCase()) {
    throw new UsageError(`${document.source} is a ${document.edited.Type}, not a ${op.type.name}`);
  }
  if (isBulkRequest(ctx, targets.length) || op.info.kind === "ConstructorFromMany") {
    if (document !== undefined) {
      throw new UsageError("-f is one record's document; over many records, set values with --edit or --setters-json");
    }
    if (flag(ctx, "progress")) {
      throw new UsageError("--progress is for one record; over many records each outcome is shown as it arrives", {
        hint: "Drop --progress: a bulk operation already reports record by record.",
      });
    }
    const settersSource = opt(ctx, "setters-json");
    return bulkPlan(ctx, op, targets, settersSource !== undefined ? await input.read("setters-json", settersSource) : undefined);
  }

  const target = targets[0];
  let route = routeOf(op, target !== undefined);
  const edits = parseEdits(ctx);
  validateSingle(op, target, route, edits, document);
  if (flag(ctx, "progress")) route = progressRoute(op, route, edits.length > 0 || document !== undefined);
  return { op, target, route, args: argsOf(ctx), edits, document };
}

/**
 * `-f` / `--filename`: an entity document from a file, `@file` or `-` (#120). It may be the bare
 * entity, as `get -o json` writes it, or a pack `{entity, canExecute}`, as an operation writes its
 * result — so a constructor's output can be piped into the Save that stores it.
 */
async function readDocument(ctx: Ctx, md: Metadata, input: InputReader): Promise<EntityDocument | undefined> {
  const given = [...optAll(ctx, "f").map((v) => ["f", v] as const), ...optAll(ctx, "filename").map((v) => ["filename", v] as const)];
  if (given.length === 0) return undefined;
  if (given.length > 1) throw new UsageError("-f takes one document");
  const [flagName, written] = given[0] as readonly [string, string];
  const source = written === "-" ? `-${flagName.length === 1 ? "" : "-"}${flagName} - (stdin)` : `${flagName.length === 1 ? "-" : "--"}${flagName} ${written.replace(/^@/, "")}`;
  const text = await input.read(flagName, written, { bare: "path" });
  let parsed: unknown;
  try {
    parsed = parseLossless(text);
  } catch (err) {
    throw new UsageError(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const entity = typeof o["Type"] !== "string" && o["entity"] !== null && typeof o["entity"] === "object" ? o["entity"] : parsed;
  if (entity === null || typeof entity !== "object" || typeof (entity as Record<string, unknown>)["Type"] !== "string") {
    throw new UsageError(`${source} is not an entity: it needs a "Type"`, { hint: "Write it with `signum get <Type;id> -o json`, then edit it." });
  }
  return { edited: asEntity(entity), source, value: documentValue(md, loadHandles(ctx.io.env, ctx.target)) };
}

/** The record a document names, by its `id`, is the target — and must agree with one named as well. */
function adoptDocumentTarget(doc: EntityDocument, targets: OperationTarget[], handles: Readonly<Record<string, string>>): void {
  const id = doc.edited.id;
  if (id === undefined || id === null || doc.edited.isNew === true) {
    if (targets.length > 0) throw new UsageError(`${doc.source} is a new record, so it takes no record to run on`);
    return;
  }
  const written = String(id);
  // `get` writes the id as a handle when it pseudonymizes; it resolves locally like any other.
  const fromDoc = parseTarget(isHandle(written) ? written : `${cleanName(doc.edited.Type)};${written}`, undefined, handles);
  const named = targets[0];
  if (named === undefined) {
    targets.push(fromDoc);
    return;
  }
  if (targets.length > 1 || recordKey(named.type, named.id) !== recordKey(fromDoc.type, fromDoc.id)) {
    throw new UsageError(`${doc.source} is ${fromDoc.shown}, but the command names ${named.shown}`, {
      hint: "Name the record once: the document's id is enough.",
    });
  }
}

/**
 * How a value from the caller's document goes on the wire. A handle resolves locally to the Lite it
 * stands for (AC-53.2); a `Type;id` string where the record holds a Lite, or names an entity type,
 * is that Lite. A string shaped like the surrogate pseudonymization gives that member is refused: it
 * is a pseudonym the caller copied, not a value, and sending it would write it into the record.
 * Values inside a new object are judged the same way, each under its own member name.
 */
function documentValue(md: Metadata, handles: Readonly<Record<string, string>>): DocumentValue {
  const one = (v: unknown, key: string, path: string, current: unknown): unknown => {
    if (typeof v === "string") {
      if (isHandle(v)) {
        const real = resolveHandle(v, handles);
        const lite = parseLiteKey(real);
        return lite !== undefined ? liteJson({ type: lite.type, id: lite.id, shown: v }) : real;
      }
      if (key !== "" && looksLikeSurrogate(v, key)) {
        throw new UsageError(`${path}: '${v}' is a pseudonym, not a value`, {
          hint: "The document was written pseudonymized. Leave a value you did not change exactly as it was\n" +
            "shown, and write a changed one in full; or read the record with --pseudonymize off.",
        });
      }
      const lite = parseLiteKey(v);
      const isLiteSlot = current !== null && typeof current === "object" && typeof (current as Record<string, unknown>)["EntityType"] === "string";
      if (lite !== undefined && (isLiteSlot || findType(md, lite.type)?.kind === "Entity")) {
        return liteJson({ type: lite.type, id: lite.id, shown: v });
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => one(x, key, `${path}.${i}`, undefined));
    if (v !== null && typeof v === "object" && !(v instanceof JsonNumber)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).map(([k, x]) =>
        [k, k === "Type" || k === "EntityType" || k === "rowId" ? x : one(x, k, `${path}.${k}`, undefined)]));
    }
    return v;
  };
  return (v, path, current) => one(v, path.split(".").filter((s) => !/^\d+$/.test(s)).pop() ?? "", path, current);
}

/**
 * `--progress`: the same execute, sent to `executeLiteWithProgress`, which streams the server's
 * `ProgressProxy` as it works (`OperationController.cs:82-95`, AC-45.2). The server retrieves the
 * record itself, so it takes a Lite: an edit would be dropped, and is refused. Which operations
 * report progress is the application's choice — the web client opts in per operation — so it is the
 * caller's flag here; one that reports none simply finishes.
 */
function progressRoute(op: ResolvedOperation, route: Route, edited: boolean): Route {
  if (route !== "executeLite" && route !== "executeEntity") {
    throw new UsageError(`--progress is for an operation that executes on a record; ${op.key} does not`);
  }
  if (edited) {
    throw new UsageError("--progress sends the record as a Lite, so an --edit or -f would be discarded", {
      hint: "Save the edit first, then run the operation with --progress.",
    });
  }
  return "executeLiteWithProgress";
}

/** Every record must be of the operation's type; each is then spelled as the metadata spells it. */
function assertTargetsOfType(op: ResolvedOperation, targets: OperationTarget[]): void {
  for (const t of targets) {
    if (cleanName(t.type).toLowerCase() !== cleanName(op.type.name).toLowerCase()) {
      throw new UsageError(`${t.shown} is not a ${op.type.name}`, { hint: `${op.key} runs on ${op.type.name}.` });
    }
    t.type = op.type.name;
  }
}

/** A record where the route needs one and none where it takes none; edits only where they are saved. */
function validateSingle(
  op: ResolvedOperation, target: OperationTarget | undefined, route: Route, edits: readonly Edit[], document: EntityDocument | undefined,
): void {
  const sends = ROUTES[route].sends;
  if (document !== undefined && target === undefined && sends !== "new") {
    throw new UsageError(`${document.source} is a new record, and ${op.key} cannot create one`, {
      hint: "Create it with an operation that may run on a new record, such as the type's Save.",
    });
  }
  if (document !== undefined && !ROUTES[route].takesEdits) {
    throw new UsageError(`${op.key} does not save the record it is given, so ${document.source} would be discarded`, {
      hint: "Save a document with an operation that takes the entity, such as its Save.",
    });
  }
  if (sends === "type" && target !== undefined) {
    throw new UsageError(`${op.key} constructs from nothing, so it takes no record`, {
      hint: `signum ${kebab(op.info.verb)} ${kebab(op.type.name)}`,
    });
  }
  if (target === undefined && (sends === "entity" || sends === "lite")) {
    throw new UsageError(`${op.key} needs the record to run on`, {
      hint: `signum ${kebab(op.info.verb)} ${kebab(op.type.name)} <id>   or   signum ${op.key} --lite "${op.type.name};<id>"`,
    });
  }
  if (edits.length === 0) return;
  // An edited graph must never go out as a Lite, and an edit before a delete or a construct-from
  // would be applied to something that is then thrown away: both are dropped without an error (#114).
  if (!ROUTES[route].takesEdits) {
    throw new UsageError(`${op.key} does not save the record it is given, so --edit would be discarded`, {
      hint: "Edit with an operation that takes the entity, such as its Save.",
    });
  }
  // A new entity is built from top-level members only: there is no nested object to step into yet.
  if (sends === "new" && edits.some((e) => e.path.length !== 1)) {
    throw new UsageError("a new record takes top-level members only, e.g. --edit Name=Acme");
  }
}

function operationPath(p: Plan): string {
  return `api/operation/${ROUTES[p.route].endpoint}/${encodeURIComponent(p.op.key)}`;
}

/**
 * A record that does not exist yet, as the web UI's "new" builds one: `isNew`, and only the members
 * the caller set. Every other member keeps the server's own default, because the server constructs
 * the instance before it reads the JSON (`EntityJsonConverter`). Member names come from reflection and
 * go on the wire camelCased, as Signum writes them (`RASCI` → `rASCI`).
 */
function newEntity(p: Plan): EntityJson {
  const members = new Map(p.op.type.members.map((m) => [m.name.toLowerCase(), m.name]));
  const e: Record<string, unknown> = p.document !== undefined
    ? newFromDocument(p.document)
    : { Type: cleanName(p.op.type.name), isNew: true, modified: true };
  for (const edit of p.edits) {
    const written = String(edit.path[0]);
    const name = members.get(written.toLowerCase());
    if (name === undefined || name.includes("/") || name === "Id") {
      throw new UsageError(`${p.op.type.name} has no member '${written}' a new record can set`, {
        hint: `Run \`signum explain ${p.op.type.name}\` to see its members.`,
      });
    }
    e[name.charAt(0).toLowerCase() + name.slice(1)] = edit.value;
  }
  return e as EntityJson;
}

/**
 * A new record from the caller's document (`-f`, #120): every value translated as for an edit, the
 * identity and concurrency members dropped, and every entity in it marked, since all of it is new.
 * A pseudonymized document is refused outright: with no stored record to compare against, its
 * surrogates cannot be told from values — a number least of all.
 */
function newFromDocument(doc: EntityDocument): Record<string, unknown> {
  const toStr = doc.edited.toStr;
  if (typeof toStr === "string" && looksLikeSurrogate(toStr, "toStr")) {
    throw new UsageError(`${doc.source} was written pseudonymized, so its values cannot be told from pseudonyms`, {
      hint: "A new record has nothing stored to compare with. Write the real values, or produce the\n" +
        "document with --pseudonymize off (e.g. signum create order --pseudonymize off -o json).",
    });
  }
  const { id: _id, ticks: _ticks, toStr: _toStr, ...rest } = doc.edited as Record<string, unknown>;
  const e = doc.value(rest, "", undefined) as Record<string, unknown>;
  return markAllModified({ ...e, Type: doc.edited.Type, isNew: true });
}

/** `--explain`: the exact request, sending nothing (REQ-053, AC-42.7). */
function explainPlan(ctx: Ctx, target: Target, p: Plan): ExitCode {
  const applied = [...(p.document !== undefined ? [`the changes in ${p.document.source}`] : []), ...p.edits.map((e) => e.written)];
  const fetched = (t: OperationTarget | undefined): string =>
    `${t?.shown}, as fetched from api/entity when sent` + (applied.length > 0 ? `, with ${applied.join(", ")} applied` : "");
  const sends = ROUTES[p.route].sends;
  // A new record from a document is described, not shown: shown, its handles would be resolved.
  const body: Record<string, unknown> =
    sends === "type" ? { Type: cleanName(p.op.type.name), args: p.args }
    : sends === "new" && p.document !== undefined ? { entity: `a new ${p.op.type.name} from ${p.document.source}${p.edits.length > 0 ? `, with ${p.edits.map((e) => e.written).join(", ")}` : ""}`, args: p.args }
    : sends === "new" ? { entity: newEntity(p), args: p.args }
    : sends === "lite" ? { lite: shownTarget(p.target as OperationTarget), args: p.args }
    : { entity: fetched(p.target), args: p.args };
  renderDocument({ method: "POST", url: `${target.url}/${operationPath(p)}`, body },
    { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
  return ExitCode.Ok;
}

/**
 * `--dry-run`: would this login be permitted, and why not (REQ-043). Never an `api/operation/*` call.
 *
 * For a record, `canExecute` from its entity pack maps each operation key to null (permitted) or a
 * reason; a key ABSENT was withheld for this login (`OperationLogic.cs:456`) — not permitted, no reason
 * given, never "unknown operation". A new record is asked the same of `api/entityPackEntity`, which
 * builds a pack for an entity without saving it. A constructor has no record to ask about: reflection
 * lists it only for a login that may run it, which is all the server will say before it runs.
 */
async function dryRun(ctx: Ctx, target: Target, p: Plan): Promise<ExitCode> {
  let canExecute: Record<string, unknown> | undefined;
  if (p.route === "saveNew") {
    const payload = serializeEntity(newEntity(p));
    const res = await target.http.request<unknown>({ method: "POST", path: "api/entityPackEntity", rawBody: payload.json, lossless: true });
    canExecute = (((res.body ?? {}) as Record<string, unknown>)["canExecute"] ?? {}) as Record<string, unknown>;
  } else if (p.target !== undefined) {
    canExecute = await packCanExecute(target, p.target);
  }

  const shown = p.target?.shown ?? `a new ${p.op.type.name}`;
  const { ok: permitted, reason } = canExecute === undefined ? { ok: true, reason: undefined } : permission(canExecute, p.op.key);

  const note = canExecute === undefined
    ? "A constructor has no record to check: it is listed only for a login that may run it, and the server checks the rest when it runs."
    : "A dry run checks permission, not success: a permitted operation can still fail when run.";
  const verdict: Record<string, unknown> = {
    operation: p.op.key, target: shown, permitted, ...(reason !== undefined ? { reason } : {}), note,
  };
  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(verdict, { format: ctx.format, write: ctx.io.out });
  } else {
    ctx.io.out(permitted ? `${p.op.key} on ${shown}: permitted\n` : `${p.op.key} on ${shown}: not permitted — ${reason}\n`);
    ctx.io.err(`note: ${note.charAt(0).toLowerCase()}${note.slice(1)}\n`);
  }
  // Scripts gate on it (AC-43.4): 0 would be permitted, 4 would not.
  return permitted ? ExitCode.Ok : ExitCode.NotAuthorized;
}

/** The fetched record with the edits applied, as its `serializeEntity` payload. */
async function fetchedPayload(ctx: Ctx, target: Target, p: Plan): Promise<string> {
  const t = p.target as OperationTarget;
  // Fetched now, so its `ticks` is the one the server last issued and travels back verbatim as a
  // string: a stale one is the server's concurrency check, never something to refresh away (#117).
  const entity: EntityJson = await fetchEntity(target.http, cleanName(t.type), t.id);
  let changed = false;
  if (p.document !== undefined) {
    // The document was written from the record at ITS ticks. If the record changed since, applying
    // the document would silently undo someone else's change, so it is the conflict it is (#117).
    const written = p.document.edited.ticks;
    if (written !== undefined && String(written) !== String(entity.ticks)) {
      throw new ConcurrencyError(`${t.shown} changed since ${p.document.source} was written; nothing was sent`, {
        hint: "Read it again, redo the change on the fresh copy, and save that.",
      });
    }
    // Compared with the record as `get` would show it now, under the same policy: what the caller
    // left alone is recognised as alone whatever surrogate it carries.
    const shown = pseudonymizeDocument(entity, ctx.privacy).value;
    changed = applyDocument(entity, shown, p.document.edited, p.document.value).length > 0;
  }
  for (const e of p.edits) changed = setMember(entity, wirePath(entity, e.path), e.value) || changed;
  if ((p.edits.length > 0 || p.document !== undefined) && !changed) {
    // Saving nothing is not a save (AC-32.4): say so and send nothing.
    throw new CliError(p.document !== undefined
      ? `${p.document.source} changes nothing in ${t.shown}; nothing was sent`
      : "every --edit already holds that value; nothing was sent", ExitCode.Usage);
  }
  return serializeEntity(entity).json;
}

/** The request body for each route. */
async function body(ctx: Ctx, target: Target, p: Plan): Promise<string> {
  const args = JSON.stringify(p.args);
  switch (ROUTES[p.route].sends) {
    case "type":
      // `ConstructOperationRequest.Type` is required: there is no entity to infer it from (AC-44.1).
      return JSON.stringify({ Type: cleanName(p.op.type.name), args: p.args });
    case "new":
      return `{"entity":${serializeEntity(newEntity(p)).json},"args":${args}}`;
    case "lite":
      return JSON.stringify({ lite: liteJson(p.target as OperationTarget), args: p.args });
    case "entity":
      return `{"entity":${await fetchedPayload(ctx, target, p)},"args":${args}}`;
  }
}

/** The only place a mutation leaves the CLI. */
async function send(ctx: Ctx, target: Target, p: Plan, permit: MutationPermit): Promise<unknown> {
  assertPermit(permit);
  if (p.route === "executeLiteWithProgress") return await sendWithProgress(ctx, target, p);
  if (p.route === "deleteLite") {
    // The Lite route retrieves the record server-side; a missing one would be its error, so it is
    // asked first, and a record that is not there is a clean not-found (#118).
    const t = p.target as OperationTarget;
    const exists = await target.http.request<unknown>({
      method: "GET", path: `api/exists/${encodeURIComponent(cleanName(t.type))}/${encodeURIComponent(t.id)}`,
    });
    if (!(exists.body === true || exists.body === "true")) throw new NotFoundError(`${t.shown} not found`);
  }
  const res = await target.http.request<unknown>({
    method: "POST", path: operationPath(p), rawBody: await body(ctx, target, p), lossless: true,
  });
  return res.body;
}

/** `ProgressStep<EntityPackTS>` (`OperationController.cs:286-297`), one per line. */
interface ProgressStep {
  currentTask?: string | null;
  min?: unknown;
  max?: unknown;
  position?: unknown;
  isFinished?: boolean;
  result?: unknown;
  error?: unknown;
}

/**
 * How progress is shown (AC-45.2). Under `-o ndjson` each step is a line on stdout, passed through
 * with its free text judged like any other member, since `currentTask` is the server's own words and
 * can name a record. At a terminal it is one line on stderr, rewritten in place. Anywhere else it is
 * not shown: a script waiting on the result has no use for a spinner in its logs.
 */
function progressDisplay(ctx: Ctx): { step(s: ProgressStep): void; done(): void } {
  const shown = (s: ProgressStep): Record<string, unknown> => {
    const { value } = pseudonymizeDocument({
      ...(s.currentTask !== undefined && s.currentTask !== null ? { currentTask: s.currentTask } : {}),
      min: s.min ?? null, max: s.max ?? null, position: s.position ?? null,
    }, ctx.privacy);
    return value as Record<string, unknown>;
  };
  if (ctx.format === "ndjson") {
    const write = ctx.openData(DATA_KIND);
    return { step: (s) => write(JSON.stringify(shown(s)) + "\n"), done: () => {} };
  }
  if (!ctx.io.stdoutIsTty) return { step: () => {}, done: () => {} };
  let drawn = false;
  return {
    step(s) {
      const v = shown(s);
      const count = v["max"] !== null && v["position"] !== null ? `[${String(v["position"])}/${String(v["max"])}] ` : "";
      ctx.io.err(`\r\x1b[2K${count}${typeof v["currentTask"] === "string" ? v["currentTask"] : "working…"}`);
      drawn = true;
    },
    done() {
      if (drawn) ctx.io.err("\n");
    },
  };
}

/**
 * Execute one record with the server's progress streamed back (AC-45.2). The last step carries the
 * result or the error; a stream that ends without one ended before the operation did. Ctrl-C stops
 * the request — the server's `ProgressProxy` is cancelled with it — and is reported, not ignored.
 */
async function sendWithProgress(ctx: Ctx, target: Target, p: Plan): Promise<unknown> {
  const display = progressDisplay(ctx);
  let last: ProgressStep | undefined;
  try {
    await interruptible(ctx, (signal) => target.http.requestLines({
      method: "POST", path: operationPath(p), rawBody: JSON.stringify({ lite: liteJson(p.target as OperationTarget), args: p.args }),
      lossless: true, signal,
    }, (line) => {
      let s: ProgressStep;
      try {
        s = parseLossless(line) as ProgressStep;
      } catch {
        return; // a step that cannot be read is a lost progress update, not a result
      }
      if (s.isFinished === true) last = s;
      else display.step(s);
    }));
  } catch (err) {
    if (err instanceof InterruptedError) {
      throw new InterruptedError(`interrupted while ${p.op.key} was running`, {
        hint: "The server cancels a progress operation when the caller goes, but it may already have\n" +
          `finished. Check the record before running it again: signum get ${p.target?.shown ?? ""}`.trimEnd(),
      });
    }
    throw err;
  } finally {
    display.done();
  }
  if (last === undefined) {
    throw new TransportError(`the progress stream ended before ${p.op.key} finished`, {
      hint: "The server may still have completed it. Check the record before running it again.",
    });
  }
  if (last.error !== undefined && last.error !== null) throw target.http.errorFromBody(last.error);
  return last.result;
}

/** What the result is, said plainly: a constructed entity is not a stored one (#118). */
function describeResult(ctx: Ctx, p: Plan, pack: unknown): void {
  if (ROUTES[p.route].constructs && !p.op.info.resultIsSaved) {
    ctx.io.err(`note: ${p.op.key} returned a new ${p.op.type.name} that is NOT saved; nothing was stored.\n` +
      `To store it, pipe it into the Save: … --pseudonymize off -o json | signum save ${kebab(p.op.type.name)} -f - --yes\n`);
  }
  if (p.route === "saveNew") {
    const entity = ((pack ?? {}) as Record<string, unknown>)["entity"];
    if (entity === null || entity === undefined) return;
    ctx.io.err(`note: created a new ${p.op.type.name}; its id is in entity.id.\n`);
  }
}

export async function runOperation(ctx: Ctx): Promise<ExitCode> {
  assertOperationFlags(ctx);

  const explain = ctx.args.flags.explain;
  const dry = flag(ctx, "dry-run");
  // The result is a record, so it is data (AC-51.1); a preview and a dry run emit none.
  if (!explain && !dry) ctx.openData(DATA_KIND);

  const target = resolveTarget(ctx, { requireAuth: !explain });
  const md = await loadMetadata({
    url: target.url, http: target.http, offline: ctx.args.flags.offline,
    env: ctx.io.env, warn: (l) => ctx.io.err(l),
  });
  const planned = await plan(ctx, md, inputReader(ctx.io));
  if ("many" in planned) return await runBulk(ctx, target, planned, { explain, dry });
  const p = planned;

  if (explain && !dry) return explainPlan(ctx, target, p);
  if (dry) {
    // Composes with --explain (AC-43.6): the request it would send, and the verdict, sending nothing.
    if (explain) explainPlan(ctx, target, p);
    return await dryRun(ctx, target, p);
  }

  const isDelete = ROUTES[p.route].destructive;
  const realTarget = p.target !== undefined ? `${cleanName(p.target.type)};${p.target.id}` : `new ${cleanName(p.op.type.name)}`;
  const permit = await confirmMutation(ctx, {
    operation: p.op.key,
    target: p.target?.shown ?? realTarget,
    realTarget,
    url: target.url,
    destructive: isDelete,
  });

  let pack: unknown;
  try {
    pack = await send(ctx, target, p, permit);
  } catch (err) {
    const viaHandle = p.target !== undefined && p.target.shown !== realTarget;
    const failure = explainSendError(err, viaHandle ? `${p.target?.shown} not found` : undefined);
    recordMutation(ctx, permit, failureOf(failure));
    throw failure;
  }
  recordMutation(ctx, permit, { ok: true });

  if (isDelete) {
    // Delete answers with nothing; the record it named is gone, and that is the whole result.
    // Named as Type;id, or by the handle the caller used — never the id behind one.
    const gone = p.target !== undefined && isHandle(p.target.shown) ? p.target.shown : realTarget;
    renderDocument({ deleted: gone }, { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }
  if ((pack === null || pack === undefined || pack === "") && ROUTES[p.route].constructs) {
    // A constructor may decline and return nothing (AC-44.5): that is an answer, not a crash.
    ctx.io.err(`note: ${p.op.key} declined to construct anything; nothing was returned.\n`);
    return ExitCode.Ok;
  }
  describeResult(ctx, p, pack);
  renderPack(ctx, pack);
  return ExitCode.Ok;
}
