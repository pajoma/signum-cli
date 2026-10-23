/**
 * `signum query <key> --lites` and `--entities` — REQ-024's result variants.
 *
 * The same query, filters and order as a table query, answered as references or as whole entities
 * instead of rows: `POST api/query/lites/{key}` → `Lite[]`, `POST api/query/entities/{key}` →
 * `Entity[]` (`QueryController.cs:104-114`). Both take `QueryEntitiesRequestTS`:
 * `{queryKey, filters, orders, count?}` (`FilterJsonConverter.cs:275-280`) — no columns, no
 * grouping, no pagination, so those flags are refused rather than silently dropped.
 *
 * Both are data. They go out through the gated writer, and are pseudonymized like `get` and the
 * table path: a Lite is an identity and becomes a handle, an entity is walked as a document.
 */

import type { Ctx } from "../core/ctx.ts";
import { flag, opt } from "../core/ctx.ts";
import { ExitCode, UsageError } from "../core/errors.ts";
import { liteKey, renderDataDocument } from "../core/output.ts";
import { disclosure, pseudonymizeDocument } from "../core/privacy.ts";
import { persistHandles } from "../core/handles.ts";
import type { DataWriter } from "../core/policy.ts";
import type { Target } from "../core/target.ts";

export type Variant = "lites" | "entities";

/** Which variant was asked for, if any — after refusing every flag the endpoints cannot honour. */
export function requestedVariant(ctx: Ctx): Variant | undefined {
  const lites = flag(ctx, "lites");
  const entities = flag(ctx, "entities");
  if (lites && entities) throw new UsageError("choose one of --lites and --entities");
  const variant: Variant | undefined = lites ? "lites" : entities ? "entities" : undefined;
  if (variant === undefined) return undefined;

  const conflicting = [
    ["column", opt(ctx, "column") !== undefined], ["group", flag(ctx, "group")],
    ["count", flag(ctx, "count")], ["resolve", flag(ctx, "resolve")],
    ["page", opt(ctx, "page") !== undefined], ["page-size", opt(ctx, "page-size") !== undefined],
  ].filter(([, given]) => given).map(([name]) => `--${String(name)}`);
  if (conflicting.length > 0) {
    throw new UsageError(`--${variant} cannot be combined with ${conflicting.join(", ")}`, {
      hint: `api/query/${variant} takes filters, an order and a count only. Use --top or --all for the count.`,
    });
  }
  // csv and tsv (and name, for --entities) are refused before this runs: each flag declares its
  // formats in help.ts, since references and documents have no rows to write.
  return variant;
}

/**
 * The page a table query gets when no paging flag is given. `Paginate`, not `Firsts`: only
 * `Paginate` makes the server count (`DQueryable.cs:957-1008`), and without that count a cut-off
 * page cannot be told from a complete result (AC-21.5, #149). Compared by identity in `countFrom`,
 * so an explicit `--page 1` is still refused by the variants.
 */
export const DEFAULT_PAGE = Object.freeze({ mode: "Paginate", elementsPerPage: 50, currentPage: 1 });

/** `count` from the already-validated pagination: --top n → n, --all → unbounded, default bounded. */
export function countFrom(pagination: unknown): number | null {
  if (pagination === DEFAULT_PAGE) return DEFAULT_PAGE.elementsPerPage;
  const p = pagination as { mode: string; elementsPerPage?: number };
  if (p.mode === "All") return null;
  if (p.mode === "Firsts") return p.elementsPerPage ?? 50;
  throw new UsageError("--lites and --entities cannot page; use --top or --all");
}

export function variantRequest(queryKey: string, filters: unknown[], orders: unknown[], count: number | null): Record<string, unknown> {
  // filters and orders are `required` on the wire (FilterJsonConverter.cs:278-279): send [] not nothing.
  return { queryKey, filters, orders, ...(count !== null ? { count } : {}) };
}

export async function runVariant(
  ctx: Ctx, target: Target, variant: Variant, request: Record<string, unknown>, open: () => DataWriter,
): Promise<ExitCode> {
  const res = await target.http.request<unknown>({
    method: "POST",
    path: `api/query/${variant}/${encodeURIComponent(String(request["queryKey"]))}`,
    body: request,
    lossless: true, // data, so exact — the same handles as `get` and the table path (#111)
  });
  const items = Array.isArray(res.body) ? res.body : [];

  // Each entity is its own document, so each is pseudonymized as one: walked as a single array, the
  // whole entity would be judged an identity and replaced by a handle, contents and all.
  const pseudonymized = new Set<string>();
  let handleDetails: Record<string, { lite: string; label?: string }> = {};
  const values = variant === "entities"
    ? items.map((e) => {
        const r = pseudonymizeDocument(e, ctx.privacy);
        r.pseudonymized.forEach((p) => pseudonymized.add(p));
        handleDetails = { ...handleDetails, ...r.handleDetails };
        return r.value;
      })
    : (() => {
        const r = pseudonymizeDocument(items, ctx.privacy);
        r.pseudonymized.forEach((p) => pseudonymized.add(p === "" ? "Entity" : p));
        handleDetails = { ...r.handleDetails };
        return r.value as unknown[];
      })();

  persistHandles(ctx, handleDetails); // before emitting — see the note in query.ts
  const out = open();
  const format = ctx.format;
  if (format === "json") {
    renderDataDocument(values, { format: "json", write: out });
  } else if (format === "ndjson") {
    for (const v of values) renderDataDocument(v, { format: "ndjson", write: out });
  } else if (variant === "entities") {
    // `table` here is the non-explicit default; an entity is a document (as in `get`).
    renderDataDocument(values, { format: "json", write: out });
  } else {
    // table and name: one reference per line; table adds the display string when one was sent.
    for (const v of values) {
      if (typeof v === "string") { out(`${v}\n`); continue; } // a handle
      const key = liteKey(v) ?? JSON.stringify(v);
      const model = (v as Record<string, unknown> | null)?.["model"];
      out(format === "table" && typeof model === "string" ? `${key}  ${model}\n` : `${key}\n`);
    }
  }

  const note = disclosure(ctx.privacy, [...pseudonymized]);
  if (note !== "") ctx.io.err("\n" + note);
  if (format === "table" && request["count"] !== undefined && items.length === request["count"]) {
    ctx.io.err(`\n${items.length} ${variant} shown, the --top limit; there may be more visible to you (use --all)\n`);
  }
  return ExitCode.Ok;
}
