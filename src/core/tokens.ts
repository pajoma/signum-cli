/**
 * Live query-token discovery and validation.
 *
 * REQ-012 · STORY-24 (AC-24.2, AC-24.7) · STORY-63 (AC-63.1)
 *
 * Verified against `Signum/API/Controllers/QueryController.cs:59-93`:
 *
 *   POST api/query/subTokens    { queryKey, token?: string | null }  → QueryTokenTS[]
 *   POST api/query/parseTokens  { queryKey, tokens: string[] }       → QueryTokenTS[]
 *
 * Both resolve with `SubTokensOptions.All` (`:82-86`, `:65`), and `parseTokens` returns each
 * token `withParents: true` so the whole chain comes back, not just the leaf.
 *
 * Three things that are NOT in docs/http-api.md and that this module exists to handle:
 *
 *   1. `QueryController` carries no `[SignumAllowAnonymous]` — unlike `api/reflection/types`,
 *      token discovery REQUIRES a credential. Discovery is not uniformly anonymous.
 *   2. An unknown token throws `FormatException` (`QueryUtils.cs:385,390`), which the exception
 *      filter maps to **HTTP 500** (`SignumExceptionFilterAttribute.cs:131-146` has no arm for
 *      it). A user's typo therefore arrives looking exactly like a server crash, and must not be
 *      reported as one.
 *   3. `subTokens` offers `.Nested` because it passes `SubTokensOptions.All`, but filter parsing
 *      never passes `CanNested` (`FilterJsonConverter.cs:87,133`) — so the server will suggest a
 *      token it then refuses in `executeQuery` (AC-24.7).
 */

import type { SignumHttp } from "./http.ts";
import { CliError, UsageError, ValidationError } from "./errors.ts";
import { ENTITY_TOKEN } from "./resulttable.ts";
import { editDistance } from "./text.ts";

/** `QueryTokenType` (`QueryController.cs:274-286`). Absent for an ordinary column token. */
export type QueryTokenKind =
  | "Aggregate" | "Element" | "AnyOrAll" | "OperationContainer" | "ToArray"
  | "Manual" | "Nested" | "Snippet" | "TimeSeries" | "IndexerContainer";

/** The subset of `QueryTokenTS` this CLI reads. The wire type carries more; we ignore it. */
export interface QueryTokenInfo {
  /** The final segment. */
  key: string;
  /** The whole dotted path, which is what goes on the wire in a filter/column/order. */
  fullKey: string;
  niceName: string | undefined;
  toStr: string | undefined;
  kind: QueryTokenKind | undefined;
  /** `TypeReferenceTS.name`, when the server described one. */
  type: string | undefined;
  filterType: string | undefined;
  isGroupable: boolean;
  /** `.Nested` is offered here but rejected by executeQuery — see the header (AC-24.7). */
  usableInQuery: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function parseToken(raw: unknown): QueryTokenInfo {
  const t = (raw ?? {}) as Record<string, unknown>;
  const kind = str(t["queryTokenType"]) as QueryTokenKind | undefined;
  const typeRef = t["type"];
  return {
    key: str(t["key"]) ?? "",
    fullKey: str(t["fullKey"]) ?? str(t["key"]) ?? "",
    niceName: str(t["niceName"]),
    toStr: str(t["toStr"]),
    kind,
    type: typeRef !== null && typeof typeRef === "object"
      ? str((typeRef as Record<string, unknown>)["name"])
      : str(typeRef),
    filterType: str(t["filterType"]),
    isGroupable: t["isGroupable"] === true,
    usableInQuery: kind !== "Nested",
  };
}

function parseList(body: unknown): QueryTokenInfo[] {
  if (!Array.isArray(body)) return [];
  return body.map(parseToken).filter((t) => t.fullKey !== "");
}

/**
 * The SERVER rejected a token we sent — a usage problem, not a server fault.
 *
 * `http.ts` already turns a `FormatException` 500 into a `ValidationError`, which is the general
 * case. The message match is a second route for a deployment whose exception filter has been
 * customised to return some other status for the same throw: the wording comes from
 * `QueryUtils.cs:385,390` and is stable across both.
 */
function isTokenRejection(err: unknown): err is CliError {
  if (!(err instanceof CliError)) return false;
  if (err instanceof ValidationError) return true;
  return /FormatException|not found on (query|token)/i.test(err.message);
}

/** Continuations of `token`, or the query's root tokens when `token` is undefined (AC-24.2). */
export async function fetchSubTokens(
  http: SignumHttp,
  queryKey: string,
  token?: string | undefined,
): Promise<QueryTokenInfo[]> {
  const res = await http.request<unknown>({
    method: "POST",
    path: "api/query/subTokens",
    // `token` is nullable on the wire (`SubTokensRequest.token`), and null is what asks for the
    // query's own root columns rather than a continuation.
    body: { queryKey, token: token ?? null },
  });
  return parseList(res.body);
}

/**
 * Validate full token paths (AC-24.2). Returns the resolved leaves, in request order.
 *
 * A rejection is re-raised as a usage error carrying the server's own message — which names both
 * the offending segment and the token it was not found on — plus, where we can get them, the
 * valid continuations at the point it broke (AC-63.1).
 */
export async function validateTokens(
  http: SignumHttp,
  queryKey: string,
  tokens: readonly string[],
): Promise<QueryTokenInfo[]> {
  try {
    const res = await http.request<unknown>({
      method: "POST",
      path: "api/query/parseTokens",
      body: { queryKey, tokens: [...tokens] },
    });
    return parseList(res.body);
  } catch (err) {
    if (!isTokenRejection(err)) throw err;
    throw await explainRejection(http, queryKey, tokens, err);
  }
}

/**
 * Turn "Token with key 'X' not found on token 'Y'" into something actionable: re-ask the server
 * what IS valid at `Y` and offer the near matches. Costs one extra round trip, on a path that
 * has already failed, which is the right moment to spend one.
 */
async function explainRejection(
  http: SignumHttp,
  queryKey: string,
  tokens: readonly string[],
  err: CliError,
): Promise<UsageError> {
  const failed = /key '([^']+)' not found on token '([^']+)'/.exec(err.message);
  const firstSegment = /Column '([^']+)' not found on query/.exec(err.message);

  let hint = "Run `signum explain " + queryKey + "` to see this query's tokens.";
  const wanted = failed?.[1] ?? firstSegment?.[1];
  const parent = failed?.[2];

  try {
    const valid = await fetchSubTokens(http, queryKey, parent);
    const near = wanted !== undefined ? nearestTokens(wanted, valid) : [];
    if (near.length > 0) {
      hint = `Did you mean: ${near.join(", ")}?\n` + hint;
    } else if (valid.length > 0) {
      const shown = valid.slice(0, 12).map((t) => t.key);
      hint = `Valid here: ${shown.join(", ")}${valid.length > shown.length ? ", …" : ""}\n` + hint;
    }
  } catch {
    // The suggestion lookup is a courtesy. If it fails we still report the real error, which is
    // the server's own and already names the offending segment.
  }

  return new UsageError(
    `invalid query token${tokens.length === 1 ? ` '${tokens[0] as string}'` : ""}: ${err.message}`,
    { hint },
  );
}

/**
 * Near matches by edit distance, not substring containment — the same reasoning as
 * `suggestTypes`: containment cannot suggest `Customer` for `Custmer`, which is the typo
 * people actually make.
 */
export function nearestTokens(wanted: string, candidates: readonly QueryTokenInfo[], limit = 5): string[] {
  const target = wanted.toLowerCase();
  const scored: Array<{ key: string; score: number }> = [];
  for (const c of candidates) {
    const key = c.key.toLowerCase();
    let score: number;
    if (key.includes(target) || target.includes(key)) score = 0;
    else {
      score = editDistance(target, key);
      if (score > Math.max(2, Math.floor(key.length / 3))) continue;
    }
    scored.push({ key: c.key, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((s) => s.key);
}

/**
 * The query's DEFAULT columns, for when the caller named none (AC-20.3).
 *
 * `GET api/query/description/{queryKey}` returns `QueryDescriptionTS { queryKey, columns }`, where
 * `columns` is a dictionary of every column the query exposes plus two injected pseudo-tokens
 * (`QueryController.cs:139-158`: an `AggregateToken` for Count and a `TimeSeriesToken`).
 *
 * The filter below is the framework's own definition, transcribed from `Finder.tsx:383-387`:
 *
 *     Dic.getValues(qd.columns).filter(a => a.fullKey != "Entity"
 *        && a.queryTokenType != "Aggregate" && a.queryTokenType != "TimeSeries")
 *
 * Dropping `Entity` is safe and deliberate: the server re-adds an entity column when the request
 * carries none (`AutoDynamicQuery.cs:96-98`), then hoists it back out of `columns`
 * (`ResultTable.cs:55-56`). So the rows still arrive with their identity attached — which is
 * exactly what the web client relies on.
 *
 * Requires a credential: `QueryController` carries no `[SignumAllowAnonymous]`.
 */
export async function fetchDefaultColumns(
  http: SignumHttp,
  queryKey: string,
): Promise<QueryTokenInfo[]> {
  const res = await http.request<unknown>({
    method: "GET",
    path: `api/query/description/${encodeURIComponent(queryKey)}`,
  });

  const body = res.body;
  if (body === null || typeof body !== "object") return [];
  const columns = (body as Record<string, unknown>)["columns"];
  if (columns === null || typeof columns !== "object") return [];

  return Object.values(columns as Record<string, unknown>)
    .map(parseToken)
    .filter((t) => t.fullKey !== "" && t.fullKey !== ENTITY_TOKEN)
    .filter((t) => t.kind !== "Aggregate" && t.kind !== "TimeSeries");
}

/**
 * Why a token that `parseTokens` accepted is still illegal in a FILTER (#97, AC-24.7).
 *
 * `parseTokens` resolves with `SubTokensOptions.All` (`QueryController.cs:65`), but a filter is
 * parsed with a strictly narrower set — `CanElement | CanAnyAll`, plus `CanAggregate` only when
 * `groupResults` is true and `CanTimeSeries` only for a time-series query
 * (`FilterJsonConverter.cs:87`, `:133`). So validation is a SUPERSET of what filters allow: passing
 * it proves the path exists, not that a filter may use it.
 *
 * The kinds below are absent from the filter option set unconditionally, so they can be refused
 * locally with a precise message instead of arriving as the generic 500. `Aggregate` and
 * `TimeSeries` are deliberately NOT here: both are conditionally legal, and `--group` is already
 * enforced against aggregates by `filter.ts`'s own `validateToken`.
 *
 * This is the same trap AC-24.7 names for `.Nested` — `filter.ts` catches that one by name for the
 * DSL, but `--filter-json` bypassed it, so the hole was open on exactly the path that gets the
 * least checking.
 */
export function filterUnusableReason(info: QueryTokenInfo): string | undefined {
  switch (info.kind) {
    case "Nested":
      return "'.Nested' is discoverable via metadata but rejected in a query filter";
    case "ToArray":
      return "a '.ToArray' token may be used as a column but not in a filter";
    case "Snippet":
      return "a snippet token may be used as a column but not in a filter";
    case "OperationContainer":
      return "an operation token may be used as a column but not in a filter";
    case "Manual":
      return "a manual token may be used as a column but not in a filter";
    default:
      return undefined;
  }
}

/** The server-side token that renders an entity as its label (`EntityToStringToken.Key`). */
export const TO_STRING_TOKEN = "ToString";

/**
 * Rewrite entity-valued columns to their label, for `--resolve` (`AC-20.3` ergonomics).
 *
 * A column whose `filterType` is `Lite` arrives as `{EntityType, id}` and renders as `User;102`,
 * which tells a human nothing. Appending `.ToString` asks the SERVER for the label instead —
 * `EntityToStringToken` (`Key == "ToString"`) — so it costs no extra requests and no N+1: the label
 * is resolved in the same query, by the database.
 *
 * The `Entity` column is left alone deliberately: it is the row's identity, and its whole value is
 * that it pastes into `signum get`.
 */
export function resolveLiteColumns(
  columns: readonly QueryTokenInfo[],
): { columns: string[]; labels: Record<string, string> } {
  const labels: Record<string, string> = {};
  const out = columns.map((c) => {
    if (c.filterType !== "Lite" || c.fullKey === ENTITY_TOKEN) return c.fullKey;
    const rewritten = `${c.fullKey}.${TO_STRING_TOKEN}`;
    // The reader asked about `User`, not `User.ToString`; the header should say what they asked.
    labels[rewritten] = c.fullKey;
    return rewritten;
  });
  return { columns: out, labels };
}
