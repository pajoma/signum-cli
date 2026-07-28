/**
 * ResultTable de-interning.
 *
 * REQ-022 · STORY-21 · AC-21.1..21.5
 *
 * The correctness-critical layer. `rows[i].columns[j]` may be an INDEX into
 * `uniqueValues[token]` rather than a value (`ResultTableConverter.cs:71-78`), and the
 * `Entity` column is hoisted out into `rows[i].entity`. Rendering a raw row emits
 * plausible-looking wrong data — the worst failure mode for a tool people script against.
 *
 * Both distortions are undone HERE, in one place, so no renderer has to know about either
 * (AC-21.1). In particular the hoisted `Entity` is put back into `columns`/`values` at the
 * position the user asked for (AC-21.2) — a renderer that iterates `columns` therefore emits
 * the requested shape, and no format can quietly drop or relocate it.
 *
 * Because TypeScript types erase at runtime (ADR 0006 cost 5), the guarantee here is
 * structural rather than compile-only: `ResolvedTable` carries a brand that ONLY
 * `resolveResultTable` can produce, so a renderer cannot accept a raw payload by mistake.
 * The release-blocking tests in test/resulttable.test.ts are the other half.
 */

import { CliError, ExitCode } from "./errors.ts";

/** Raw wire shape of `ResultTable`, exactly as the server sends it. */
export interface RawResultTable {
  columns?: Array<{ token?: string; displayName?: string } | string>;
  uniqueValues?: Record<string, unknown[]>;
  rows?: Array<{ entity?: unknown; columns?: unknown[] }>;
  totalElements?: number;
  pagination?: unknown;
}

/**
 * Runtime brand. Deliberately a real symbol rather than a phantom type: a phantom brand
 * erases at compile time, whereas this cannot be forged by `JSON.parse`, so
 * `isResolvedTable` is a genuine runtime check rather than a promise.
 */
const RESOLVED: unique symbol = Symbol("signum.resolvedResultTable");

/**
 * A de-interned table. Only `resolveResultTable` can mint one.
 *
 * `columns` is the CANONICAL shape: the server's own column list with the hoisted `Entity`
 * column put back at its declared position. `rows[i].values` is index-aligned with it. Every
 * renderer consumes exactly this and nothing else.
 */
export interface ResolvedTable {
  readonly [RESOLVED]: true;
  readonly columns: readonly string[];
  readonly rows: readonly ResolvedRow[];
  /** Index into `columns`/`values` of the reinserted `Entity` column, when there is one. */
  readonly entityIndex: number | undefined;
  /** Server-reported total, distinct from `rows.length` (AC-21.5). */
  readonly totalElements: number | undefined;
}

export interface ResolvedRow {
  /**
   * The hoisted `Entity` column, when the query selected one. Also present in `values` at
   * `table.entityIndex` — this is a convenience for `-o name`, not a second source of truth.
   */
  readonly entity: unknown;
  readonly values: readonly unknown[];
}

/** The entity column's token is exactly this (`QueryDescription.cs:17` — `ColumnDescription.Entity`). */
export const ENTITY_TOKEN = "Entity";

export interface ResolveOptions {
  /**
   * The `columns` tokens sent in the request, in request order. Used solely to place the
   * hoisted `Entity` column back where the user asked for it (AC-21.2). Omit it — or send no
   * explicit columns — and `Entity` goes first, which is the framework's own reconstruction
   * order (`ResultTable.AllColumns()` = `Columns.PreAnd(entityColumn)`).
   */
  requestedColumns?: readonly string[] | undefined;
  /**
   * Display name overrides, keyed by the token actually sent. `--resolve` rewrites an entity
   * column to `User.ToString` so the server returns a label; the reader still asked about `User`
   * and the header should say so. Only the columns the CLI itself rewrote appear here, so an
   * explicit `--column User.ToString` keeps its own name and cannot collide with a `User` column.
   */
  columnLabels?: Readonly<Record<string, string>> | undefined;
}

function columnToken(col: NonNullable<RawResultTable["columns"]>[number], index: number): string {
  if (typeof col === "string") return col;
  return col.token ?? col.displayName ?? `column${index}`;
}

function isEntityToken(token: string): boolean {
  return token.toLowerCase() === ENTITY_TOKEN.toLowerCase();
}

/**
 * Where the hoisted `Entity` column belongs in the server's column list.
 *
 * Anchored on `Entity`'s nearest surviving PREDECESSOR — insert just after it — rather than on
 * `Entity`'s own index in the request. Two things make the request index alone wrong: the server
 * may drop a requested column it will not disclose (`ResultTable`'s constructor filters on
 * `Token.IsAllowed()`), and it is the server's `columns` array, not the request, that fixes the
 * order of everything else. Anchoring keeps `Entity` next to the column the caller put it next
 * to even when those two disagree. No surviving predecessor means it goes first, which is also
 * the no-request-order default.
 */
function entityPosition(serverColumns: readonly string[], requested: readonly string[] | undefined): number {
  if (requested === undefined) return 0;
  const at = requested.findIndex(isEntityToken);
  if (at === -1) return 0;
  const lower = serverColumns.map((c) => c.toLowerCase());
  for (let i = at - 1; i >= 0; i--) {
    const found = lower.indexOf((requested[i] as string).toLowerCase());
    if (found !== -1) return found + 1;
  }
  return 0;
}

/**
 * De-intern a raw `ResultTable` and restore its declared column shape.
 *
 * @throws CliError when an interned index is out of range — never silently null (AC-21.4).
 */
export function resolveResultTable(raw: RawResultTable, options: ResolveOptions = {}): ResolvedTable {
  const labels = options.columnLabels ?? {};
  const serverColumns = (raw.columns ?? []).map(columnToken).map((c) => labels[c] ?? c);
  const uniqueValues = raw.uniqueValues ?? {};
  const rawRows = raw.rows ?? [];

  // The converter writes `entity` on every row, and only when `rt.EntityColumn != null`
  // (`ResultTableConverter.cs:61-65`) — so one row carrying the key settles it for the table.
  // With `--group` the server keeps entity columns inline and hoists nothing, which this
  // correctly reads as "no hoisted column".
  const hoisted =
    rawRows.some((row) => row !== null && typeof row === "object" && "entity" in row) ||
    (options.requestedColumns?.some(isEntityToken) ?? false);

  const entityIndex = hoisted ? entityPosition(serverColumns, options.requestedColumns) : undefined;

  const columns = entityIndex === undefined
    ? serverColumns
    : [...serverColumns.slice(0, entityIndex), ENTITY_TOKEN, ...serverColumns.slice(entityIndex)];

  const rows: ResolvedRow[] = rawRows.map((row, rowIndex) => {
    const cells = row.columns ?? [];
    const resolved = serverColumns.map((token, colIndex) => {
      const cell = cells[colIndex];
      const pool = uniqueValues[token];

      // A column is interned only when the server supplied a pool for that token.
      if (pool !== undefined) {
        if (cell === null || cell === undefined) return null;
        if (typeof cell !== "number" || !Number.isInteger(cell)) {
          throw new CliError(
            `row ${rowIndex}, column '${token}': expected an intern index but got ${typeof cell}`,
            ExitCode.Unexpected,
            { hint: "The server's ResultTable shape is not what this version of signum expects." },
          );
        }
        if (cell < 0 || cell >= pool.length) {
          throw new CliError(
            `row ${rowIndex}, column '${token}': intern index ${cell} is out of range (pool has ${pool.length})`,
            ExitCode.Unexpected,
            { hint: "This indicates a corrupt or unexpected response; the value is NOT being rendered as blank." },
          );
        }
        return pool[cell] ?? null;
      }

      return cell ?? null;
    });

    // Reinsertion happens here, once, so `values` is index-aligned with `columns` for every
    // renderer. `row.entity` is `null` rather than `undefined` when absent, because a hole in
    // a values array must be a value — `undefined` would serialize away in JSON.
    const entity = "entity" in row ? row.entity : null;
    const values = entityIndex === undefined
      ? resolved
      : [...resolved.slice(0, entityIndex), entity, ...resolved.slice(entityIndex)];

    return { entity, values };
  });

  return {
    [RESOLVED]: true,
    columns,
    rows,
    entityIndex,
    totalElements: raw.totalElements,
  };
}

/**
 * Runtime guard, so a renderer can assert rather than trust its caller (AC-21.1).
 * This is the half of the ADR 0006 mitigation that survives type erasure.
 */
export function isResolvedTable(value: unknown): value is ResolvedTable {
  return value !== null && typeof value === "object" && (value as Record<PropertyKey, unknown>)[RESOLVED] === true;
}

/** True when the query selected an `Entity` column, which the server hoists (AC-21.2). */
export function hasEntityColumn(table: ResolvedTable): boolean {
  return table.entityIndex !== undefined;
}
