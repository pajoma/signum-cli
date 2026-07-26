/**
 * `signum query <queryKey>`
 *
 * STORY-20 (run a query), STORY-21 (de-intern), STORY-22 (output), STORY-23 (pagination),
 * STORY-51 (agent data gate).
 *
 * `--filter` is deliberately NOT implemented here: the expression language is REQ-021/m1 but
 * needs its own parser, and shipping a half-parser that silently mis-filters production data
 * would be worse than not shipping one. `--filter-json` provides full fidelity in the
 * meantime, since it is the wire shape.
 */

import type { Ctx } from "../cli.ts";
import { ExitCode, UsageError } from "../core/errors.ts";
import { renderResultTable, renderDocument } from "../core/output.ts";
import { resolveResultTable, type RawResultTable } from "../core/resulttable.ts";
import { findType, loadMetadata, suggestTypes } from "../core/metadata.ts";
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
  if (flag(ctx, "all")) {
    // Unbounded must be explicit; the default is always bounded (AC-23.2).
    return { mode: "All" };
  }
  return { mode: "Firsts", elementsPerPage: 50 };
}

function readFilterJson(source: string): unknown[] {
  const text = source === "-"
    ? undefined
    : source.startsWith("@")
      ? readFileSync(source.slice(1), "utf8")
      : readFileSync(source, "utf8");
  if (text === undefined) {
    throw new UsageError("--filter-json - (stdin) is not yet wired for query", {
      hint: "Pass a file path instead: --filter-json filters.json",
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

export async function runQuery(ctx: Ctx): Promise<ExitCode> {
  const queryKey = ctx.args.positionals[0];
  if (queryKey === undefined) {
    throw new UsageError("`query` needs a query key", {
      hint: "signum queries            list available queries\nsignum query Order --top 20",
    });
  }

  if (optAll(ctx, "filter").length > 0) {
    throw new UsageError("--filter is not implemented yet", {
      hint:
        "The filter expression language is specified (REQ-021, docs/design/filter-expression-syntax.md)\n" +
        "but its parser is not written. A partial parser could silently mis-filter production data,\n" +
        "so it is withheld rather than approximated.\n\n" +
        "Use --filter-json for full wire fidelity meanwhile:\n" +
        '  --filter-json \'[{"token":"State","operation":"EqualTo","value":"Shipped"}]\'',
    });
  }

  // The gate is unconditional, so evaluate it before touching credentials or the network:
  // being told to fix auth and *then* refused would be two round trips of confusion.
  // --explain emits no data, so it stays exempt (checked after this point).
  if (!ctx.args.flags.explain) ctx.assertMayEmitData("query results");

  const target = resolveTarget(ctx, { requireAuth: true });

  // Validate the query key against cached metadata so a typo costs no round trip (AC-20.7).
  const md = await loadMetadata({
    url: target.url, http: target.http, env: ctx.io.env, warn: (l) => ctx.io.err(l),
  });
  if (findType(md, queryKey) === undefined) {
    const near = suggestTypes(md, queryKey);
    throw new UsageError(`unknown query key '${queryKey}'`, {
      hint: near.length > 0
        ? `Did you mean: ${near.join(", ")}?\nRun \`signum queries\` for the list.`
        : "Run `signum queries` to see available queries.",
    });
  }

  const columns = optAll(ctx, "column").map((token) => ({ token }));
  const orders = parseOrders(optAll(ctx, "order"));
  const filterJsonSource = opt(ctx, "filter-json");
  const filters = filterJsonSource !== undefined ? readFilterJson(filterJsonSource) : [];

  const wantCount = flag(ctx, "count");

  const request: Record<string, unknown> = {
    queryKey,
    groupResults: false,
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
    if (ctx.format === "json" || ctx.format === "ndjson") {
      renderDocument({ queryKey, count: res.body }, { format: ctx.format, write: ctx.io.out });
    } else {
      ctx.io.out(`${String(res.body)}\n`);
    }
    return ExitCode.Ok;
  }

  const res = await target.http.request<RawResultTable>({
    method: "POST",
    path: `api/query/executeQuery/${encodeURIComponent(queryKey)}`,
    body: request,
  });

  // The de-interning boundary: nothing downstream sees a raw row (AC-21.1).
  const table = resolveResultTable(res.body);

  renderResultTable(table, {
    format: ctx.format,
    write: ctx.io.out,
    warn: (line) => ctx.io.err(line + "\n"),
  });

  // Total is reported distinctly from rows returned, so a page is never mistaken for all (AC-21.5).
  if (ctx.format === "table" && table.totalElements !== undefined && table.totalElements > table.rows.length) {
    ctx.io.err(`\n${table.rows.length} of ${table.totalElements} rows (use --top, --page, or --all)\n`);
  }
  return ExitCode.Ok;
}
