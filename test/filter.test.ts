/**
 * Filter expression parser.
 *
 * REQ-021 · docs/design/filter-expression-syntax.md
 */

import { describe, expect, it } from "bun:test";
import {
  lowerFilterExpressions, parseFilterExpression,
  type FilterConditionWire, type FilterGroupWire, type FilterOperationName,
} from "../src/core/filter.ts";
import { UsageError } from "../src/core/errors.ts";

function lowerOne(expr: string, opts: { groupEnabled?: boolean } = {}) {
  const node = parseFilterExpression(expr);
  return lowerFilterExpressions([node], { groupEnabled: opts.groupEnabled ?? false });
}

describe("basic conditions and operators", () => {
  it("lowers a symbolic equality", () => {
    expect(lowerOne("State = Shipped")).toEqual([{ token: "State", operation: "EqualTo", value: "Shipped" }]);
  });

  it("requires no whitespace around symbolic operators", () => {
    expect(lowerOne("State=Shipped")).toEqual([{ token: "State", operation: "EqualTo", value: "Shipped" }]);
  });

  it("maps every symbolic operator", () => {
    const cases: Array<[string, FilterOperationName]> = [
      ["!=", "DistinctTo"], [">", "GreaterThan"], [">=", "GreaterThanOrEqual"],
      ["<", "LessThan"], ["<=", "LessThanOrEqual"], ["~", "Contains"], ["!~", "NotContains"],
    ];
    for (const [sym, op] of cases) {
      expect(lowerOne(`Total ${sym} 5`)).toEqual([{ token: "Total", operation: op, value: 5 }]);
    }
  });

  it("maps every named operator that takes a single value", () => {
    const cases: Array<[string, FilterOperationName]> = [
      ["eq", "EqualTo"], ["equalTo", "EqualTo"], ["ne", "DistinctTo"], ["distinctTo", "DistinctTo"],
      ["gt", "GreaterThan"], ["gte", "GreaterThanOrEqual"], ["lt", "LessThan"], ["lte", "LessThanOrEqual"],
      ["contains", "Contains"], ["notContains", "NotContains"], ["startsWith", "StartsWith"],
      ["endsWith", "EndsWith"], ["notStartsWith", "NotStartsWith"], ["notEndsWith", "NotEndsWith"],
      ["like", "Like"], ["notLike", "NotLike"],
      ["complexCondition", "ComplexCondition"], ["freeText", "FreeText"],
      ["tsQuery", "TsQuery"], ["tsQueryPlain", "TsQuery_Plain"], ["tsQueryPhrase", "TsQuery_Phrase"],
      ["tsQueryWebSearch", "TsQuery_WebSearch"], ["smartSearch", "SmartSearch"],
    ];
    for (const [name, op] of cases) {
      expect(lowerOne(`Name ${name} foo`)).toEqual([{ token: "Name", operation: op, value: "foo" }]);
    }
  });

  it("named operators are case-insensitive", () => {
    expect(lowerOne("Name STARTSWITH Ac")).toEqual([{ token: "Name", operation: "StartsWith", value: "Ac" }]);
  });

  it("rejects an unknown operator", () => {
    expect(() => lowerOne("State bogus Shipped")).toThrow(UsageError);
    expect(() => lowerOne("State bogus Shipped")).toThrow(/unknown operator 'bogus'/);
  });
});

describe("values", () => {
  it("parses null, true, false as keywords", () => {
    expect(lowerOne("A = null")).toEqual([{ token: "A", operation: "EqualTo", value: null }]);
    expect(lowerOne("A = true")).toEqual([{ token: "A", operation: "EqualTo", value: true }]);
    expect(lowerOne("A = false")).toEqual([{ token: "A", operation: "EqualTo", value: false }]);
  });

  it("parses culture-invariant numbers, including negatives", () => {
    expect(lowerOne("Total = 100")).toEqual([{ token: "Total", operation: "EqualTo", value: 100 }]);
    expect(lowerOne("Total = -3.5")).toEqual([{ token: "Total", operation: "EqualTo", value: -3.5 }]);
  });

  it("keeps quoted 'null'/'true' as literal strings, not keywords", () => {
    expect(lowerOne('State = "null"')).toEqual([{ token: "State", operation: "EqualTo", value: "null" }]);
    expect(lowerOne('State = "true"')).toEqual([{ token: "State", operation: "EqualTo", value: "true" }]);
  });

  it("passes an ISO date through as a plain string", () => {
    expect(lowerOne("OrderDate = 2026-07-25")).toEqual([
      { token: "OrderDate", operation: "EqualTo", value: "2026-07-25" },
    ]);
  });

  it("treats an unquoted enum-looking value as a string", () => {
    expect(lowerOne("State = Shipped")).toEqual([{ token: "State", operation: "EqualTo", value: "Shipped" }]);
  });

  it("supports single and double quotes with escapes", () => {
    expect(lowerOne('Name = "a,b"')).toEqual([{ token: "Name", operation: "EqualTo", value: "a,b" }]);
    expect(lowerOne("Name = 'it''s'".replace("''", "\\'"))).toBeTruthy(); // sanity: doesn't throw
  });

  // H1 (Brooks review): the Lite metaphor must not leak onto arbitrary strings. The rule is
  // now "bare Type;id infers a Lite; a QUOTED value is always a literal string." Lites never
  // need quoting (type names and ids contain no whitespace), so this loses no capability.

  it("lowers a BARE Type;id value to the wire Lite object form", () => {
    expect(lowerOne("Order = Order;42")).toEqual([
      { token: "Order", operation: "EqualTo", value: { EntityType: "Order", id: 42 } },
    ]);
  });

  it("keeps a non-numeric bare Lite id as a string (e.g. a Guid)", () => {
    const guid = "abcd1234-0000-0000-0000-000000000000";
    expect(lowerOne(`Order = Order;${guid}`)).toEqual([
      { token: "Order", operation: "EqualTo", value: { EntityType: "Order", id: guid } },
    ]);
  });

  it("a QUOTED Type;id-shaped value stays a literal string, never a Lite (H1 regression)", () => {
    // "Smith;John" is a person's name, not an entity reference — quoting means literal.
    expect(lowerOne('Name = "Smith;John"')).toEqual([
      { token: "Name", operation: "EqualTo", value: "Smith;John" },
    ]);
  });

  it("a QUOTED value shaped exactly like a real Lite is ALSO kept literal (residual of H1)", () => {
    // The dangerous case: a literal string that happens to look like Type;number. Quoting it
    // forces string, which is the only escape a user has without --filter-json.
    expect(lowerOne('Code = "Batch;42"')).toEqual([
      { token: "Code", operation: "EqualTo", value: "Batch;42" },
    ]);
  });
});

describe("lists: in, notIn, between", () => {
  it("parses an unquoted comma-separated list with no spaces", () => {
    expect(lowerOne("State in Shipped,Delivered,Invoiced")).toEqual([
      { token: "State", operation: "IsIn", value: ["Shipped", "Delivered", "Invoiced"] },
    ]);
  });

  it("parses notIn", () => {
    expect(lowerOne("State notIn Shipped,Delivered")).toEqual([
      { token: "State", operation: "IsNotIn", value: ["Shipped", "Delivered"] },
    ]);
  });

  it("requires between to have exactly two values", () => {
    expect(lowerOne("D between 2026-01-01,2026-06-30")).toEqual([
      { token: "D", operation: "Between", value: ["2026-01-01", "2026-06-30"] },
    ]);
    expect(() => lowerOne("D between 2026-01-01")).toThrow(/requires exactly two values/);
    expect(() => lowerOne("D between 1,2,3")).toThrow(/requires exactly two values/);
  });

  it("accepts betweenNoEnd with one or two values", () => {
    expect(lowerOne("D betweenNoEnd 2026-01-01")).toEqual([
      { token: "D", operation: "BetweenNoEnd", value: ["2026-01-01"] },
    ]);
    expect(() => lowerOne("D betweenNoEnd 1,2,3")).toThrow(/takes one or two values/);
  });

  it("rejects null inside in/notIn with a specific, actionable message (constraint 2)", () => {
    expect(() => lowerOne("State in Shipped,null")).toThrow(/cannot include null/);
    expect(() => lowerOne("State notIn Shipped,null")).toThrow(/cannot include null/);
  });

  it("a literal comma inside a value must be escaped or quoted", () => {
    expect(lowerOne('Name in "a,b",c')).toEqual([{ token: "Name", operation: "IsIn", value: ["a,b", "c"] }]);
  });
});

describe("and / or / grouping", () => {
  it("and binds tighter than or", () => {
    // A or (B and C)
    const [top] = lowerOne("A = 1 or B = 2 and C = 3");
    const group = top as FilterGroupWire;
    expect(group.groupOperation).toBe("Or");
    expect(group.filters.length).toBe(2);
    expect((group.filters[0] as FilterConditionWire).token).toBe("A");
    const rhs = group.filters[1] as FilterGroupWire;
    expect(rhs.groupOperation).toBe("And");
  });

  it("parentheses override precedence", () => {
    // Top-level AND is flattened (see the flattening test below), so the parenthesized OR
    // survives as one array entry and the trailing AND term as another.
    const out = lowerOne("(A = 1 or B = 2) and C = 3");
    expect(out.length).toBe(2);
    const lhs = out[0] as FilterGroupWire;
    expect(lhs.groupOperation).toBe("Or");
    expect((out[1] as FilterConditionWire).token).toBe("C");
  });

  it("keywords are case-insensitive", () => {
    // Also flattened at the top level — both conditions land as separate array entries.
    const out = lowerOne("A = 1 AND B = 2");
    expect(out).toEqual([
      { token: "A", operation: "EqualTo", value: 1 },
      { token: "B", operation: "EqualTo", value: 2 },
    ]);
  });

  it("a single condition is not wrapped in a group", () => {
    expect(lowerOne("State = Shipped")).toEqual([{ token: "State", operation: "EqualTo", value: "Shipped" }]);
  });

  it("flattens a TOP-LEVEL and into a flat array, not a redundant group", () => {
    const out = lowerOne("A = 1 and B = 2 and C = 3");
    expect(out.length).toBe(3);
    expect(out.every((f) => "operation" in f)).toBe(true);
  });

  it("does NOT flatten an and nested inside an or (would change meaning)", () => {
    const [top] = lowerOne("(A = 1 and B = 2) or C = 3");
    const group = top as FilterGroupWire;
    expect(group.groupOperation).toBe("Or");
    expect(group.filters.length).toBe(2);
    const nested = group.filters[0] as FilterGroupWire;
    expect(nested.groupOperation).toBe("And");
    expect(nested.filters.length).toBe(2);
  });
});

describe("composing multiple --filter flags (repeated --filter is AND)", () => {
  it("flattens across independently parsed expressions", () => {
    const nodes = ["A = 1", "B = 2"].map(parseFilterExpression);
    const out = lowerFilterExpressions(nodes, { groupEnabled: false });
    expect(out).toEqual([
      { token: "A", operation: "EqualTo", value: 1 },
      { token: "B", operation: "EqualTo", value: 2 },
    ]);
  });

  it("flattens a multi-term expression together with other flags", () => {
    const nodes = ["A = 1 and B = 2", "C = 3"].map(parseFilterExpression);
    const out = lowerFilterExpressions(nodes, { groupEnabled: false });
    expect(out.length).toBe(3);
  });
});

describe("the two documented syntax collisions", () => {
  it("an unquoted leading '(' names the cast-token quoting rule in the hint", () => {
    // The quoting-rule guidance lives in .hint, like every other error in this codebase —
    // .message states what went wrong, .hint states how to fix it.
    try {
      lowerOne("(Order).Customer.Name = 5");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e instanceof UsageError).toBe(true);
      expect((e as UsageError).hint).toMatch(/must be quoted/);
    }
  });

  it("the quoted form of a cast token parses as an ordinary token", () => {
    expect(lowerOne('"(Order).Customer.Name" = 5')).toEqual([
      { token: "(Order).Customer.Name", operation: "EqualTo", value: 5 },
    ]);
  });

  it("an operation-key-shaped token with '#' round-trips when quoted", () => {
    expect(lowerOne('"Entity.[Operations].Order#Save" = true')).toEqual([
      { token: "Entity.[Operations].Order#Save", operation: "EqualTo", value: true },
    ]);
  });
});

describe("token validation", () => {
  it("rejects a .Nested token with the specific reason (constraint 6)", () => {
    expect(() => lowerOne("Details.Nested.Name = X")).toThrow(/\.Nested/);
  });

  it("requires --group for an aggregate-shaped token (constraint 5)", () => {
    expect(() => lowerOne("Total.Sum > 100")).toThrow(/--group/);
    expect(lowerOne("Total.Sum > 100", { groupEnabled: true })).toEqual([
      { token: "Total.Sum", operation: "GreaterThan", value: 100 },
    ]);
  });

  it("does not misfire on a bracketed token containing a dot inside brackets", () => {
    // The bracket-aware split must not treat this as ending in 'Nested' or an aggregate name.
    expect(lowerOne("[Foo.Bar] = 1")).toEqual([{ token: "[Foo.Bar]", operation: "EqualTo", value: 1 }]);
  });
});

describe("parse errors are informative", () => {
  it("reports a missing operator", () => {
    expect(() => lowerOne("State")).toThrow(/expected an operator/);
  });

  it("reports a missing 'and'/'or' between conditions", () => {
    expect(() => lowerOne("State = Shipped Total = 5")).toThrow(/missing 'and'\/'or'/);
  });

  it("reports an unterminated quote", () => {
    expect(() => lowerOne('State = "Shipped')).toThrow(/unterminated quoted string/);
  });

  it("reports an unclosed paren", () => {
    expect(() => lowerOne("(A = 1 and B = 2")).toThrow(/unclosed '\('/);
  });

  it("rejects an empty expression", () => {
    expect(() => parseFilterExpression("")).toThrow(/empty --filter/);
  });

  it("every parse error includes a caret pointing at the failure column", () => {
    try {
      lowerOne("State === Shipped");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e instanceof UsageError).toBe(true);
      expect((e as UsageError).hint).toMatch(/\^/);
    }
  });
});
