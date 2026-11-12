/**
 * `signum get <Type> <id>` · `signum get <Lite>`
 *
 * STORY-30 (retrieve), STORY-51 (agent data gate).
 */

import type { Ctx } from "../core/ctx.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDataDocument, renderDocument } from "../core/output.ts";
import { findType, isEntityTypeInfo, loadMetadata, unknownTypeError } from "../core/metadata.ts";
import { flag } from "../core/ctx.ts";
import { resolveTarget } from "../core/target.ts";
import { persistHandles } from "../core/handles.ts";
import { emitCommandEcho } from "../core/commandline.ts";
import { loadHandles } from "../core/handles.ts";
import { parseLiteKey } from "../core/text.ts";
import { disclosure, pseudonymizeDocument } from "../core/privacy.ts";
import { isHandle, resolveHandle } from "../core/reidentify.ts";
import { entityPath, fetchEntity } from "../core/entity.ts";

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

  if (id === undefined) {
    // `signum get <Type>` with no id is a bounded listing — m2 (fetchAll).
    throw new UsageError(`no id given for '${typeName}'`, {
      hint:
        "signum get Order 42\n" +
        "Listing all entities of a type (`signum get Order`) is m2.\n" +
        "For now use `signum query " + typeName + " --top 20`.",
    });
  }

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
  const existsOnly = flag(ctx, "exists");
  const pathFor = (key: string): string => existsOnly
    ? `api/exists/${encodeURIComponent(cleanName)}/${encodeURIComponent(key)}`
    : entityPath(cleanName, key);
  const path = pathFor(id);

  if (flag(ctx, "as-command")) {
    emitCommandEcho(ctx); // REQ-078 — see the note in query.ts
    return ExitCode.Ok;
  }

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

  const body = await fetchEntity(target.http, cleanName, id).catch((err: unknown) => {
    // A not-found names the id it looked up; behind a handle that is the identity being protected.
    if (viaHandle && err instanceof NotFoundError) throw new NotFoundError(`${first} not found`, err.hint !== undefined ? { hint: err.hint } : {});
    throw err;
  });

  // An entity is a document, not a table, so it renders as JSON in every format — and it is
  // pseudonymized by member name rather than by column (REQ-057). Without this the m2 gate change
  // would be a leak: pseudonymization opens the agent path, and `get` would walk through it raw.
  const { value, pseudonymized, handleDetails } = pseudonymizeDocument(body, ctx.privacy);
  persistHandles(ctx, handleDetails); // before emitting — see the note in query.ts
  renderDataDocument(value, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.openData(dataKind),
  });
  const note = disclosure(ctx.privacy, pseudonymized);
  if (note !== "") ctx.io.err("\n" + note);
  return ExitCode.Ok;
}
