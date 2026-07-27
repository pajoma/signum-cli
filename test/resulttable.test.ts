/**
 * RELEASE-BLOCKING (ADR 0006 cost 5, AC-21.3, AC-21.4).
 *
 * TypeScript types erase at runtime, so these tests are the safety net that Rust's type
 * system would have provided. Do not downgrade or skip them.
 */

import { describe, expect, it } from "bun:test";
import { resolveResultTable, type RawResultTable } from "../src/core/resulttable.ts";
import { CliError } from "../src/core/errors.ts";

describe("resolveResultTable", () => {
  it("de-interns columns that have a uniqueValues pool (AC-21.3)", () => {
    const raw: RawResultTable = {
      columns: ["State", "Total"],
      uniqueValues: { State: ["Shipped", "Delivered"] },
      rows: [
        { columns: [0, 1200.5] },
        { columns: [1, 87.25] },
        { columns: [0, 43] },
      ],
      totalElements: 3,
    };
    const t = resolveResultTable(raw);
    expect(t.rows.map((r) => r.values)).toEqual([
      ["Shipped", 1200.5],
      ["Delivered", 87.25],
      ["Shipped", 43],
    ]);
  });

  it("passes through a non-interned response unchanged (AC-21.3)", () => {
    const raw: RawResultTable = {
      columns: ["Name", "Count"],
      rows: [{ columns: ["Acme", 7] }],
    };
    const t = resolveResultTable(raw);
    expect(t.rows[0]?.values).toEqual(["Acme", 7]);
  });

  it("handles null inside an interned column (AC-21.3)", () => {
    const raw: RawResultTable = {
      columns: ["State"],
      uniqueValues: { State: ["Shipped"] },
      rows: [{ columns: [null] }, { columns: [0] }],
    };
    const t = resolveResultTable(raw);
    expect(t.rows[0]?.values).toEqual([null]);
    expect(t.rows[1]?.values).toEqual(["Shipped"]);
  });

  it("THROWS on an out-of-range intern index — never renders blank (AC-21.4)", () => {
    const raw: RawResultTable = {
      columns: ["State"],
      uniqueValues: { State: ["Shipped"] },
      rows: [{ columns: [5] }],
    };
    expect(() => resolveResultTable(raw)).toThrow(CliError);
    expect(() => resolveResultTable(raw)).toThrow(/out of range/);
  });

  it("throws when an interned cell is not an integer index (AC-21.4)", () => {
    const raw: RawResultTable = {
      columns: ["State"],
      uniqueValues: { State: ["Shipped"] },
      rows: [{ columns: ["Shipped"] }],
    };
    expect(() => resolveResultTable(raw)).toThrow(/expected an intern index/);
  });

  it("reinserts the hoisted Entity column at its declared position (AC-21.2)", () => {
    // The server strips the Entity column out of `columns` and hoists it to `row.entity`
    // (ResultTable.cs:55-56, ResultTableConverter.cs:61-65). Putting it back is this layer's
    // job — this test previously asserted the OPPOSITE, locking in the defect.
    const raw: RawResultTable = {
      columns: ["Id", "Total"],
      rows: [{ entity: { EntityType: "Order", id: 42 }, columns: [7, 10] }],
    };
    const t = resolveResultTable(raw, { requestedColumns: ["Id", "Entity", "Total"] });
    expect(t.columns).toEqual(["Id", "Entity", "Total"]);
    expect(t.entityIndex).toBe(1);
    expect(t.rows[0]?.values).toEqual([7, { EntityType: "Order", id: 42 }, 10]);
    // Still exposed separately, for `-o name`.
    expect(t.rows[0]?.entity).toEqual({ EntityType: "Order", id: 42 });
  });

  it("reinserts Entity first when the caller declared no column order (AC-21.2)", () => {
    // The framework's own reconstruction is Columns.PreAnd(entityColumn) — ResultTable.cs:51 —
    // so first is the right default for a query that used its definition's default columns.
    const t = resolveResultTable({
      columns: ["State"],
      rows: [{ entity: { EntityType: "Order", id: 42 }, columns: ["Shipped"] }],
    });
    expect(t.columns).toEqual(["Entity", "State"]);
    expect(t.rows[0]?.values).toEqual([{ EntityType: "Order", id: 42 }, "Shipped"]);
  });

  it("reinserts Entity last when it was requested last (AC-21.2)", () => {
    const t = resolveResultTable(
      { columns: ["Id"], rows: [{ entity: { EntityType: "Order", id: 42 }, columns: [7] }] },
      { requestedColumns: ["Id", "Entity"] },
    );
    expect(t.columns).toEqual(["Id", "Entity"]);
    expect(t.rows[0]?.values).toEqual([7, { EntityType: "Order", id: 42 }]);
  });

  it("keeps the position right when the server drops a column it will not disclose", () => {
    // ResultTable's constructor filters on Token.IsAllowed(), so a requested column can simply
    // not come back. Anchoring on the nearest predecessor that DID come back keeps Entity where
    // the caller put it.
    const t = resolveResultTable(
      { columns: ["Id"], rows: [{ entity: { EntityType: "Order", id: 42 }, columns: [7] }] },
      { requestedColumns: ["Id", "Secret", "Entity", "Total"] },
    );
    expect(t.columns).toEqual(["Id", "Entity"]);
    expect(t.rows[0]?.values).toEqual([7, { EntityType: "Order", id: 42 }]);
  });

  it("anchors on the predecessor's SERVER position, not its request index", () => {
    // Found by running the compiled binary: with the request order and the server's order
    // disagreeing, counting request positions put Entity next to the wrong column. Anchoring on
    // where the predecessor actually landed keeps them adjacent. `Total` is server index 1, so
    // Entity belongs at 2 — not at 1, which is where a request-index count would have put it.
    const t = resolveResultTable(
      { columns: ["State", "Total"], rows: [{ entity: { EntityType: "Order", id: 42 }, columns: ["Shipped", 10] }] },
      { requestedColumns: ["Total", "Entity"] },
    );
    expect(t.columns).toEqual(["State", "Total", "Entity"]);
    expect(t.rows[0]?.values).toEqual(["Shipped", 10, { EntityType: "Order", id: 42 }]);
  });

  it("adds no Entity column when the server hoisted none (--group results)", () => {
    // With groupResults the server keeps entity tokens inline and sets EntityColumn to null
    // (ResultTable.cs:55), so there is nothing to reinsert and nothing to invent.
    const t = resolveResultTable({ columns: ["State", "Total.Sum"], rows: [{ columns: ["Shipped", 99] }] });
    expect(t.columns).toEqual(["State", "Total.Sum"]);
    expect(t.entityIndex).toBeUndefined();
    expect(t.rows[0]?.values).toEqual(["Shipped", 99]);
  });

  it("declares the Entity column even when zero rows came back", () => {
    // Otherwise a csv/tsv header on an empty result would disagree with a non-empty one, and a
    // script reading column names would see the shape change under it.
    const t = resolveResultTable({ columns: ["Id"], rows: [] }, { requestedColumns: ["Entity", "Id"] });
    expect(t.columns).toEqual(["Entity", "Id"]);
  });

  it("keeps values index-aligned with columns for every row (the invariant renderers rely on)", () => {
    const t = resolveResultTable(
      {
        columns: ["State"],
        uniqueValues: { State: ["Shipped", "Delivered"] },
        rows: [
          { entity: { EntityType: "Order", id: 1 }, columns: [0] },
          { entity: { EntityType: "Order", id: 2 }, columns: [1] },
        ],
      },
      { requestedColumns: ["Entity", "State"] },
    );
    for (const row of t.rows) expect(row.values.length).toBe(t.columns.length);
    expect(t.rows.map((r) => r.values[1])).toEqual(["Shipped", "Delivered"]);
  });

  it("reports totalElements distinctly from rows returned (AC-21.5)", () => {
    const t = resolveResultTable({ columns: ["A"], rows: [{ columns: [1] }], totalElements: 999 });
    expect(t.rows.length).toBe(1);
    expect(t.totalElements).toBe(999);
  });

  it("tolerates object-shaped column descriptors", () => {
    const t = resolveResultTable({
      columns: [{ token: "Entity.Customer.Name" }],
      rows: [{ columns: ["Acme"] }],
    });
    expect(t.columns).toEqual(["Entity.Customer.Name"]);
  });
});
