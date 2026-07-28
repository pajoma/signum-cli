/**
 * `signum get <Type> <id>` · `signum get <Lite>`
 *
 * STORY-30 (retrieve), STORY-51 (agent data gate).
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDataDocument, renderDocument } from "../core/output.ts";
import { findType, loadMetadata, suggestTypes } from "../core/metadata.ts";
import { emitCommandEcho, flag, persistHandles, resolveTarget } from "./context.ts";
import { loadHandles } from "../core/config.ts";
import { parseLiteKey } from "../core/text.ts";
import { createRecorder, disclosure, isHandle, pseudonymizeDocument, resolveHandle } from "../core/privacy.ts";

export async function runGet(ctx: Ctx): Promise<ExitCode> {
  const first = ctx.args.positionals[0];
  const second = ctx.args.positionals[1];

  if (first === undefined) {
    throw new UsageError("`get` needs a type and id, or a Lite key", {
      hint: 'signum get Order 42\nsignum get "Order;42"     (quote it — an unquoted ; is a shell separator)',
    });
  }

  // H3 (Brooks review): an entity is a document, not a table. csv/tsv/name have no meaning
  // for it, and silently coercing them to JSON hands a pipeline malformed data with no signal.
  // Reject them explicitly, up front (a format mistake should not cost a network round trip).
  // `table` is exempt: it is the *default* off a non-TTY resolution, not a user request, and
  // renderDocument already maps it to JSON for the human-on-a-TTY case.
  if (ctx.args.flags.output === "csv" || ctx.args.flags.output === "tsv" || ctx.args.flags.output === "name") {
    throw new UsageError(`get does not support --output ${ctx.args.flags.output}`, {
      hint: "An entity is a document, not a table. Use --output json (default) or ndjson.",
    });
  }

  // AC-53.2: a `ref:` handle is accepted wherever a Lite is, and resolved LOCALLY — the handle
  // itself must never reach the server, and an unresolvable one must fail here rather than be
  // forwarded as a literal string that might 404 confusingly or, worse, match something (AC-53.5).
  const subject = isHandle(first) ? resolveHandle(first, loadHandles(ctx.io.env)) : first;

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
  if (type === undefined) {
    const near = suggestTypes(md, typeName);
    throw new NotFoundError(`unknown type '${typeName}'`, {
      hint: near.length > 0
        ? `Did you mean: ${near.join(", ")}?`
        : "Run `signum types` to see what this application exposes.",
    });
  }

  // The server addresses entities by clean name (`RoleEntity` → `Role`) (AC-30.4).
  const cleanName = type.name.replace(/Entity$/, "");
  const existsOnly = flag(ctx, "exists");
  const path = existsOnly
    ? `api/exists/${encodeURIComponent(cleanName)}/${encodeURIComponent(id)}`
    : `api/entity/${encodeURIComponent(cleanName)}/${encodeURIComponent(id)}`;

  if (flag(ctx, "as-command")) {
    emitCommandEcho(ctx); // REQ-078 — see the note in query.ts
    return ExitCode.Ok;
  }

  if (ctx.args.flags.explain) {
    renderDocument({ method: "GET", url: `${target.url}/${path}` },
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }

  if (existsOnly) {
    const res = await target.http.request<unknown>({ method: "GET", path });
    const present = res.body === true || res.body === "true";
    const out = ctx.openData(dataKind);
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDataDocument({ type: cleanName, id, exists: present }, { format: ctx.format, write: out });
    } else if (present) {
      out("exists\n");
    } else {
      ctx.io.err("does not exist\n");
    }
    return present ? ExitCode.Ok : ExitCode.NotFound;
  }

  const res = await target.http.request<unknown>({ method: "GET", path });
  if (res.body === null || res.body === undefined || res.body === "") {
    throw new NotFoundError(`${cleanName} ${id} not found`);
  }

  // An entity is a document, not a table, so it renders as JSON in every format — and it is
  // pseudonymized by member name rather than by column (REQ-057). Without this the m2 gate change
  // would be a leak: pseudonymization opens the agent path, and `get` would walk through it raw.
  const recorder = createRecorder();
  const { value, pseudonymized } = pseudonymizeDocument(res.body, ctx.privacy, recorder);
  persistHandles(ctx, recorder.entries()); // before emitting — see the note in query.ts
  renderDataDocument(value, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.openData(dataKind),
  });
  const note = disclosure(ctx.privacy, pseudonymized);
  if (note !== "") ctx.io.err("\n" + note);
  return ExitCode.Ok;
}
