/**
 * `signum get <Type> <id>` · `signum get <Lite>`
 *
 * STORY-30 (retrieve), STORY-51 (agent data gate).
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import { findType, loadMetadata, suggestTypes } from "../core/metadata.ts";
import { flag, resolveTarget } from "./context.ts";

/** `Order;42` → `{ type: "Order", id: "42" }` (AC-30.2). */
export function parseLiteKey(value: string): { type: string; id: string } | undefined {
  const idx = value.indexOf(";");
  if (idx <= 0 || idx === value.length - 1) return undefined;
  const type = value.slice(0, idx);
  const id = value.slice(idx + 1);
  if (type === "" || id === "" || type.includes("/")) return undefined;
  return { type, id };
}

export async function runGet(ctx: Ctx): Promise<ExitCode> {
  const first = ctx.args.positionals[0];
  const second = ctx.args.positionals[1];

  if (first === undefined) {
    throw new UsageError("`get` needs a type and id, or a Lite key", {
      hint: 'signum get Order 42\nsignum get "Order;42"     (quote it — an unquoted ; is a shell separator)',
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

  // Unconditional gate first — see the note in query.ts.
  if (!ctx.args.flags.explain) {
    ctx.assertMayEmitData(flag(ctx, "exists") ? "entity existence" : "entity data");
  }

  const target = resolveTarget(ctx, { requireAuth: true });

  const md = await loadMetadata({
    url: target.url, http: target.http, env: ctx.io.env, warn: (l) => ctx.io.err(l),
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
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDocument({ type: cleanName, id, exists: present }, { format: ctx.format, write: ctx.io.out });
    } else if (present) {
      ctx.io.out("exists\n");
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
  renderDocument(res.body, {
    format: ctx.format === "table" ? "json" : ctx.format,
    write: ctx.io.out,
  });
  return ExitCode.Ok;
}
