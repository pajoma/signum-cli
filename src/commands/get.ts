/**
 * `signum get <Type> <id>` · `signum get <Lite>`
 *
 * STORY-30 (retrieve), STORY-51 (agent data gate).
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDataDocument, renderDocument } from "../core/output.ts";
import { findType, loadMetadata, suggestTypes } from "../core/metadata.ts";
import { flag, resolveTarget } from "./context.ts";
import { parseLiteKey } from "../core/text.ts";

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

  const lite = parseLiteKey(first);
  const typeName = lite?.type ?? first;
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

  // An entity is a document, not a table, so it renders as JSON in every format.
  renderDataDocument(res.body, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.openData(dataKind),
  });
  return ExitCode.Ok;
}
