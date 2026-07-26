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

/** A de-interned table. Only `resolveResultTable` can mint one. */
export interface ResolvedTable {
  readonly [RESOLVED]: true;
  readonly columns: readonly string[];
  readonly rows: readonly ResolvedRow[];
  /** Server-reported total, distinct from `rows.length` (AC-21.5). */
  readonly totalElements: number | undefined;
}

export interface ResolvedRow {
  /** The hoisted `Entity` column, when the query selected one. */
  readonly entity: unknown;
  readonly values: readonly unknown[];
}

function columnToken(col: NonNullable<RawResultTable["columns"]>[number], index: number): string {
  if (typeof col === "string") return col;
  return col.token ?? col.displayName ?? `column${index}`;
}

/**
 * De-intern a raw `ResultTable`.
 *
 * @throws CliError when an interned index is out of range — never silently null (AC-21.4).
 */
export function resolveResultTable(raw: RawResultTable): ResolvedTable {
  const columns = (raw.columns ?? []).map(columnToken);
  const uniqueValues = raw.uniqueValues ?? {};

  const rows: ResolvedRow[] = (raw.rows ?? []).map((row, rowIndex) => {
    const cells = row.columns ?? [];
    const values = columns.map((token, colIndex) => {
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

    return { entity: row.entity, values };
  });

  return {
    [RESOLVED]: true,
    columns,
    rows,
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
  return table.rows.some((r) => r.entity !== undefined);
}
