/**
 * `signum get <Type> <id>` · `signum get <Lite>` · `--pack` · `signum get <Type>` (every record)
 *
 * STORY-30 (retrieve), STORY-51 (agent data gate). `--pack` and the listing are REQ-030's m2 half (#138).
 */

import { emitData } from "../core/emit.ts";
import type { Ctx } from "../core/ctx.ts";
import { opt } from "../core/ctx.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDataDocument, renderDocument } from "../core/output.ts";
import { findType, isEntityTypeInfo, loadMetadata, unknownTypeError } from "../core/metadata.ts";
import { flag } from "../core/ctx.ts";
import { resolveTarget } from "../core/target.ts";
import { emitCommandEcho } from "../core/commandline.ts";
import { loadHandles } from "../core/handles.ts";
import { parseLiteKey } from "../core/text.ts";
import { pseudonymizeDocument } from "../core/privacy.ts";
import { isHandle, resolveHandle } from "../core/reidentify.ts";
import { asEntity, entityPath, fetchEntity } from "../core/entity.ts";
import type { TypeInfo } from "../core/metadata.ts";
import type { Target } from "../core/target.ts";
import { pseudonymizeEntities } from "./query-variants.ts";

export async function runGet(ctx: Ctx): Promise<ExitCode> {
  const first = ctx.args.positionals[0];
  const second = ctx.args.positionals[1];

  if (first === undefined) {
    throw new UsageError("`get` needs a type and id, or a Lite key", {
      hint: 'signum get Order 42\nsignum get "Order;42"     (quote it — an unquoted ; is a shell separator)',
    });
  }

  // csv, tsv and name are refused before this runs (H3, REQ-050): an entity is a document, and
  // `get` declares only the document formats. `table` renders as JSON below.

  // AC-53.2: a `ref:` handle is accepted wherever a Lite is, and resolved LOCALLY — the handle
  // itself must never reach the server, and an unresolvable one must fail here rather than be
  // forwarded as a literal string that might 404 confusingly or, worse, match something (AC-53.5).
  const viaHandle = isHandle(first);
  const subject = viaHandle ? resolveHandle(first, loadHandles(ctx.io.env, ctx.target)) : first;

  const lite = parseLiteKey(subject);
  const typeName = lite?.type ?? subject;
  const id = lite?.id ?? second;

  // What each form takes, checked before anything is read: a mistake in the caller's own flags is
  // not data, and is reported whoever the caller is.
  const pack = flag(ctx, "pack");
  const listing = id === undefined;
  if (pack && flag(ctx, "exists")) throw new UsageError("choose one of --pack and --exists");
  if (listing && (pack || flag(ctx, "exists"))) {
    throw new UsageError(`--${pack ? "pack" : "exists"} is about one record; name it`, { hint: `signum get ${typeName} <id> --${pack ? "pack" : "exists"}` });
  }
  if (!listing && (opt(ctx, "top") !== undefined || flag(ctx, "all"))) {
    throw new UsageError("--top and --all bound a listing; with an id there is one record", { hint: `signum get ${typeName} --top 20` });
  }
  const bound = listing ? listingBound(ctx) : undefined;

  // Unconditional gate first — see the note in query.ts. The render paths open their own
  // writer; this call exists so a refusal costs no network round trip.
  const dataKind = flag(ctx, "exists") ? "entity existence" : "entity data";
  if (!ctx.args.flags.explain) ctx.openData(dataKind);

  // Conditional on --explain, matching query.ts — it sends nothing so must not need a
  // credential (QA finding, parity fix). The final GET below enforces auth itself if
  // --explain is absent and no token is stored.
  const target = resolveTarget(ctx, { requireAuth: !ctx.args.flags.explain });

  const md = await loadMetadata({
    url: target.url, http: target.http, offline: ctx.args.flags.offline,
    env: ctx.io.env, warn: (l) => ctx.io.err(l),
  });
  const type = findType(md, typeName);
  if (type === undefined) throw unknownTypeError(md, typeName);

  // Reflection lists enums and symbol containers too; only an entity can be retrieved. A type with
  // no kind (an older or hand-written metadata document) is given the benefit of the doubt.
  if (type.kind !== undefined && !isEntityTypeInfo(type)) {
    if (type.kind === "Entity") {
      // An embedded or model type: reflection lists it as an entity, but it has no id of its own.
      throw new UsageError(`'${type.name}' is an embedded or model type, not a stored entity, so it cannot be retrieved`, {
        hint: `Run \`signum explain ${type.name}\` to see its members. Retrievable types show an entity kind in \`signum types\`, e.g. "Entity (Main)".`,
      });
    }
    throw new UsageError(`'${type.name}' is ${/^[AEIOU]/.test(type.kind) ? "an" : "a"} ${type.kind}, not an entity, so it cannot be retrieved`, {
      hint: `Run \`signum explain ${type.name}\` to see its ${type.kind === "SymbolContainer" ? "symbols" : "values"}.`,
    });
  }

  // The server addresses entities by clean name (`RoleEntity` → `Role`) (AC-30.4).
  const cleanName = type.name.replace(/Entity$/, "");
  if (flag(ctx, "as-command")) {
    emitCommandEcho(ctx); // REQ-078 — see the note in query.ts
    return ExitCode.Ok;
  }
  // Under --explain the listing's one request is shown by the client, like any other (#122).
  if (id === undefined) return await fetchAll(ctx, target, type, cleanName, bound as number | null);
  const existsOnly = flag(ctx, "exists");
  // `entityPack`, not `entityPackLight`: the light one empties `canExecute` (`EntityController.cs:26-45`),
  // which is the whole point of asking for a pack.
  const pathFor = (key: string): string => existsOnly
    ? `api/exists/${encodeURIComponent(cleanName)}/${encodeURIComponent(key)}`
    : pack ? `api/entityPack/${encodeURIComponent(cleanName)}/${encodeURIComponent(key)}`
    : entityPath(cleanName, key);
  const path = pathFor(id);

  if (ctx.args.flags.explain) {
    // Behind a handle the path would spell out the real id, so show the handle in its place. Built,
    // not substituted: a pattern made from the id misses when the id holds a regex character.
    const shown = viaHandle ? pathFor(first) : path;
    renderDocument({ ...target.http.describe({ method: "GET", path: shown }), ...(viaHandle ? { id: "resolved locally from the handle" } : {}) },
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  if (existsOnly) {
    const res = await target.http.request<unknown>({ method: "GET", path });
    const present = res.body === true || res.body === "true";
    const out = ctx.openData(dataKind);
    if (ctx.format === "json" || ctx.format === "ndjson") {
      // The caller named the record by handle, so the answer does too — never the id behind it.
      renderDataDocument({ type: cleanName, id: viaHandle ? first : id, exists: present }, { format: ctx.format, write: out });
    } else if (present) {
      out("exists\n");
    } else {
      ctx.io.err("does not exist\n");
    }
    return present ? ExitCode.Ok : ExitCode.NotFound;
  }

  // A not-found names the id it looked up; behind a handle that is the identity being protected.
  const hideId = (err: unknown): never => {
    if (viaHandle && err instanceof NotFoundError) throw new NotFoundError(`${first} not found`, err.hint !== undefined ? { hint: err.hint } : {});
    throw err;
  };
  if (pack) return await renderPack(ctx, target, path, dataKind, hideId);
  const body = await fetchEntity(target.http, cleanName, id).catch(hideId);

  // An entity is a document, not a table, so it renders as JSON in every format — and it is
  // pseudonymized by member name rather than by column (REQ-057). Without this the m2 gate change
  // would be a leak: pseudonymization opens the agent path, and `get` would walk through it raw.
  const { value, pseudonymized, handleDetails } = pseudonymizeDocument(body, ctx.privacy);
  emitData(ctx, dataKind, { handles: handleDetails, pseudonymized }, (out) =>
    renderDataDocument(value, { format: ctx.format === "table" ? "json" : ctx.format, write: out }));
  return ExitCode.Ok;
}

/**
 * `--pack` (AC-30.3): the entity and, beside it, what this login may do to it — `canExecute`, one
 * operation key to null (permitted) or the reason it is not. A key ABSENT was withheld for this
 * login, never "no such operation" (AC-08.5, `OperationLogic.cs:456`); `--dry-run` reads the same
 * map. The entity is pseudonymized as `get` does it. Anything an application adds to its packs
 * (`EntityPackTS.extension`, written as extra members) is data of the application's choosing, so it
 * is judged like the entity's members rather than passed through.
 */
async function renderPack(ctx: Ctx, target: Target, path: string, dataKind: string, hideId: (err: unknown) => never): Promise<ExitCode> {
  const res = await target.http.request<unknown>({ method: "GET", path, lossless: true }).catch(hideId);
  const { entity: rawEntity, canExecute, ...extension } = (res.body ?? {}) as Record<string, unknown>;
  const entity = pseudonymizeDocument(asEntity(rawEntity), ctx.privacy);
  const extra = Object.keys(extension).length > 0 ? pseudonymizeDocument(extension, ctx.privacy) : undefined;
  const minted = {
    handles: { ...entity.handleDetails, ...(extra?.handleDetails ?? {}) },
    pseudonymized: [...entity.pseudonymized, ...(extra?.pseudonymized ?? [])],
  };
  emitData(ctx, dataKind, minted, (out) => renderDataDocument(
    { entity: entity.value, canExecute: canExecute ?? {}, ...((extra?.value as Record<string, unknown> | undefined) ?? {}) },
    { format: ctx.format === "table" ? "json" : ctx.format, write: out },
  ));
  if (ctx.format === "table") {
    ctx.io.err("\nA key absent from canExecute was withheld for this login; it does not mean the operation does not exist.\n");
  }
  return ExitCode.Ok;
}

/** `--top n` (default 50) or `--all`: the same bound `query` takes (AC-23.2). Null is unbounded. */
function listingBound(ctx: Ctx): number | null {
  const top = opt(ctx, "top");
  if (top !== undefined && flag(ctx, "all")) throw new UsageError("choose one of --top and --all");
  if (flag(ctx, "all")) return null;
  if (top === undefined) return 50;
  const n = Number(top);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError("--top must be a positive integer");
  return n;
}

/**
 * `signum get <Type>`: every record of a master-data type, through `api/fetchAll` (AC-30.5). The
 * server returns all of them — the endpoint has no paging — and refuses a Transactional type
 * (`EntityController.cs:77-89`), so that is refused here first, pointing at the query that pages.
 * The bound limits what is SHOWN; what was not is counted on stderr. Each entity is a document,
 * pseudonymized on its own, as `query --entities` returns them.
 */
async function fetchAll(ctx: Ctx, target: Target, type: TypeInfo, cleanName: string, bound: number | null): Promise<ExitCode> {
  if (type.entityData === "Transactional") {
    throw new UsageError(`${type.name} is transactional data, which the server does not list whole`, {
      hint: `List it a page at a time: signum query ${type.name} --entities --top 20`,
    });
  }
  const res = await target.http.request<unknown>({ method: "GET", path: `api/fetchAll/${encodeURIComponent(cleanName)}`, lossless: true });
  const all = (Array.isArray(res.body) ? res.body : []).map((e) => asEntity(e));
  const shown = bound === null ? all : all.slice(0, bound);
  const { values, pseudonymized, handleDetails } = pseudonymizeEntities(ctx, shown);
  emitData(ctx, "entity data", { handles: handleDetails, pseudonymized }, (out) => {
    if (ctx.format === "ndjson") for (const v of values) renderDataDocument(v, { format: "ndjson", write: out });
    else renderDataDocument(values, { format: "json", write: out });
  });
  if (shown.length < all.length) {
    // The total is an aggregate over the records (AC-51.3), so a pseudonymized run is not told it.
    ctx.io.err(ctx.privacy.mode === "off"
      ? `\n${shown.length} of ${all.length} shown (--top ${bound}); --all shows every one\n`
      : `\n${shown.length} shown (--top ${bound}); there are more, and --all shows every one\n`);
  }
  return ExitCode.Ok;
}
