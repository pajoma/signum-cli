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
 * Construct and delete (#118) and bulk operations (#119) are not here yet, and say so.
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

/** Where the record comes from: positional after the noun, `--lite`, or `--id`, never two of them. */
function targetOf(ctx: Ctx, noun: string | undefined, positional: string | undefined): OperationTarget | undefined {
  const handles = loadHandles(ctx.io.env);
  const given = [
    positional !== undefined ? { from: "position", v: positional } : undefined,
    ...optAll(ctx, "lite").map((v) => ({ from: "--lite", v })),
    ...optAll(ctx, "id").map((v) => ({ from: "--id", v })),
  ].filter((x): x is { from: string; v: string } => x !== undefined);
  if (given.length > 1) {
    throw new UsageError(`name the record once; got ${given.map((g) => g.from).join(" and ")}`);
  }
  const one = given[0];
  if (one === undefined) return undefined;
  const t = parseTarget(one.v, noun, handles);
  if (one.from === "--id" && parseLiteKey(one.v) !== undefined) {
    throw new UsageError(`--id takes a bare id; '${one.v}' is a Lite key`, { hint: `Use --lite "${one.v}".` });
  }
  return t;
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

/** The `--explain` / request body, built once for both. */
interface Plan {
  op: ResolvedOperation;
  target: OperationTarget;
  route: "executeEntity" | "executeLite";
  args: ArgValue[] | null;
  edits: ReturnType<typeof parseEdits>;
}

function cleanName(typeName: string): string {
  return typeName.replace(/Entity$/, "");
}

function liteJson(t: OperationTarget): Record<string, unknown> {
  return { EntityType: cleanName(t.type), id: /^\d+$/.test(t.id) ? new JsonNumber("identifier", t.id) : t.id };
}

function plan(ctx: Ctx, md: Metadata): Plan {
  const isKey = ctx.args.kind === "operation-key";
  const command = String(ctx.args.command);
  const noun = isKey ? undefined : ctx.args.positionals[0];
  const positional = isKey ? ctx.args.positionals[0] : ctx.args.positionals[1];
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

  const target = targetOf(ctx, noun, positional);
  const op = isKey
    ? resolveKey(md, command, target?.type)
    : resolveVerbNoun(md, command, noun as string);

  // Construct, construct-from and delete are #118; a constructor takes no target at all.
  if (op.info.kind !== undefined && op.info.kind !== "Execute") {
    throw new UsageError(`${op.key} is a ${op.info.kind} operation, which this version cannot invoke yet`, {
      hint: "Construct and delete operations are #118. Execute operations work today.",
    });
  }
  if (target === undefined) {
    throw new UsageError(`${op.key} needs the record to run on`, {
      hint: `signum ${kebab(op.info.verb)} ${kebab(op.type.name)} <id>   or   signum ${op.key} --lite "${op.type.name};<id>"`,
    });
  }
  if (cleanName(target.type).toLowerCase() !== cleanName(op.type.name).toLowerCase()) {
    throw new UsageError(`${target.shown} is not a ${op.type.name}`, { hint: `${op.key} runs on ${op.type.name}.` });
  }
  target.type = op.type.name;

  const edits = parseEdits(ctx);
  // An edited graph must never go out as a Lite: the server would receive only the identity and
  // drop every edit without an error (#114).
  if (edits.length > 0 && !op.info.canBeModified) {
    throw new UsageError(`${op.key} takes only the record's identity, so --edit would be discarded`, {
      hint: "Edit with an operation that takes the entity, such as its Save.",
    });
  }

  const args = encodeArgs(ctx.args.sequence, {
    handles: loadHandles(ctx.io.env),
    allowCustomObjects: flag(ctx, "allow-custom-arg"),
    warn: (line) => ctx.io.err(line),
  });

  return { op, target, route: op.info.canBeModified ? "executeEntity" : "executeLite", args, edits };
}

function operationPath(p: Plan): string {
  return `api/operation/${p.route}/${encodeURIComponent(p.op.key)}`;
}

/** `--explain`: the exact request, sending nothing (REQ-053, AC-42.7). */
function explainPlan(ctx: Ctx, target: Target, p: Plan): ExitCode {
  const shownLite = { ...liteJson(p.target), ...(p.target.shown !== `${p.target.type};${p.target.id}` && isHandle(p.target.shown) ? { id: p.target.shown } : {}) };
  const body = p.route === "executeLite"
    ? { lite: shownLite, args: p.args }
    : {
      entity: `${p.target.shown}, as fetched from api/entity when sent` +
        (p.edits.length > 0 ? `, with ${p.edits.map((e) => e.written).join(", ")} applied` : ""),
      args: p.args,
    };
  renderDocument({ method: "POST", url: `${target.url}/${operationPath(p)}`, body },
    { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
  return ExitCode.Ok;
}

/**
 * `--dry-run`: would this login be permitted, and why not (REQ-043). One GET of the entity pack,
 * whose `canExecute` maps each operation key to null (permitted) or a reason. A key that is ABSENT
 * was withheld for this login (`OperationLogic.cs:456`): not permitted, reason not given — never
 * "unknown operation". Sends no `api/operation/*` request.
 */
async function dryRun(ctx: Ctx, target: Target, p: Plan): Promise<ExitCode> {
  const res = await target.http.request<unknown>({
    method: "GET",
    path: `api/entityPack/${encodeURIComponent(cleanName(p.target.type))}/${encodeURIComponent(p.target.id)}`,
    lossless: true,
  });
  const pack = (res.body ?? {}) as Record<string, unknown>;
  const canExecute = (pack["canExecute"] ?? {}) as Record<string, unknown>;
  const present = Object.hasOwn(canExecute, p.op.key);
  const reason = present ? canExecute[p.op.key] : undefined;
  const permitted = present && (reason === null || reason === undefined || reason === "");

  const verdict: Record<string, unknown> = {
    operation: p.op.key,
    target: p.target.shown,
    permitted,
    ...(typeof reason === "string" && reason !== "" ? { reason } : {}),
    ...(!present ? { reason: "not permitted for this login; the server gives no reason" } : {}),
    note: "A dry run checks permission, not success: a permitted operation can still fail when run.",
  };
  if (ctx.format === "json" || ctx.format === "ndjson") {
    renderDocument(verdict, { format: ctx.format, write: ctx.io.out });
  } else {
    ctx.io.out(permitted
      ? `${p.op.key} on ${p.target.shown}: permitted\n`
      : `${p.op.key} on ${p.target.shown}: not permitted — ${String(verdict["reason"])}\n`);
    ctx.io.err(`note: ${String(verdict["note"]).replace(/^A dry run/, "a dry run")}\n`);
  }
  // Scripts gate on it (AC-43.4): 0 would be permitted, 4 would not.
  return permitted ? ExitCode.Ok : ExitCode.NotAuthorized;
}

/** The request body. For the entity route the entity is fetched fresh and the edits applied to it. */
async function body(target: Target, p: Plan): Promise<string> {
  if (p.route === "executeLite") return JSON.stringify({ lite: liteJson(p.target), args: p.args });

  // Fetched now, so its `ticks` is the one the server last issued and travels back verbatim as a
  // string: a stale one is the server's concurrency check, never something to refresh away (#117).
  const entity: EntityJson = await fetchEntity(target.http, cleanName(p.target.type), p.target.id);
  let changed = false;
  for (const e of p.edits) changed = setMember(entity, wirePath(entity, e.path), e.value) || changed;
  if (p.edits.length > 0 && !changed) {
    // Saving nothing is not a save (AC-32.4): say so and send nothing.
    throw new CliError("every --edit already holds that value; nothing was sent", ExitCode.Usage);
  }
  const payload = serializeEntity(entity);
  return `{"entity":${payload.json},"args":${JSON.stringify(p.args)}}`;
}

/** The only place a mutation leaves the CLI. */
async function send(target: Target, p: Plan, permit: MutationPermit): Promise<unknown> {
  assertPermit(permit);
  const res = await target.http.request<unknown>({
    method: "POST",
    path: operationPath(p),
    rawBody: await body(target, p),
    lossless: true,
  });
  return res.body;
}

/** `EntityPackTS` → the refreshed entity, pseudonymized like `get`, beside its new `canExecute`. */
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

export async function runOperation(ctx: Ctx): Promise<ExitCode> {
  assertOperationFlags(ctx);

  const explain = ctx.args.flags.explain;
  const dry = flag(ctx, "dry-run");
  // The result is the record, so it is data (AC-51.1); a preview and a dry run emit none.
  if (!explain && !dry) ctx.openData(DATA_KIND);

  const target = resolveTarget(ctx, { requireAuth: !explain });
  const md = await loadMetadata({
    url: target.url, http: target.http, offline: ctx.args.flags.offline,
    env: ctx.io.env, warn: (l) => ctx.io.err(l),
  });
  const p = plan(ctx, md);

  if (explain && !dry) return explainPlan(ctx, target, p);
  if (dry) {
    // Composes with --explain (AC-43.6): the request it would send, and the verdict, sending nothing.
    if (explain) explainPlan(ctx, target, p);
    return await dryRun(ctx, target, p);
  }

  const permit = await confirmMutation(ctx, {
    operation: p.op.key,
    target: p.target.shown,
    realTarget: `${cleanName(p.target.type)};${p.target.id}`,
    url: target.url,
  });

  let pack: unknown;
  try {
    pack = await send(target, p, permit);
  } catch (err) {
    const failure = err instanceof NotAuthorizedError
      // The server judges every call as if the UI made it (`OperationController.cs:137`), so an
      // operation hidden from the UI cannot be invoked over the API at all (AC-40.5).
      ? new NotAuthorizedError(`not permitted: ${err.message}`, {
        hint: "This login may not run it on this record, or the operation is hidden from the UI —\n" +
          "the API invokes only what the UI may (OperationController.cs:137). Check with --dry-run.",
      })
      : err instanceof NotFoundError && p.target.shown !== `${cleanName(p.target.type)};${p.target.id}`
        ? new NotFoundError(`${p.target.shown} not found`) // a not-found must not spell out the id behind a handle
        : err;
    recordMutation(ctx, permit, {
      ok: false,
      error: failure instanceof Error ? failure.message : String(failure),
      exitCode: failure instanceof CliError ? failure.exitCode : ExitCode.Unexpected,
    });
    throw failure;
  }
  recordMutation(ctx, permit, { ok: true });
  renderPack(ctx, pack);
  return ExitCode.Ok;
}
