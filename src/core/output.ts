/**
 * Output rendering.
 *
 * REQ-050 · STORY-22 · design/cli-surface.md §4
 *
 * TTY → table. Not a TTY → json. Explicit `-o` always wins (AC-22.1).
 * Data on stdout, diagnostics on stderr, always (AC-22.2).
 *
 * Every renderer consumes a `ResolvedTable`, so an un-de-interned row cannot reach output
 * (AC-21.1) — that is enforced by the brand in resulttable.ts, not by convention.
 */

import type { ResolvedTable } from "./resulttable.ts";
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
  for (const row of table.rows) lines.push(row.values.map((v) => csvEscape(scalar(v), sep)).join(sep));
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
    r.values.map((v) => {
      const s = scalar(v);
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
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      obj[c] = row.values[i] ?? null;
    });
    if (row.entity !== undefined) obj["Entity"] = row.entity;
    return obj;
  });
}

export interface RenderOptions {
  format: OutputFormat;
  /** Written to stdout. */
  write: (chunk: string) => void;
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

/** Render an arbitrary document (an entity, a help tree, a status object). */
export function renderDocument(value: unknown, opts: RenderOptions): void {
  if (opts.format === "ndjson") {
    opts.write(JSON.stringify(value) + "\n");
    return;
  }
  opts.write(JSON.stringify(value, null, 2) + "\n");
}
