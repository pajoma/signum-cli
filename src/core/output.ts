/**
 * Output rendering.
 *
 * REQ-050 · STORY-22 · design/cli-surface.md §4
 *
 * TTY → table. Not a TTY → json. Explicit `-o` always wins (AC-22.1).
 * Data on stdout, diagnostics on stderr, always (AC-22.2).
 *
 * Every renderer consumes a `ResolvedTable`, so an un-de-interned row cannot reach output
 * (AC-21.1) — that is enforced by the brand in resulttable.ts, not by convention. Every
 * renderer also iterates `table.columns` and nothing else, so the reinserted `Entity` column
 * appears in the same place in every format (AC-21.2).
 *
 * Two writer types, deliberately: `renderResultTable`/`renderDataDocument` emit server DATA
 * and take a `DataWriter`, which only the ADR 0007 privacy gate mints; `renderDocument` emits
 * help, status, metadata and `--explain` previews and takes a plain writer. The split is the
 * data-output boundary (see policy.ts) — it is not a naming convention.
 */

import type { ResolvedTable } from "./resulttable.ts";
import { assertDataWriter, type DataWriter } from "./policy.ts";
import { UsageError } from "./errors.ts";

export const OUTPUT_FORMATS = ["table", "json", "csv", "tsv", "ndjson", "name"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function parseOutputFormat(value: string): OutputFormat {
  const v = value.trim().toLowerCase();
  if ((OUTPUT_FORMATS as readonly string[]).includes(v)) return v as OutputFormat;
  throw new UsageError(`unknown output format '${value}'`, {
    hint: `Valid formats: ${OUTPUT_FORMATS.join(", ")}.`,
  });
}

/** Resolve the effective format: explicit flag wins, else TTY decides (AC-22.1). */
export function effectiveFormat(explicit: OutputFormat | undefined, stdoutIsTty: boolean): OutputFormat {
  if (explicit !== undefined) return explicit;
  return stdoutIsTty ? "table" : "json";
}

export function colorEnabled(stdoutIsTty: boolean, noColorFlag: boolean, env = process.env): boolean {
  if (noColorFlag) return false;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false; // AC-22.3
  return stdoutIsTty;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The human-readable label of a Lite or entity, mirroring the framework's own renderer
 * (`Signum.Entities.ts:194-224` `getToString`) in the same order:
 *
 *   1. `entity` present  -> that entity's own label
 *   2. `model` a string  -> the model (the common case for a query result)
 *   3. `model` an object -> that model's label
 *   4. otherwise         -> undefined; the caller falls back to the key
 *
 * Note there is **no `toStr` on a Lite** — `LiteJsonConverter.cs:23-67` writes `EntityType`, `id`,
 * an optional `model` and an optional `entity`, and nothing else. (An earlier version of this file
 * assumed `toStr`, which came from a hand-written test fixture rather than from the framework.)
 * `toStr` does exist on a full **entity**, which is why step 1 finds it.
 */
function entityLabel(v: unknown): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;

  const inner = o["entity"];
  if (inner !== null && inner !== undefined && typeof inner === "object") {
    const t = (inner as Record<string, unknown>)["toStr"];
    if (typeof t === "string" && t !== "") return t;
  }

  const model = o["model"];
  if (typeof model === "string" && model !== "") return model;
  if (model !== null && model !== undefined && typeof model === "object") {
    const t = (model as Record<string, unknown>)["toStr"];
    if (typeof t === "string" && t !== "") return t;
  }

  const own = o["toStr"];
  if (typeof own === "string" && own !== "") return own;

  return undefined;
}

/**
 * One cell of a FLAT format (table, csv, tsv).
 *
 * A `Lite<T>` has no flat representation except a key or a label, and which one is useful depends
 * on WHICH column it is:
 *
 *   • the reinserted `Entity` column is the row's identity — its value is that you can paste it
 *     into `signum get "Order;42"`, and `-o name` emits exactly that. Always the key.
 *   • any other entity-valued column (`User`, `Skill`, …) is being read, not actioned. `User;102`
 *     tells a human nothing; the label does. Prefer the label, fall back to the key.
 *
 * Serializing the object instead (`"{""EntityType"":""Order"",""id"":42,…}"`, truncated to nothing
 * useful in a table) preserves the identity while making it unusable. json/ndjson keep the full
 * object — a structured format loses nothing by staying structured.
 */
function flatCell(v: unknown, isEntityColumn: boolean): string {
  if (isEntityColumn) return liteKey(v) ?? scalar(v);
  return entityLabel(v) ?? liteKey(v) ?? scalar(v);
}

/** Lite keys are `TypeName;id`; `-o name` emits them bare for piping. */
function liteKey(entity: unknown): string | undefined {
  if (entity === null || typeof entity !== "object") return undefined;
  const e = entity as Record<string, unknown>;
  const type = e["EntityType"] ?? e["Type"];
  const id = e["id"];
  if (typeof type === "string" && (typeof id === "string" || typeof id === "number")) {
    return `${type};${id}`;
  }
  return undefined;
}

function csvEscape(s: string, sep: string): string {
  return s.includes(sep) || s.includes('"') || s.includes("\n") ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Header-only line, for the delimited empty-result case (QA finding — see below). */
function delimitedHeader(table: ResolvedTable, sep: string): string {
  return table.columns.map((c) => csvEscape(c, sep)).join(sep) + "\n";
}

function delimited(table: ResolvedTable, sep: string): string {
  const lines = [delimitedHeader(table, sep).slice(0, -1)]; // header, without its own trailing \n yet
  for (const row of table.rows) {
    lines.push(
      row.values.map((v, i) => csvEscape(flatCell(v, i === table.entityIndex), sep)).join(sep),
    );
  }
  return lines.join("\n") + "\n";
}

const MAX_CELL = 60;

/** Bold, applied only to the header and separator — the minimal, safe reading of "with colour". */
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function renderTable(table: ResolvedTable, color: boolean): string {
  if (table.rows.length === 0) return "";
  // Truncation applies ONLY to the human table form; machine formats are never truncated (AC-22.4).
  const cells = table.rows.map((r) =>
    r.values.map((v, i) => {
      const s = flatCell(v, i === table.entityIndex);
      return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + "…" : s;
    }),
  );
  const widths = table.columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? "").length)),
  );
  const line = (vals: readonly string[]) =>
    vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const headerLine = line(table.columns);
  const sepLine = widths.map((w) => "-".repeat(w)).join("  ");
  return [
    color ? `${BOLD}${headerLine}${RESET}` : headerLine,
    sepLine,
    ...cells.map(line),
  ].join("\n") + "\n";
}

function toObjects(table: ResolvedTable): Array<Record<string, unknown>> {
  // `Entity` is already in `table.columns` at its declared position (AC-21.2), so it is emitted
  // by the loop like any other column. It used to be appended here afterwards, which put it
  // last in JSON and left it out of table/csv/tsv entirely.
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      obj[c] = row.values[i] ?? null;
    });
    return obj;
  });
}

/** Options for the non-data renderers (help, status, metadata, `--explain`). */
export interface DocumentOptions {
  format: OutputFormat;
  /** Written to stdout. */
  write: (chunk: string) => void;
}

export interface RenderOptions {
  format: OutputFormat;
  /**
   * Written to stdout. A `DataWriter` proves the ADR 0007 gate ran — see policy.ts. Rows are
   * server data, so there is no ungated way to render them.
   */
  write: DataWriter;
  /** Written to stderr — diagnostics only. */
  warn?: (line: string) => void;
  /**
   * Applies ONLY to `table` format (AC-22.1). Every other format ignores it outright — colour
   * in JSON/CSV/NDJSON would corrupt machine-readable output, so this is enforced structurally
   * rather than left as a caller convention (see the "color:true on json" test).
   */
  color?: boolean;
}

export function renderResultTable(table: ResolvedTable, opts: RenderOptions): void {
  const { format, write } = opts;
  assertDataWriter(write); // the half of the boundary that survives type erasure

  if (table.rows.length === 0) {
    // Empty is success; humans get a note on stderr, machines get an empty structure (AC-22.6).
    // csv/tsv are a partial exception: a CSV file conventionally always has a header row, so
    // omitting it entirely (QA finding — previously zero bytes written, indistinguishable from
    // a crashed command) is corrected here. ndjson/name genuinely have nothing to say for zero
    // rows — an empty stream IS the correct signal for those formats, so they stay silent.
    if (format === "table") opts.warn?.("no rows");
    else if (format === "json") write("[]\n");
    else if (format === "csv") write(delimitedHeader(table, ","));
    else if (format === "tsv") write(delimitedHeader(table, "\t"));
    return;
  }

  switch (format) {
    case "table":
      write(renderTable(table, opts.color === true));
      break;
    case "json":
      write(JSON.stringify(toObjects(table), null, 2) + "\n");
      break;
    case "ndjson":
      // Streams one row per line; nothing buffers (AC-22.5).
      for (const obj of toObjects(table)) write(JSON.stringify(obj) + "\n");
      break;
    case "csv":
      write(delimited(table, ","));
      break;
    case "tsv":
      write(delimited(table, "\t"));
      break;
    case "name": {
      let emitted = 0;
      for (const row of table.rows) {
        const key = liteKey(row.entity);
        if (key !== undefined) {
          write(key + "\n");
          emitted++;
        }
      }
      if (emitted === 0) {
        opts.warn?.("no Lite keys in result — add the 'Entity' column to use -o name");
      }
      break;
    }
  }
}

/**
 * Render a NON-DATA document: a help tree, a status report, a metadata listing, an `--explain`
 * preview. Nothing here originates as customer records, so it takes a plain writer.
 */
export function renderDocument(value: unknown, opts: DocumentOptions): void {
  writeDocument(value, opts.format, opts.write);
}

/**
 * Render a document that IS server data — an entity from `get`, an existence answer. Same
 * rendering as `renderDocument`, different door: it takes a gated `DataWriter` (ADR 0007).
 */
export function renderDataDocument(value: unknown, opts: { format: OutputFormat; write: DataWriter }): void {
  assertDataWriter(opts.write);
  writeDocument(value, opts.format, opts.write);
}

function writeDocument(value: unknown, format: OutputFormat, write: (chunk: string) => void): void {
  if (format === "ndjson") {
    write(JSON.stringify(value) + "\n");
    return;
  }
  write(JSON.stringify(value, null, 2) + "\n");
}
