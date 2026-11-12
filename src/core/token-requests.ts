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
import { saveQueryDescription } from "./metadata-cache.ts";
import { defaultColumns, descriptionColumns, nearestTokens, parseToken, type QueryTokenInfo } from "./tokens.ts";

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
  /** False where the tokens ARE the answer (`signum explain Order.Entity`), so --explain shows the call. */
  prepare = true,
): Promise<QueryTokenInfo[]> {
  const res = await http.request<unknown>({
    method: "POST",
    path: "api/query/subTokens",
    prepare,
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
      prepare: true, // validating the caller's tokens is building the request
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
  env?: NodeJS.ProcessEnv,
): Promise<QueryTokenInfo[]> {
  return defaultColumns(descriptionColumns(await fetchQueryDescription(http, queryKey, env)));
}

/** The description, fetched live; it refreshes the copy help reads offline (AC-61.3). */
export async function fetchQueryDescription(http: SignumHttp, queryKey: string, env?: NodeJS.ProcessEnv): Promise<unknown> {
  const res = await http.request<unknown>({
    method: "GET",
    path: `api/query/description/${encodeURIComponent(queryKey)}`,
    prepare: true, // the default columns are part of the request being built
  });
  saveQueryDescription(http.baseUrl, queryKey, res.body, env);
  return res.body;
}
