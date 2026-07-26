/**
 * Output rendering.
 *
 * REQ-050 · STORY-22 · AC-22.1 (colour), AC-22.6 (empty results)
 *
 * QA findings this file locks in:
 *   - csv/tsv on an empty result previously wrote ZERO bytes — no header, indistinguishable
 *     from a crashed command. They must still emit the header row.
 *   - `ctx.color` was computed but never consumed anywhere; table output never actually
 *     carried colour. AC-22.1 promises "table with colour" on a TTY.
 *
 * `ResolvedTable` is intentionally not constructible except via `resolveResultTable` (a
 * runtime-checked brand, see resulttable.ts) — fixtures here go through it, same as
 * production code would.
 */

import { describe, expect, it } from "bun:test";
import { renderResultTable, type RenderOptions } from "../src/core/output.ts";
import { resolveResultTable } from "../src/core/resulttable.ts";

function sink() {
  const out: string[] = [];
  const warned: string[] = [];
  return {
    write: (s: string) => out.push(s),
    warn: (s: string) => warned.push(s),
    out: () => out.join(""),
    warned: () => warned.join("\n"),
  };
}

const NONEMPTY = resolveResultTable({
  columns: ["State", "Total"],
  rows: [{ columns: ["Shipped", 100] }],
});
const EMPTY = resolveResultTable({ columns: ["State", "Total"], rows: [] });

describe("empty results (AC-22.6)", () => {
  it("table: warns on stderr, writes nothing to stdout", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "table", write: s.write, warn: s.warn });
    expect(s.out()).toBe("");
    expect(s.warned()).toContain("no rows");
  });

  it("json: writes an empty array, not nothing", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "json", write: s.write, warn: s.warn });
    expect(s.out()).toBe("[]\n");
  });

  it("csv: still writes the header row (QA finding — previously zero bytes)", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "csv", write: s.write, warn: s.warn });
    expect(s.out()).toBe("State,Total\n");
  });

  it("tsv: still writes the header row", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "tsv", write: s.write, warn: s.warn });
    expect(s.out()).toBe("State\tTotal\n");
  });

  it("ndjson: an empty stream is the correct signal for a streaming format, not an error", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "ndjson", write: s.write, warn: s.warn });
    expect(s.out()).toBe("");
    expect(s.warned()).toBe("");
  });

  it("name: an empty stream is likewise correct — nothing to pipe to xargs", () => {
    const s = sink();
    renderResultTable(EMPTY, { format: "name", write: s.write, warn: s.warn });
    expect(s.out()).toBe("");
  });
});

describe("non-empty results still render normally after the empty-path change", () => {
  it("csv includes the header and the one data row", () => {
    const s = sink();
    renderResultTable(NONEMPTY, { format: "csv", write: s.write, warn: s.warn });
    expect(s.out()).toBe("State,Total\nShipped,100\n");
  });

  it("table includes header, separator, and the row", () => {
    const s = sink();
    renderResultTable(NONEMPTY, { format: "table", write: s.write, warn: s.warn });
    expect(s.out()).toContain("State");
    expect(s.out()).toContain("Shipped");
  });
});

describe("colour (AC-22.1) — QA finding: previously computed but never applied", () => {
  const ESC = "[";

  it("table format carries ANSI codes when color is true", () => {
    const s = sink();
    const opts: RenderOptions = { format: "table", write: s.write, warn: s.warn, color: true };
    renderResultTable(NONEMPTY, opts);
    expect(s.out()).toContain(ESC);
  });

  it("table format carries NO ANSI codes when color is false", () => {
    const s = sink();
    renderResultTable(NONEMPTY, { format: "table", write: s.write, warn: s.warn, color: false });
    expect(s.out()).not.toContain(ESC);
  });

  it("table format carries no ANSI codes when color is omitted (safe default)", () => {
    const s = sink();
    renderResultTable(NONEMPTY, { format: "table", write: s.write, warn: s.warn });
    expect(s.out()).not.toContain(ESC);
  });

  it("machine formats NEVER carry ANSI codes, even if color:true is passed by mistake", () => {
    // Colour in JSON/CSV/NDJSON would corrupt machine-readable output — this must be
    // impossible regardless of caller error, not just conventionally avoided.
    for (const format of ["json", "csv", "tsv", "ndjson", "name"] as const) {
      const s = sink();
      renderResultTable(NONEMPTY, { format, write: s.write, warn: s.warn, color: true });
      expect(s.out()).not.toContain(ESC);
    }
  });

  it("colour does not corrupt the data — content is unchanged either way", () => {
    const plain = sink();
    renderResultTable(NONEMPTY, { format: "table", write: plain.write, warn: plain.warn, color: false });
    const colored = sink();
    renderResultTable(NONEMPTY, { format: "table", write: colored.write, warn: colored.warn, color: true });
    // Strip ANSI and compare — same visible content either way.
    const stripped = colored.out().replace(/\[[0-9;]*m/g, "");
    expect(stripped).toBe(plain.out());
  });
});
