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

import { emitData, streamData } from "../core/emit.ts";
import type { Ctx } from "../core/ctx.ts";
import { CliError, ExitCode, InterruptedError, NotAuthenticatedError, UsageError } from "../core/errors.ts";
import { renderResultTable, renderDataDocument, renderDocument, streamResultTable } from "../core/output.ts";
import { resolveResultTable, type RawResultTable, type ResolvedTable } from "../core/resulttable.ts";
import { loadMetadata, resolveQueryKey } from "../core/metadata.ts";
import { filterUnusableReason, idColumnTypes, resolveLiteColumns, type QueryTokenInfo } from "../core/tokens.ts";
import { fetchDefaultColumns, validateTokens } from "../core/token-requests.ts";
import { isHandle, resolveHandle } from "../core/reidentify.ts";
import { loadHandles } from "../core/handles.ts";
import { emitCommandEcho } from "../core/commandline.ts";
import {
  collectFilterTokens, findFilterValueMismatch, lowerFilterExpressions, parseFilterExpression, type FilterWire,
} from "../core/filter.ts";
import { flag, interruptible, opt, optAll } from "../core/ctx.ts";
import { resolveTarget, type Target } from "../core/target.ts";
import type { SignumHttp } from "../core/http.ts";
import { inputReader, type InputReader } from "../core/input.ts";
import { countFrom, DEFAULT_PAGE, requestedVariant, runVariant, variantRequest } from "./query-variants.ts";

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
  // `--page-size` beside `--all` is the size of each page it fetches, not a mode of its own (AC-23.3).
  const modesGiven = [top !== undefined, page !== undefined || (pageSize !== undefined && !all), all]
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
  if (page !== undefined || (pageSize !== undefined && !all)) {
    const size = Number(pageSize ?? 50);
    const current = Number(page ?? 1);
    if (!Number.isInteger(size) || size <= 0) throw new UsageError("--page-size must be a positive integer");
    if (!Number.isInteger(current) || current <= 0) throw new UsageError("--page must be a positive integer");
    return { mode: "Paginate", elementsPerPage: size, currentPage: current };
  }
  if (all) {
    // Unbounded must be explicit; the default is always bounded (AC-23.2). It is fetched a page at a
    // time (AC-23.3), so `All` is never what is sent for rows — see `runAllPages`.
    if (pageSize === undefined) return { mode: "All" };
    const size = Number(pageSize);
    if (!Number.isInteger(size) || size <= 0) throw new UsageError("--page-size must be a positive integer");
    return { mode: "All", elementsPerPage: size };
  }
  // Bounded, and counted: see DEFAULT_PAGE (#149). `--top` stays `Firsts`: the caller asked for n rows.
  return DEFAULT_PAGE;
}

/** `--filter-json <file|@file|->`: read through the one input reader (#120), so `-` is stdin. */
async function readFilterJson(source: string, input: InputReader): Promise<unknown[]> {
  // A bare value is a path, as it always was; a bad one is a clean usage error, never a raw ENOENT.
  const text = await input.read("filter-json", source, { bare: "path" });

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

/**
 * Walk lowered filters and replace any `ref:` handle with the real Lite key (AC-53.2).
 *
 * Done on the LOWERED wire shape rather than in the parser so it catches values from `--filter` and
 * `--filter-json` alike — the escape hatch must not be a hole in this.
 */
function resolveHandlesInFilters(
  filters: readonly FilterWire[],
  handles: Readonly<Record<string, string>>,
): FilterWire[] {
  const fixValue = (v: unknown): unknown => {
    if (typeof v === "string" && isHandle(v)) return resolveHandle(v, handles);
    if (Array.isArray(v)) return v.map(fixValue);
    return v;
  };
  return filters.map((f) => {
    const node = f as unknown as Record<string, unknown>;
    if (Array.isArray(node["filters"])) {
      return { ...node, filters: resolveHandlesInFilters(node["filters"] as FilterWire[], handles) } as FilterWire;
    }
    if ("value" in node) return { ...node, value: fixValue(node["value"]) } as FilterWire;
    return f;
  });
}

/** Names the data in a refusal message, and keeps the two `openData` calls in step. */
const DATA_KIND = "query results";

/**
 * The inputs that can be checked without a server: filters and pagination. Runs before the privacy
 * gate, so a mistake in the caller's own input is reported even under a detected agent.
 */
async function parseLocalInputs(ctx: Ctx): Promise<{
  groupEnabled: boolean; dslFilters: FilterWire[]; jsonFilters: FilterWire[]; pagination: unknown;
}> {
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

  // --filter-json is read HERE, beside the DSL parse, for the reason directly above: an unreadable
  // path or malformed JSON is a diagnostic about the caller's OWN input, not data, so it must not sit
  // behind the privacy gate. It also has to happen before token validation below, since #97 folds
  // the escape hatch's tokens into the same round trip as the DSL's.
  const filterJsonSource = opt(ctx, "filter-json");
  const jsonFilters = filterJsonSource !== undefined ? (await readFilterJson(filterJsonSource, inputReader(ctx.io)) as FilterWire[]) : [];

  // Pagination is validated HERE, beside the filter, because it is equally local: `--top abc` is
  // wrong whatever the server says. It used to be parsed while building the request, so an invalid
  // value was masked first by "no target application" and then by "no credential" — a user had to
  // fix two unrelated things before being told what was actually wrong with their command. Same
  // "two round trips of confusion" argument the filter already makes below.
  const pagination = parsePagination(ctx);
  return { groupEnabled, dslFilters, jsonFilters, pagination };
}

interface ColumnPlan {
  /** The columns as the caller named them, for placing the hoisted `Entity` column (AC-21.2). */
  requestedColumns: string[];
  orders: OrderSpec[];
  /** What is actually sent: the caller's columns, `--resolve`-rewritten, or the query's defaults. */
  effectiveColumns: string[];
  columnLabels: Record<string, string>;
  /** Columns holding an entity's id, mapped to its type, so each becomes that record's handle (#157). */
  idTypes: Record<string, string>;
}

/**
 * Validate every token the caller named and settle which columns to request. Needs the server, so
 * it runs after the gate.
 */
async function planColumns(
  ctx: Ctx,
  http: SignumHttp,
  queryKey: string,
  inputs: { groupEnabled: boolean; wantCount: boolean; filters: FilterWire[]; noColumns?: boolean },
): Promise<ColumnPlan> {
  const { groupEnabled, wantCount } = inputs;

  // AC-20.3: "--column selects columns by token … Omitted, the query's default columns are used."
  //
  // The second half was missing, and it made the core read path nearly useless: sending
  // `columns: []` does not mean "give me the defaults", it means "give me no columns". The server
  // then injects an entity column because the request has none
  // (`AutoDynamicQuery.cs:96-98`) and hoists it straight back out (`ResultTable.cs:55-56`), so
  // `signum query UserSkill --top 1` rendered a table with exactly one column — the Entity — and
  // nothing else. Found on the first live run against a real application.
  //
  // Named columns REPLACE the defaults rather than adding to them. The web client defaults to
  // ColumnOptionsMode "Add" (`Finder.tsx:362`), but `--column X` on a CLI plainly means "show me
  // X", and AC-20.3 says "selects".
  const requestedColumns = optAll(ctx, "column");
  const orders = parseOrders(optAll(ctx, "order"));
  const resolveLites = flag(ctx, "resolve");
  let effectiveColumns = requestedColumns;
  let columnLabels: Record<string, string> = {};
  let idTypes: Record<string, string> = {};

  // Validate EVERY token the caller named, before the request (AC-20.7, #95).
  //
  // This used to live inside the `--resolve` branch, because that path needed each token's
  // filterType and `parseTokens` supplies both type and validity at once. Validation was therefore
  // a side effect of an unrelated flag: without `--resolve` an invalid column reached the server and
  // came back as a generic 500-derived line, while adding `--resolve` produced a precise message
  // with the valid tokens listed. The same input, two different qualities of answer, decided by a
  // flag about labels.
  //
  // `--order` had no validation on any path — the issue's own guess, and correct.
  //
  // One request covers every slot, since parseTokens takes a list. Order tokens are validated
  // WITHOUT their `-` prefix: the minus is our descending marker, not part of the token.
  //
  // #97 added the third slot: tokens named in `--filter` and `--filter-json`, at every nesting
  // depth. They go LAST so the two positional reads below stay valid — `--resolve` takes the column
  // slice off the front, the filter kind check takes its own slice off the back.
  const filterTokens = collectFilterTokens(inputs.filters);
  const namedTokens = [...requestedColumns, ...orders.map((o) => o.token), ...filterTokens];
  let namedInfo: QueryTokenInfo[] = [];
  if (namedTokens.length > 0) {
    try {
      namedInfo = await validateTokens(http, queryKey, namedTokens);
    } catch (err) {
      // `--explain` sends nothing and must work without a credential, but parseTokens needs one
      // (QueryController is not [SignumAllowAnonymous]). Degrade with a note rather than fail, the
      // same treatment default-column resolution already gets below — never silently, so a preview
      // is never quietly weaker than the real thing.
      if (ctx.args.flags.explain && err instanceof NotAuthenticatedError) {
        ctx.io.err("note: could not validate the query's tokens (no credential); they are checked at execution.\n");
      } else {
        throw err;
      }
    }
  }

  // A token can pass parseTokens and still be illegal in a filter — validation runs with
  // SubTokensOptions.All, a filter with much less (see `filterUnusableReason`). Refuse those here
  // rather than let the server do it as a 500. Slice off the BACK, matching how filterTokens were
  // appended; empty when validation was skipped, which is the right no-op.
  const filterInfo = namedInfo.slice(requestedColumns.length + orders.length);
  for (const [idx, info] of filterInfo.entries()) {
    const reason = filterUnusableReason(info);
    if (reason === undefined) continue;
    // Report the token as the CALLER wrote it, not the server's resolved fullKey.
    const written = filterTokens[idx] ?? info.fullKey;
    throw new UsageError(`token '${written}' cannot be used in a filter: ${reason}`, {
      hint: "Restructure the filter to avoid it. Run `signum help filter` for the full syntax.",
    });
  }

  // A value the server cannot read as its token's type is a 500 there (FilterJsonConverter.cs:100),
  // though the mistake is the caller's: check it here, with the type parseTokens just gave us.
  const typeByToken = new Map(filterTokens.map((t, i) => [t, filterInfo[i]?.filterType]));
  const mismatch = findFilterValueMismatch(inputs.filters, (t) => typeByToken.get(t));
  if (mismatch !== undefined) {
    throw new UsageError(`filter on '${mismatch.token}' ${mismatch.problem}, got ${JSON.stringify(mismatch.value)}`, {
      hint: "Run `signum explain " + queryKey + "` to see each token's type, and `signum help filter` for value syntax.",
    });
  }

  // The column slice comes off the front, as for --resolve below (#157).
  idTypes = idColumnTypes(namedInfo.slice(0, requestedColumns.length));

  // --resolve needs the filterType of the COLUMN tokens, which the validation above already fetched.
  if (resolveLites && requestedColumns.length > 0 && namedInfo.length > 0) {
    const resolved = resolveLiteColumns(namedInfo.slice(0, requestedColumns.length));
    effectiveColumns = resolved.columns;
    columnLabels = resolved.labels;
  }

  if (requestedColumns.length === 0 && !groupEnabled && !wantCount && inputs.noColumns !== true) {
    // --group is excluded: a grouped query's columns are the grouping keys plus aggregates, which
    // only the caller can choose. Defaulting them would invent a query nobody asked for.
    try {
      const defaults = await fetchDefaultColumns(http, queryKey, ctx.io.env);
      idTypes = idColumnTypes(defaults);
      // The description already carries each column's filterType, so --resolve is free here.
      if (resolveLites) {
        const resolved = resolveLiteColumns(defaults);
        effectiveColumns = resolved.columns;
        columnLabels = resolved.labels;
      } else {
        effectiveColumns = defaults.map((c) => c.fullKey);
      }
    } catch (err) {
      // --explain must keep working without a credential, and this endpoint needs one
      // (QueryController is not [SignumAllowAnonymous]). Degrade rather than fail, and say so, so
      // the previewed request is never silently different from the one that would be sent.
      if (ctx.args.flags.explain) {
        ctx.io.err(
          "note: could not resolve this query's default columns, so the preview shows none.\n" +
          "They are resolved at execution time from api/query/description.\n",
        );
      } else {
        throw err;
      }
    }
  }

  return { requestedColumns, orders, effectiveColumns, columnLabels, idTypes };
}

/** `--count`: a single number, sent through the data boundary because it is derived from rows. */
async function runCount(ctx: Ctx, target: Target, queryKey: string, request: Record<string, unknown>): Promise<ExitCode> {
  const res = await target.http.request<unknown>({
    method: "POST",
    path: `api/query/queryValue/${encodeURIComponent(queryKey)}`,
    body: { ...request, valueToken: "Count" },
    lossless: true, // data, so exact — see the note in runTable
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

async function runTable(
  ctx: Ctx,
  target: Target,
  queryKey: string,
  request: Record<string, unknown>,
  plan: ColumnPlan,
): Promise<ExitCode> {
  const res = await target.http.request<RawResultTable>({
    method: "POST",
    path: `api/query/executeQuery/${encodeURIComponent(queryKey)}`,
    body: request,
    // Exact numbers (#111): `JSON.parse` would print an int64 id past 2^53 as a different record's
    // id, and mint it a handle that `get` — which reads exactly — would not match.
    lossless: true,
  });

  // The de-interning boundary: nothing downstream sees a raw row (AC-21.1). The requested
  // column order goes in so the hoisted `Entity` column comes back at the position the user
  // asked for, in every format (AC-21.2).
  const table = resolveResultTable(res.body, {
    requestedColumns: plan.requestedColumns, columnLabels: plan.columnLabels, idTypes: plan.idTypes,
    privacy: ctx.privacy,
  });

  // Handles kept before a byte is written, the disclosure after (emit.ts).
  emitData(ctx, DATA_KIND, { handles: table.mintedHandleDetails, pseudonymized: table.pseudonymized }, (out) =>
    renderResultTable(table, { format: ctx.format, write: out, warn: (line) => ctx.io.err(line + "\n"), color: ctx.color }));
  return ExitCode.Ok;
}

/** Rows per request when `--all` pages (AC-23.3); `--page-size` changes it. */
export const ALL_PAGE_SIZE = 1000;
/** From this many rows on, `--all` asks a person at a terminal before transferring them (AC-23.4). */
export const LARGE_RESULT = 10_000;

/** `--all` as it is sent: the given page of `Paginate`, which the server orders by key, so pages are stable. */
function allPage(request: Record<string, unknown>, size: number, page: number): Record<string, unknown> {
  return { ...request, pagination: { mode: "Paginate", elementsPerPage: size, currentPage: page } };
}

/**
 * `--all` (AC-23.3–23.5): page until the rows run out, writing each page as it arrives. The first
 * page carries the total, so a large result is confirmed before the rest is transferred, and a page
 * already written is never taken back: an interrupt stops between pages and closes the output, so
 * what reached stdout parses. `Paginate` costs the server a count per page; that is the price of a
 * result no single response has to hold.
 */
async function runAllPages(
  ctx: Ctx,
  target: Target,
  queryKey: string,
  request: Record<string, unknown>,
  plan: ColumnPlan,
  size: number,
): Promise<ExitCode> {
  const stream = streamData<ResolvedTable>(ctx, DATA_KIND, (out) =>
    streamResultTable({ format: ctx.format, write: out, warn: (line) => ctx.io.err(line + "\n"), color: ctx.color }));
  let shown = 0;
  let total: number | undefined;
  let changed = false;

  const finished = await interruptible(ctx, async (signal) => {
    try {
      for (let page = 1; ; page++) {
        const res = await target.http.request<RawResultTable>({
          method: "POST",
          path: `api/query/executeQuery/${encodeURIComponent(queryKey)}`,
          body: allPage(request, size, page),
          lossless: true, // see runTable
          signal,
        });
        const table = resolveResultTable(res.body, {
          requestedColumns: plan.requestedColumns, columnLabels: plan.columnLabels, idTypes: plan.idTypes,
          privacy: ctx.privacy,
        });
        if (page === 1) {
          total = table.totalElements;
          await confirmLargeResult(ctx, total, size);
        } else if (table.totalElements !== total) {
          changed = true;
        }
        stream.push({ handles: table.mintedHandleDetails, pseudonymized: table.pseudonymized }, table);
        shown += table.rows.length;
        if (table.rows.length < size || (table.totalElements !== undefined && shown >= table.totalElements)) return true;
        if (signal.aborted) return false;
      }
    } catch (err) {
      if (err instanceof InterruptedError) return false;
      throw err;
    }
  });
  stream.end();
  // Rows added or removed between pages shift the ones after them, so one may be missed or repeated.
  if (changed) ctx.io.err("\nwarning: the result changed while it was paged; a row may be missing or repeated\n");
  if (finished) return ExitCode.Ok;
  ctx.io.err(`\ninterrupted after ${shown} row${shown === 1 ? "" : "s"}; what was written is complete and valid\n`);
  return ExitCode.Interrupted;
}

/** AC-23.4: a person at a terminal is told how much is coming, and may stop it. A script asked for it. */
async function confirmLargeResult(ctx: Ctx, total: number | undefined, size: number): Promise<void> {
  if (total === undefined || total < LARGE_RESULT || flag(ctx, "yes") || flag(ctx, "y")) return;
  if (!ctx.io.stdoutIsTty || ctx.io.prompt === undefined) return;
  const pages = Math.ceil(total / size);
  const answer = await ctx.io.prompt(`--all will fetch ${total} rows in ${pages} request${pages === 1 ? "" : "s"}. Continue? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("not confirmed; nothing was printed", ExitCode.Usage, {
      hint: "Narrow it with --filter, take a part with --top, or count it first with --count.",
    });
  }
}

export async function runQuery(ctx: Ctx): Promise<ExitCode> {
  const queryKey = ctx.args.positionals[0];
  if (queryKey === undefined) {
    throw new UsageError("`query` needs a query key", {
      hint: "signum queries            list available queries\nsignum query Order --top 20",
    });
  }

  // Local diagnostics FIRST, before the privacy gate — see parseLocalInputs.
  const { groupEnabled, dslFilters, jsonFilters, pagination } = await parseLocalInputs(ctx);
  const variant = requestedVariant(ctx); // REQ-024: --lites / --entities, also local
  const variantCount = variant !== undefined ? countFrom(pagination) : null;

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

  // Needed before column resolution: a count transfers no rows, so it needs no columns.
  const wantCount = flag(ctx, "count");

  const plan = await planColumns(ctx, target.http, queryKey, {
    groupEnabled, wantCount, filters: [...dslFilters, ...jsonFilters], noColumns: variant !== undefined,
  });
  const { orders, effectiveColumns } = plan;

  const columns = effectiveColumns.map((token) => ({ token }));
  // DSL and --filter-json are combined by concatenation — both are ANDed at the top level,
  // matching the design's "may be combined" rule (design/filter-expression-syntax.md). Both were
  // read above, before the gate.
  // AC-53.2 again, for filter values: resolve handles locally before the request is built, so a
  // `ref:` never crosses the wire.
  const handles = loadHandles(ctx.io.env, ctx.target);
  const filters: FilterWire[] = resolveHandlesInFilters([...dslFilters, ...jsonFilters], handles);

  const request: Record<string, unknown> = variant !== undefined
    ? variantRequest(queryKey, filters, orders, variantCount)
    : { queryKey, groupResults: groupEnabled, filters, orders, columns, pagination };

  // REQ-078: print the command a HUMAN should run, and send nothing. Sits beside --explain because
  // it is the same shape of thing — emit a description instead of doing the work — and it lands
  // AFTER key validation so the command handed over is one that actually resolves.
  if (flag(ctx, "as-command")) {
    emitCommandEcho(ctx);
    return ExitCode.Ok;
  }

  // --explain prints the request and sends nothing (AC-20.6).
  if (ctx.args.flags.explain) {
    // Described by the client, so it shows what any request shows: headers, credentials redacted.
    const paged = pagesAll(request, variant, wantCount);
    renderDocument(
      target.http.describe({
        method: "POST", path: `api/query/${variant ?? (wantCount ? "queryValue" : "executeQuery")}/${queryKey}`,
        body: paged !== undefined ? allPage(request, paged, 1) : request,
      }),
      { format: ctx.format === "table" ? "json" : ctx.format, write: ctx.io.out },
    );
    if (paged !== undefined) ctx.io.err(`note: --all sends this once per page of ${paged}, currentPage 1, 2, … until the rows run out.\n`);
    return ExitCode.Ok;
  }

  if (variant !== undefined) return await runVariant(ctx, target, variant, request, DATA_KIND);
  if (wantCount) return await runCount(ctx, target, queryKey, request);
  const paged = pagesAll(request, variant, wantCount);
  return paged !== undefined
    ? await runAllPages(ctx, target, queryKey, request, plan, paged)
    : await runTable(ctx, target, queryKey, request, plan);
}

/** The page size when this request is rows under `--all`, which are fetched page by page; else undefined. */
function pagesAll(request: Record<string, unknown>, variant: string | undefined, wantCount: boolean): number | undefined {
  const p = request["pagination"] as { mode?: string; elementsPerPage?: number } | undefined;
  if (variant !== undefined || wantCount || p?.mode !== "All") return undefined;
  return p.elementsPerPage ?? ALL_PAGE_SIZE;
}
