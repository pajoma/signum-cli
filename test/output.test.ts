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
import { unsafeDataWriter } from "../src/core/policy.ts";

function sink() {
  const out: string[] = [];
  const warned: string[] = [];
  return {
    // Data renderers take a gated writer (ADR 0007, policy.ts). These sinks are strings in a
    // test, not a user's terminal, so they are minted through the audited escape hatch.
    write: unsafeDataWriter((s: string) => { out.push(s); }, "test sink, not stdout"),
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

/** A hoisted Entity column, declared in the middle of the requested order. */
const WITH_ENTITY = resolveResultTable(
  {
    columns: ["Id", "State"],
    rows: [{ entity: { EntityType: "Order", id: 42 }, columns: [7, "Shipped"] }],
  },
  { requestedColumns: ["Id", "Entity", "State"] },
);

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

/**
 * RELEASE-BLOCKING (AC-21.2). Before this, `Entity` was appended at the END in json/ndjson and
 * omitted ENTIRELY from table/csv/tsv — three formats silently lost entity identity while a
 * fourth quietly moved it. Every format must now agree on one column order: the requested one.
 */
describe("the Entity column appears at its declared position in EVERY format (AC-21.2)", () => {
  const EXPECTED_COLUMNS = ["Id", "Entity", "State"];

  it("the resolved table itself declares the requested order", () => {
    expect(WITH_ENTITY.columns).toEqual(EXPECTED_COLUMNS);
  });

  it("csv: header and row both carry Entity in the middle, as a Lite key", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "csv", write: s.write, warn: s.warn });
    // A flat format has no representation for a Lite except its key — and the key is what pipes
    // back into `signum get`. Rendering the serialized object instead produced an unreadable,
    // quote-escaped JSON blob in the cell.
    expect(s.out()).toBe("Id,Entity,State\n7,Order;42,Shipped\n");
  });

  it("tsv: same order, same Lite key", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "tsv", write: s.write, warn: s.warn });
    expect(s.out()).toBe("Id\tEntity\tState\n7\tOrder;42\tShipped\n");
  });

  it("table: the human header carries Entity, and it is not last", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "table", write: s.write, warn: s.warn });
    const lines = s.out().split("\n");
    expect((lines[0] ?? "").split(/\s+/).filter((c) => c !== "")).toEqual(EXPECTED_COLUMNS);
    expect((lines[2] ?? "").split(/\s+/).filter((c) => c !== "")).toEqual(["7", "Order;42", "Shipped"]);
  });

  it("json: key order matches the requested order — Entity is NOT appended last", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "json", write: s.write, warn: s.warn });
    const rows = JSON.parse(s.out()) as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0] ?? {})).toEqual(EXPECTED_COLUMNS);
    // A structured format keeps the whole Lite — only the flat formats reduce it to a key.
    expect(rows[0]?.["Entity"]).toEqual({ EntityType: "Order", id: 42 });
  });

  it("ndjson: same key order as json", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "ndjson", write: s.write, warn: s.warn });
    const row = JSON.parse(s.out().trimEnd()) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(EXPECTED_COLUMNS);
  });

  it("name: still emits the Lite key, unaffected by reinsertion", () => {
    const s = sink();
    renderResultTable(WITH_ENTITY, { format: "name", write: s.write, warn: s.warn });
    expect(s.out()).toBe("Order;42\n");
  });

  it("csv and json agree on the column set — no format sees a different shape", () => {
    const csv = sink();
    renderResultTable(WITH_ENTITY, { format: "csv", write: csv.write, warn: csv.warn });
    const json = sink();
    renderResultTable(WITH_ENTITY, { format: "json", write: json.write, warn: json.warn });
    const csvHeader = (csv.out().split("\n")[0] ?? "").split(",");
    const jsonKeys = Object.keys((JSON.parse(json.out()) as Array<Record<string, unknown>>)[0] ?? {});
    expect(csvHeader).toEqual(jsonKeys);
  });
});

describe("the data-output boundary (ADR 0007 · policy.ts)", () => {
  it("REFUSES to render rows through an ungated writer, even if types were bypassed", () => {
    // The compile-time half is the useful one; this is the half that survives type erasure
    // (ADR 0006 cost 5), so a `as any` or a JSON-shaped options object cannot slip past.
    const chunks: string[] = [];
    const ungated = { format: "json" as const, write: (s: string) => { chunks.push(s); } };
    expect(() => renderResultTable(NONEMPTY, ungated as unknown as RenderOptions)).toThrow(/ungated writer/);
    expect(chunks).toEqual([]);
  });
});
