/**
 * Query tokens as data: their shape, and the rules about them that need no server — which column is
 * an entity's id, which tokens a filter may not use, which columns a query shows by default, the
 * nearest names to a typo. Pure, so the result-table layer can depend on it without depending on
 * HTTP; the requests that fetch tokens live in `token-requests.ts`.
 *
 * REQ-012 · STORY-24 (AC-24.2, AC-24.7) · STORY-63 (AC-63.1)
 */

import { editDistance } from "./text.ts";

/** The entity column's token is exactly this (`QueryDescription.cs:17` — `ColumnDescription.Entity`). */
export const ENTITY_TOKEN = "Entity";

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
  /** `PropertyRoute.ToString()`, e.g. `(Customer).Name`, when the token maps to one. */
  propertyRoute: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function parseToken(raw: unknown): QueryTokenInfo {
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
    propertyRoute: str(t["propertyRoute"]),
  };
}

/**
 * The entity type whose id each column holds, keyed by the column's token (#157).
 *
 * Read from the property route, not the token path: the id token's route is
 * `PropertyRoute.Root(parent type).Add(Id)` (`EntityPropertyToken.cs:13-16`), which prints as
 * `(Customer).Id` with the type's CLEAN name (`PropertyRoute.cs:272-275`) — the same name a Lite
 * carries as `EntityType`. A query column declared as `e.Id` maps to the same route. So the type
 * comes from the server, whatever the path to it, and a column whose route names no single type
 * (an ImplementedByAll parent) is simply absent here.
 */
export function idColumnTypes(columns: readonly QueryTokenInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    const type = /^\(([^()]+)\)\.Id$/.exec(c.propertyRoute ?? "")?.[1];
    if (type !== undefined) out[c.fullKey] = type;
  }
  return out;
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

/** Every column a description lists, its two injected pseudo-tokens included. */
export function descriptionColumns(body: unknown): QueryTokenInfo[] {
  if (body === null || typeof body !== "object") return [];
  const columns = (body as Record<string, unknown>)["columns"];
  if (columns === null || typeof columns !== "object") return [];
  return Object.values(columns as Record<string, unknown>).map(parseToken).filter((t) => t.fullKey !== "");
}

/** The columns a query shows when none are named: the web client's own rule, quoted above. */
export function defaultColumns(columns: readonly QueryTokenInfo[]): QueryTokenInfo[] {
  return columns
    .filter((t) => t.fullKey !== ENTITY_TOKEN)
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
