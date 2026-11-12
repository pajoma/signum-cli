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
 * More than one record makes it a bulk operation (#119): one request, one outcome per record.
 */

import type { Ctx } from "../core/ctx.ts";
import { flag, optAll } from "../core/ctx.ts";
import { CliError, ExitCode, NotAuthorizedError, NotFoundError, UsageError } from "../core/errors.ts";
import { asEntity, fetchEntity, serializeEntity, setMember, type EntityJson, type MemberPath } from "../core/entity.ts";
import { assertPermit, confirmMutation, recordMutation, type MutationPermit } from "../core/guard.ts";
import { loadHandles, persistHandles } from "../core/handles.ts";
import { JsonNumber } from "../core/json.ts";
import { loadMetadata, type Metadata } from "../core/metadata.ts";
import { encodeArgs, kebab, resolveKey, resolveVerbNoun, type ArgValue, type ResolvedOperation } from "../core/operations.ts";
import { renderDataDocument, renderDocument } from "../core/output.ts";
import { disclosure, pseudonymizeDocument } from "../core/privacy.ts";
import { isHandle, resolveHandle } from "../core/reidentify.ts";
import { resolveTarget, type Target } from "../core/target.ts";
import { nearest, parseLiteKey } from "../core/text.ts";

/** What an operation command accepts besides the global flags. */
export const OPERATION_FLAGS = [
  "arg", "arg-string", "arg-lite", "arg-json", "allow-custom-arg",
  "lite", "id", "edit", "f", "filename", "yes", "y", "dry-run",
] as const;

const DATA_KIND = "operation result";

/** The record an operation runs on, as the caller named it and as it really is. */
interface OperationTarget {
  type: string;
  id: string;
  /** As written: a handle stays a handle in everything shown to a caller. */
  shown: string;
}

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
 * The records an operation runs on: positionals after the noun, repeated `--lite`, or repeated `--id`
 * — one of the three, so a list is never half of one kind and half of another. More than one record
 * makes it a bulk operation (#119).
 */
function targetsOf(ctx: Ctx, noun: string | undefined, positionals: readonly string[]): OperationTarget[] {
  const handles = loadHandles(ctx.io.env);
  const sources = [
    { from: "position", values: [...positionals] },
    { from: "--lite", values: optAll(ctx, "lite") },
    { from: "--id", values: optAll(ctx, "id") },
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

/** `--edit Member.Path=value`: the path addresses members, `entity`, and list indices (AC-31.7). */
function parseEdits(ctx: Ctx): Array<{ path: MemberPath; value: ArgValue; written: string }> {
  return optAll(ctx, "edit").map((written) => {
    const eq = written.indexOf("=");
    if (eq <= 0) throw new UsageError(`--edit '${written}' needs a member and a value`, { hint: "--edit Name=Acme  or  --edit Address.City=Berlin" });
    const path = written.slice(0, eq).split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const raw = written.slice(eq + 1);
    // The same scalar inference as --arg, and no more: an edit sets one value.
    const value: ArgValue = raw === "null" ? null
      : raw === "true" ? true
      : raw === "false" ? false
      : /^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw) ? new JsonNumber("number", raw)
      : raw;
    return { path, value, written };
  });
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
  | "executeEntity" | "executeLite" | "saveNew"
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
  edits: ReturnType<typeof parseEdits>;
}

/** An operation over many records (#119): one request, one outcome per record. */
interface BulkPlan {
  many: true;
  op: ResolvedOperation;
  targets: OperationTarget[];
  route: "executeMultiple" | "deleteMultiple" | "constructFromMultiple" | "constructFromMany";
  args: ArgValue[] | null;
}

function cleanName(typeName: string): string {
  return typeName.replace(/Entity$/, "");
}

/** `type;id`, case-folded: how a record is recognised again, in the targets and in the server's answer. */
function recordKey(type: string, id: string): string {
  return `${cleanName(type).toLowerCase()};${id}`;
}

function liteJson(t: OperationTarget): Record<string, unknown> {
  return { EntityType: cleanName(t.type), id: /^\d+$/.test(t.id) ? new JsonNumber("identifier", t.id) : t.id };
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

function plan(ctx: Ctx, md: Metadata): Plan | BulkPlan {
  const isKey = ctx.args.kind === "operation-key";
  const command = String(ctx.args.command);
  const noun = isKey ? undefined : ctx.args.positionals[0];
  const positionals = isKey ? ctx.args.positionals : ctx.args.positionals.slice(1);
  if (!isKey && noun === undefined) {
    throw new UsageError(`'${command}' needs a type: signum ${command} <Type> [id]`, {
      hint: "Run `signum operations` to see the operations and the types they run on.",
    });
  }
  if (optAll(ctx, "f").length > 0 || optAll(ctx, "filename").length > 0) {
    throw new UsageError("-f is not supported yet: an entity edited in a file carries no `modified` flags, and the server discards unmarked changes", {
      hint: "Use --edit Member=value, which marks what changed (AC-31.7). Input from files is #120.",
    });
  }

  const targets = targetsOf(ctx, noun, positionals);
  // A key alone names no type; for a constructor the noun or the key's only type does (AC-44.1).
  const op = isKey
    ? resolveKey(md, command, targets[0]?.type)
    : resolveVerbNoun(md, command, noun as string);
  assertTargetsOfType(op, targets);
  if (targets.length > 1 || op.info.kind === "ConstructorFromMany") return bulkPlan(ctx, op, targets);

  const target = targets[0];
  const route = routeOf(op, target !== undefined);
  const edits = parseEdits(ctx);
  validateSingle(op, target, route, edits);
  return { op, target, route, args: argsOf(ctx), edits };
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

/** The positional args, in the order typed (AC-42.1). */
function argsOf(ctx: Ctx): ArgValue[] | null {
  return encodeArgs(ctx.args.sequence, {
    handles: loadHandles(ctx.io.env),
    allowCustomObjects: flag(ctx, "allow-custom-arg"),
    warn: (line) => ctx.io.err(line),
  });
}

/** A record where the route needs one and none where it takes none; edits only where they are saved. */
function validateSingle(op: ResolvedOperation, target: OperationTarget | undefined, route: Route, edits: ReturnType<typeof parseEdits>): void {
  const sends = ROUTES[route].sends;
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

function bulkPlan(ctx: Ctx, op: ResolvedOperation, targets: OperationTarget[]): BulkPlan {
  const kind = op.info.kind ?? "Execute";
  if (targets.length === 0) {
    throw new UsageError(`${op.key} runs on records; name them`, {
      hint: `signum ${op.key} --lite "${op.type.name};1" --lite "${op.type.name};2"`,
    });
  }
  if (optAll(ctx, "edit").length > 0) {
    // The multi endpoints take property setters, not entities (AC-45.4); an --edit has nowhere to go.
    throw new UsageError("--edit is for one record; over many records it would be discarded", {
      hint: "Run the operation once per record, or wait for property setters over many records.",
    });
  }
  const route = kind === "Execute" ? "executeMultiple"
    : kind === "Delete" ? "deleteMultiple"
    : kind === "ConstructorFrom" ? "constructFromMultiple"
    : kind === "ConstructorFromMany" ? "constructFromMany"
    : undefined;
  if (route === undefined) {
    throw new UsageError(`${op.key} is a constructor, which runs on no record`, { hint: `signum ${kebab(op.info.verb)} ${kebab(op.type.name)}` });
  }
  return { many: true, op, targets, route, args: argsOf(ctx) };
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
  const e: Record<string, unknown> = { Type: cleanName(p.op.type.name), isNew: true, modified: true };
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

/** What the target looks like in the request, with a handle in place of the id it stands for. */
function shownTarget(t: OperationTarget): Record<string, unknown> {
  return { ...liteJson(t), ...(isHandle(t.shown) ? { id: t.shown } : {}) };
}

/** `--explain`: the exact request, sending nothing (REQ-053, AC-42.7). */
function explainPlan(ctx: Ctx, target: Target, p: Plan): ExitCode {
  const fetched = (t: OperationTarget | undefined): string =>
    `${t?.shown}, as fetched from api/entity when sent` +
    (p.edits.length > 0 ? `, with ${p.edits.map((e) => e.written).join(", ")} applied` : "");
  const sends = ROUTES[p.route].sends;
  const body: Record<string, unknown> =
    sends === "type" ? { Type: cleanName(p.op.type.name), args: p.args }
    : sends === "new" ? { entity: newEntity(p), args: p.args }
    : sends === "lite" ? { lite: shownTarget(p.target as OperationTarget), args: p.args }
    : { entity: fetched(p.target), args: p.args };
  renderDocument({ method: "POST", url: `${target.url}/${operationPath(p)}`, body },
    { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
  return ExitCode.Ok;
}

/** Whether `canExecute` permits `key`, and the server's reason when not. */
function permission(canExecute: Record<string, unknown>, key: string): { ok: boolean; reason?: string } {
  // A key ABSENT was withheld for this login (`OperationLogic.cs:456`): not permitted, never unknown (#112).
  if (!Object.hasOwn(canExecute, key)) return { ok: false, reason: "not permitted for this login; the server gives no reason" };
  const r = canExecute[key];
  return r === null || r === undefined || r === "" ? { ok: true } : { ok: false, reason: String(r) };
}

/** The `canExecute` of a stored record's entity pack. A read: nothing is invoked. */
async function packCanExecute(target: Target, t: OperationTarget): Promise<Record<string, unknown>> {
  const res = await target.http.request<unknown>({
    method: "GET",
    path: `api/entityPack/${encodeURIComponent(cleanName(t.type))}/${encodeURIComponent(t.id)}`,
    lossless: true,
  });
  return (((res.body ?? {}) as Record<string, unknown>)["canExecute"] ?? {}) as Record<string, unknown>;
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
async function fetchedPayload(target: Target, p: Plan): Promise<string> {
  const t = p.target as OperationTarget;
  // Fetched now, so its `ticks` is the one the server last issued and travels back verbatim as a
  // string: a stale one is the server's concurrency check, never something to refresh away (#117).
  const entity: EntityJson = await fetchEntity(target.http, cleanName(t.type), t.id);
  let changed = false;
  for (const e of p.edits) changed = setMember(entity, wirePath(entity, e.path), e.value) || changed;
  if (p.edits.length > 0 && !changed) {
    // Saving nothing is not a save (AC-32.4): say so and send nothing.
    throw new CliError("every --edit already holds that value; nothing was sent", ExitCode.Usage);
  }
  return serializeEntity(entity).json;
}

/** The request body for each route. */
async function body(target: Target, p: Plan): Promise<string> {
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
      return `{"entity":${await fetchedPayload(target, p)},"args":${args}}`;
  }
}

/** The only place a mutation leaves the CLI. */
async function send(target: Target, p: Plan, permit: MutationPermit): Promise<unknown> {
  assertPermit(permit);
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
    method: "POST", path: operationPath(p), rawBody: await body(target, p), lossless: true,
  });
  return res.body;
}

/** `EntityPackTS` → the entity, pseudonymized like `get`, beside its new `canExecute`. */
function renderPack(ctx: Ctx, pack: unknown): void {
  const o = (pack ?? {}) as Record<string, unknown>;
  const entity = o["entity"] !== undefined && o["entity"] !== null ? asEntity(o["entity"]) : null;
  const { value, pseudonymized, handleDetails } = pseudonymizeDocument(entity, ctx.privacy);
  persistHandles(ctx, handleDetails); // before emitting — see the note in query.ts
  renderDataDocument({ entity: value, canExecute: o["canExecute"] ?? {} }, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.openData(DATA_KIND),
  });
  const note = disclosure(ctx.privacy, pseudonymized);
  if (note !== "") ctx.io.err("\n" + note);
}

/** What the result is, said plainly: a constructed entity is not a stored one (#118). */
function describeResult(ctx: Ctx, p: Plan, pack: unknown): void {
  if (ROUTES[p.route].constructs && !p.op.info.resultIsSaved) {
    ctx.io.err(`note: ${p.op.key} returned a new ${p.op.type.name} that is NOT saved; nothing was stored.\n` +
      "Saving it needs the entity as input, which is #120.\n");
  }
  if (p.route === "saveNew") {
    const entity = ((pack ?? {}) as Record<string, unknown>)["entity"];
    if (entity === null || entity === undefined) return;
    ctx.io.err(`note: created a new ${p.op.type.name}; its id is in entity.id.\n`);
  }
}

/**
 * A failed send, said in the CLI's terms. A 403 may mean the operation is hidden from the UI: the
 * server judges every call as if the UI made it (`OperationController.cs:137`), so such an operation
 * cannot be invoked over the API at all (AC-40.5). A not-found reached through a handle must not
 * spell out the id behind it, so it is replaced by `hiddenNotFound` when one is given (AC-53.2).
 */
function explainSendError(err: unknown, hiddenNotFound: string | undefined): unknown {
  if (err instanceof NotAuthorizedError) {
    return new NotAuthorizedError(`not permitted: ${err.message}`, {
      hint: "This login may not run it on this record, or the operation is hidden from the UI —\n" +
        "the API invokes only what the UI may (OperationController.cs:137). Check with --dry-run.",
    });
  }
  if (err instanceof NotFoundError && hiddenNotFound !== undefined) return new NotFoundError(hiddenNotFound);
  return err;
}

/** The audit outcome of a failure. */
function failureOf(err: unknown): { ok: false; error: string; exitCode: number } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    exitCode: err instanceof CliError ? err.exitCode : ExitCode.Unexpected,
  };
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
  const planned = plan(ctx, md);
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
    pack = await send(target, p, permit);
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

// ─── many records (#119) ───────────────────────────────────────────────────────

/** One record's outcome, as the multi endpoints stream it (`OperationController.OperationResult`). */
interface BulkOutcome {
  /** As the caller named it: a handle stays a handle. */
  target: string;
  ok: boolean;
  error?: string;
}

function bulkPath(p: BulkPlan): string {
  return `api/operation/${p.route}/${encodeURIComponent(p.op.key)}`;
}

/** `MultiOperationRequest`: the Lites, the args, and for constructFromMany the type when no Lite says it. */
function bulkBody(p: BulkPlan, lite: (t: OperationTarget) => Record<string, unknown>): Record<string, unknown> {
  return {
    lites: p.targets.map(lite),
    args: p.args,
    ...(p.route === "constructFromMany" ? { type: cleanName(p.op.type.name) } : {}),
  };
}

/**
 * The NDJSON the multi endpoints answer with: one `{entity, error}` line per record, in no promised
 * order. Matched back to the records by `Type;id`, so each outcome is reported under the name the
 * caller used. A record the stream never mentions is reported as failed — silence is not success.
 *
 * It never throws. By now the server has acted, and every record must still be audited and
 * reported, so a line that cannot be read (a stream cut off mid-line) leaves its record unmatched,
 * which is a failure that says why.
 */
function parseOutcomes(p: BulkPlan, text: string): BulkOutcome[] {
  const byKey = new Map(p.targets.map((t) => [recordKey(t.type, t.id), t]));
  const outcomes = new Map<string, BulkOutcome>();
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: { entity?: { EntityType?: string; id?: unknown }; error?: string | null };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      unreadable++;
      continue;
    }
    const key = recordKey(String(o.entity?.EntityType ?? ""), String(o.entity?.id ?? ""));
    const t = byKey.get(key);
    if (t === undefined) continue;
    outcomes.set(key, { target: t.shown, ok: o.error === null || o.error === undefined || o.error === "", ...(o.error ? { error: o.error } : {}) });
  }
  const missing = unreadable > 0
    ? "no readable outcome: the server's answer was cut off or malformed; check the record"
    : "no outcome reported by the server";
  return p.targets.map((t) => outcomes.get(recordKey(t.type, t.id)) ?? { target: t.shown, ok: false, error: missing });
}

/** 0 when every record succeeded, 10 when some did, 1 when none did (AC-45.3). */
function bulkExit(outcomes: readonly BulkOutcome[]): ExitCode {
  const failed = outcomes.filter((o) => !o.ok).length;
  if (failed === 0) return ExitCode.Ok;
  return failed === outcomes.length ? ExitCode.Unexpected : ExitCode.PartialFailure;
}

function renderOutcomes(ctx: Ctx, outcomes: readonly BulkOutcome[], verdictWord: { ok: string; failed: string }): void {
  if (ctx.format === "json") {
    renderDocument(outcomes, { format: "json", write: ctx.io.out });
  } else if (ctx.format === "ndjson") {
    for (const o of outcomes) ctx.io.out(JSON.stringify(o) + "\n");
  } else {
    for (const o of outcomes) ctx.io.out(o.ok ? `${verdictWord.ok}  ${o.target}\n` : `${verdictWord.failed}  ${o.target}: ${o.error}\n`);
  }
  const failed = outcomes.filter((o) => !o.ok).length;
  ctx.io.err(`${outcomes.length - failed} of ${outcomes.length} ${verdictWord.ok === "permitted" ? "permitted" : "succeeded"}` +
    (failed > 0 ? `; ${failed} ${verdictWord.ok === "permitted" ? "not permitted" : "failed"}` : "") + "\n");
}

/**
 * `--dry-run` over many records: each record's own `canExecute` from its entity pack (AC-45.5,
 * #119). `stateCanExecutes` answers for the SET as a whole, which is the blanket answer a per-record
 * dry run must not give. Reads only; no `api/operation/*` request.
 */
async function bulkDryRun(ctx: Ctx, target: Target, p: BulkPlan): Promise<ExitCode> {
  const outcomes: BulkOutcome[] = [];
  for (const t of p.targets) {
    const { ok, reason } = permission(await packCanExecute(target, t), p.op.key);
    outcomes.push({ target: t.shown, ok, ...(reason !== undefined ? { error: reason } : {}) });
  }
  renderOutcomes(ctx, outcomes, { ok: "permitted", failed: "blocked" });
  ctx.io.err("note: a dry run checks permission, not success: a permitted operation can still fail when run.\n");
  const blocked = outcomes.filter((o) => !o.ok).length;
  return blocked === 0 ? ExitCode.Ok : ExitCode.NotAuthorized;
}

async function runBulk(ctx: Ctx, target: Target, p: BulkPlan, mode: { explain: boolean; dry: boolean }): Promise<ExitCode> {
  if (mode.explain) {
    renderDocument({ method: "POST", url: `${target.url}/${bulkPath(p)}`, body: bulkBody(p, shownTarget) },
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
    if (!mode.dry) return ExitCode.Ok;
  }
  if (mode.dry) return await bulkDryRun(ctx, target, p);

  const real = (t: OperationTarget) => `${cleanName(t.type)};${t.id}`;
  const isDelete = p.route === "deleteMultiple";
  // The count first, before anything else can scroll it away (AC-45.5).
  ctx.io.err(`${p.op.key} on ${p.targets.length} records\n`);
  const permit = await confirmMutation(ctx, {
    operation: p.op.key,
    target: `${p.targets.length} records`,
    realTarget: p.targets.map(real).join(", "),
    url: target.url,
    destructive: isDelete,
    records: p.targets.map(real),
  });

  let response: unknown;
  try {
    response = (await target.http.request<unknown>({
      method: "POST", path: bulkPath(p), rawBody: JSON.stringify(bulkBody(p, liteJson)), lossless: true,
    })).body;
  } catch (err) {
    // The request as a whole failed: every record in it did.
    const viaHandle = p.targets.some((t) => isHandle(t.shown));
    const failure = explainSendError(err, viaHandle ? `a record among the ${p.targets.length} was not found` : undefined);
    for (const t of p.targets) recordMutation(ctx, permit, failureOf(failure), { realTarget: real(t), target: t.shown });
    throw failure;
  }

  if (p.route === "constructFromMany") {
    // One new entity from many records: a pack, not a stream.
    recordMutation(ctx, permit, { ok: true });
    if (response === null || response === undefined || response === "") {
      ctx.io.err(`note: ${p.op.key} declined to construct anything; nothing was returned.\n`);
      return ExitCode.Ok;
    }
    if (!p.op.info.resultIsSaved) ctx.io.err(`note: ${p.op.key} returned a new ${p.op.type.name} that is NOT saved; nothing was stored.\n`);
    renderPack(ctx, response);
    return ExitCode.Ok;
  }

  const text = typeof response === "string" ? response : JSON.stringify(response);
  const outcomes = parseOutcomes(p, text);
  p.targets.forEach((t, i) => {
    const o = outcomes[i] as BulkOutcome;
    recordMutation(ctx, permit, o.ok ? { ok: true } : { ok: false, error: o.error ?? "", exitCode: ExitCode.PartialFailure },
      { realTarget: real(t), target: t.shown });
  });
  renderOutcomes(ctx, outcomes, { ok: isDelete ? "deleted" : "ok", failed: "FAILED" });
  return bulkExit(outcomes);
}
