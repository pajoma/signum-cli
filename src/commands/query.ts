/**
 * `signum query <queryKey>`
 *
 * STORY-20 (run a query), STORY-21 (de-intern), STORY-22 (output), STORY-23 (pagination),
 * STORY-51 (agent data gate).
 *
 * `--filter` lowers through `core/filter.ts` onto the exact `FilterTS[]` wire shape;
 * `--filter-json` remains available as a bypass for anything the DSL cannot express yet
 * (design/filter-expression-syntax.md "escape hatch").
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, UsageError } from "../core/errors.ts";
import { renderResultTable, renderDataDocument, renderDocument } from "../core/output.ts";
import { resolveResultTable, type RawResultTable } from "../core/resulttable.ts";
import { loadMetadata, resolveQueryKey } from "../core/metadata.ts";
import { lowerFilterExpressions, parseFilterExpression, type FilterWire } from "../core/filter.ts";
import { opt, optAll, flag, resolveTarget } from "./context.ts";
import { readFileSync } from "node:fs";

interface OrderSpec { token: string; orderType: "Ascending" | "Descending" }

function parseOrders(values: readonly string[]): OrderSpec[] {
  return values.map((v) =>
    v.startsWith("-")
      ? { token: v.slice(1), orderType: "Descending" as const }
      : { token: v, orderType: "Ascending" as const },
  );
}

function parsePagination(ctx: Ctx): unknown {
  const top = opt(ctx, "top");
  const page = opt(ctx, "page");
  const pageSize = opt(ctx, "page-size");
  const all = flag(ctx, "all");

  // QA finding: these previously had silent, undocumented precedence (--top over --page over
  // --all), so a user combining them by habit got a page silently discarded. Ambiguous input
  // is now a clear error, matching the project's own rule for aggregate-without-group: silently
  // changing pagination semantics is worse than asking the user to pick one.
  const modesGiven = [top !== undefined, page !== undefined || pageSize !== undefined, all]
    .filter(Boolean).length;
  if (modesGiven > 1) {
    throw new UsageError("choose only one pagination mode: --top, --page/--page-size, or --all", {
      hint: "These were previously combinable with silent, undocumented precedence — pick one explicitly.",
    });
  }

  if (top !== undefined) {
    const n = Number(top);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError("--top must be a positive integer");
    return { mode: "Firsts", elementsPerPage: n };
  }
  if (page !== undefined || pageSize !== undefined) {
    const size = Number(pageSize ?? 50);
    const current = Number(page ?? 1);
    if (!Number.isInteger(size) || size <= 0) throw new UsageError("--page-size must be a positive integer");
    if (!Number.isInteger(current) || current <= 0) throw new UsageError("--page must be a positive integer");
    return { mode: "Paginate", elementsPerPage: size, currentPage: current };
  }
  if (all) {
    // Unbounded must be explicit; the default is always bounded (AC-23.2).
    return { mode: "All" };
  }
  return { mode: "Firsts", elementsPerPage: 50 };
}

function readFilterJson(source: string): unknown[] {
  if (source === "-") {
    // stdin needs an async read; readFilterJson is called from synchronous request-building.
    throw new UsageError("--filter-json - (stdin) is not yet wired for query", {
      hint: "Pass a file path instead: --filter-json filters.json  (or --filter-json @filters.json)",
    });
  }

  const path = source.startsWith("@") ? source.slice(1) : source;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // A bad path must be a clean usage error, not a raw ENOENT stack (found by testing).
    throw new UsageError(`could not read --filter-json file '${path}'`, {
      hint: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--filter-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError("--filter-json must be a JSON array of FilterTS objects", {
      hint: '[{"token":"State","operation":"EqualTo","value":"Shipped"}]',
    });
  }
  return parsed;
}

/** Names the data in a refusal message, and keeps the two `openData` calls in step. */
const DATA_KIND = "query results";

export async function runQuery(ctx: Ctx): Promise<ExitCode> {
  const queryKey = ctx.args.positionals[0];
  if (queryKey === undefined) {
    throw new UsageError("`query` needs a query key", {
      hint: "signum queries            list available queries\nsignum query Order --top 20",
    });
  }

  // Parse --filter FIRST, before the privacy gate: a syntax error is not data — it is a
  // diagnostic about the agent's OWN input, which it needs to see to correct itself. Gating
  // it behind "refusing to emit data" would hide a parse error from exactly the caller who
  // needs it most. (Found by exercising the built binary under a detected agent context:
  // `--filter "(Order.. = 5"` under CLAUDECODE=1 was masked by the data-gate message.)
  const groupEnabled = flag(ctx, "group");
  const filterStrings = optAll(ctx, "filter");
  const dslFilters = lowerFilterExpressions(
    filterStrings.map((expr, idx) => {
      try {
        return parseFilterExpression(expr);
      } catch (err) {
        // Identify which --filter failed when more than one was given.
        if (err instanceof UsageError && filterStrings.length > 1) {
          throw new UsageError(`in --filter #${idx + 1}: ${err.message}`, err.hint !== undefined ? { hint: err.hint } : {});
        }
        throw err;
      }
    }),
    { groupEnabled },
  );

  // The gate is unconditional from here on, evaluated before touching credentials or the
  // network: being told to fix auth and *then* refused would be two round trips of confusion.
  // --explain emits no data, so it stays exempt. The writer this returns is discarded; the
  // render paths below open their own. `openData` is side-effect-free, so that is free.
  if (!ctx.args.flags.explain) ctx.openData(DATA_KIND);

  // requireAuth is conditional on --explain: it sends nothing, so it must not need a
  // credential (QA finding — this previously blocked previewing a request before ever
  // logging in). The metadata fetch below is anonymous either way; only the real
  // executeQuery/queryValue call actually needs the token, and SignumHttp enforces that
  // itself if one is missing.
  const target = resolveTarget(ctx, { requireAuth: !ctx.args.flags.explain });

  // Validate the query key against cached metadata so a typo costs no round trip (AC-20.7).
  // `resolveQueryKey` is the SAME resolution `signum queries` lists from, so a key this accepts
  // is a key that was offered, and vice versa (Brooks review: those were two definitions).
  const md = await loadMetadata({
    url: target.url, http: target.http, offline: ctx.args.flags.offline,
    env: ctx.io.env, warn: (l) => ctx.io.err(l),
  });
  resolveQueryKey(md, queryKey);

  const requestedColumns = optAll(ctx, "column");
  const columns = requestedColumns.map((token) => ({ token }));
  const orders = parseOrders(optAll(ctx, "order"));
  const filterJsonSource = opt(ctx, "filter-json");
  // DSL and --filter-json are combined by concatenation — both are ANDed at the top level,
  // matching the design's "may be combined" rule (design/filter-expression-syntax.md).
  const jsonFilters = filterJsonSource !== undefined ? (readFilterJson(filterJsonSource) as FilterWire[]) : [];
  const filters: FilterWire[] = [...dslFilters, ...jsonFilters];

  const wantCount = flag(ctx, "count");

  const request: Record<string, unknown> = {
    queryKey,
    groupResults: groupEnabled,
    filters,
    orders,
    columns,
    pagination: parsePagination(ctx),
  };

  // --explain prints the request and sends nothing (AC-20.6).
  if (ctx.args.flags.explain) {
    renderDocument(
      { method: "POST", url: `${target.url}/api/query/${wantCount ? "queryValue" : "executeQuery"}/${queryKey}`, body: request },
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out },
    );
    return ExitCode.Ok;
  }

  if (wantCount) {
    const res = await target.http.request<unknown>({
      method: "POST",
      path: `api/query/queryValue/${encodeURIComponent(queryKey)}`,
      body: { ...request, valueToken: "Count" },
    });
    // A count is derived from rows, so it goes out through the data boundary like rows do.
    const out = ctx.openData(DATA_KIND);
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDataDocument({ queryKey, count: res.body }, { format: ctx.format, write: out });
    } else {
      out(`${String(res.body)}\n`);
    }
    return ExitCode.Ok;
  }

  const res = await target.http.request<RawResultTable>({
    method: "POST",
    path: `api/query/executeQuery/${encodeURIComponent(queryKey)}`,
    body: request,
  });

  // The de-interning boundary: nothing downstream sees a raw row (AC-21.1). The requested
  // column order goes in so the hoisted `Entity` column comes back at the position the user
  // asked for, in every format (AC-21.2).
  const table = resolveResultTable(res.body, { requestedColumns });

  renderResultTable(table, {
    format: ctx.format,
    write: ctx.openData(DATA_KIND),
    warn: (line) => ctx.io.err(line + "\n"),
    // QA finding: ctx.color was computed (TTY + NO_COLOR detection) but never consumed —
    // colour output didn't exist. Threaded through here now.
    color: ctx.color,
  });

  // Total is reported distinctly from rows returned, so a page is never mistaken for all (AC-21.5).
  if (ctx.format === "table" && table.totalElements !== undefined && table.totalElements > table.rows.length) {
    ctx.io.err(`\n${table.rows.length} of ${table.totalElements} rows (use --top, --page, or --all)\n`);
  }
  return ExitCode.Ok;
}
