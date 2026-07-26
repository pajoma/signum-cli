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

  it("hoists the Entity column out of columns (AC-21.2)", () => {
    const raw: RawResultTable = {
      columns: ["Total"],
      rows: [{ entity: { EntityType: "Order", id: 42 }, columns: [10] }],
    };
    const t = resolveResultTable(raw);
    expect(t.rows[0]?.entity).toEqual({ EntityType: "Order", id: 42 });
    expect(t.rows[0]?.values).toEqual([10]);
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
