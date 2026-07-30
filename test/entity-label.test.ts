/**
 * The display string is identity-bearing — `ToString` / `toStr` (#105).
 *
 * This was a leak of the DEFAULT policy, not of an opt-in. A display string arrives as a plain
 * string, so the value-based identity rule cannot see it, and it is called `ToString`, which matches
 * no name heuristic — so both halves of the classifier passed it through and a person's name came
 * back in the clear with no flag involved.
 *
 * What made it hard to spot: `--resolve` was already safe, because that path rewrites the token and
 * declares it a label. The unsafe routes were the ones nobody thought to check — an explicitly named
 * `--column Entity.ToString`, and `get`, which returns `toStr` without being asked. Meanwhile
 * `explain --privacy` reported the source member as protected on every path.
 *
 * The last test here is the one the issue asked for by name: an invariant, not a case list, so the
 * asymmetry cannot come back for a token nobody enumerated.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pseudonymizeDocument, resolvePolicy, sensitivity, type PrivacyPolicy,
} from "../src/core/privacy.ts";
import { resolveResultTable } from "../src/core/resulttable.ts";

let dir: string;
function policy(mode?: string): PrivacyPolicy {
  dir = mkdtempSync(join(tmpdir(), "signum-label-"));
  const env = {
    SIGNUM_CONFIG_DIR: dir,
    ...(mode === undefined ? {} : { SIGNUM_PSEUDONYMIZE: mode }),
  } as unknown as NodeJS.ProcessEnv;
  return resolvePolicy({ callerIsAgent: true, acknowledged: false, env });
}
function cleanup(): void { rmSync(dir, { recursive: true, force: true }); }

/** A real name, shaped like the ones in the report: two capitalised words with a space. */
const REAL_NAME = "Alexandra Weber";

describe("the classifier treats a display string as identity-bearing", () => {
  it("catches `ToString` as the last segment of a query token", () => {
    const p = policy();
    for (const token of ["Entity.ToString", "Entity.Customer.ToString", "ToString"]) {
      const c = sensitivity({ name: token, value: REAL_NAME }, p);
      expect(c.pseudonymize).toBe(true);
      // Reported apart from `identity`, so the introspection view says WHICH rule fired.
      expect(c.reason).toBe("entity-label");
    }
    cleanup();
  });

  it("catches the wire field `toStr`", () => {
    const p = policy();
    const c = sensitivity({ name: "toStr", value: REAL_NAME }, p);
    expect(c.pseudonymize).toBe(true);
    expect(c.reason).toBe("entity-label");
    cleanup();
  });

  it("does not fire on a member merely CONTAINING the word", () => {
    // Only the last dotted segment decides. `ToStringHelper` is not a display string, and
    // over-matching would surrogate ordinary columns and be blamed on the heuristic.
    const p = policy();
    expect(sensitivity({ name: "ToStringHelper", value: "x" }, p).reason).not.toBe("entity-label");
    expect(sensitivity({ name: "Entity.ToStringCache", value: "x" }, p).reason).not.toBe("entity-label");
    cleanup();
  });

  it("still lets an explicit allowlist through, since allow wins outright", () => {
    // The issue's third acceptance point: strict must not permit the label "unless it is
    // allow-listed". Precedence already put policy-allow ahead of the structural rules.
    const p = policy("strict");
    const withAllow: PrivacyPolicy = { ...p, allow: new Set(["tostring"]), memo: new Map() };
    expect(sensitivity({ name: "Entity.ToString", value: REAL_NAME }, withAllow).pseudonymize).toBe(false);
    cleanup();
  });

  it("pseudonymizes under strict as well as heuristic", () => {
    for (const mode of [undefined, "strict"]) {
      const p = policy(mode);
      expect(sensitivity({ name: "Entity.ToString", value: REAL_NAME }, p).pseudonymize).toBe(true);
      cleanup();
    }
  });
});

describe("query: an explicitly named label column is surrogated", () => {
  it("surrogates --column Entity.ToString, like Entity.Name on the same type", () => {
    const p = policy();
    const table = resolveResultTable(
      {
        columns: ["Entity.ToString", "Entity.Name"],
        rows: [{ columns: [REAL_NAME, REAL_NAME] }],
      },
      { privacy: p },
    );
    const [label, name] = table.rows[0]?.values ?? [];
    expect(label).not.toBe(REAL_NAME);
    expect(name).not.toBe(REAL_NAME);
    // "Consistently with Entity.Name" means correlatable, not byte-identical: a string surrogate is
    // `<column-label>-<digest>`, and the digest is derived from the VALUE alone. So the prefixes
    // differ per column (`ToString-…` vs `Name-…`) while the digest matches, which is what lets an
    // agent see that both columns describe the same person without learning who.
    const digestOf = (v: unknown): string => String(v).split("-").pop() ?? "";
    expect(digestOf(label)).toBe(digestOf(name));
    expect(table.pseudonymized).toContain("Entity.ToString");
    cleanup();
  });

  it("was already safe via --resolve, and still is", () => {
    // Pinned so the fix cannot regress the path that worked: `columnLabels` relabels the column, so
    // the structural name check does NOT fire and `isEntityLabel` has to carry it.
    const p = policy();
    const table = resolveResultTable(
      { columns: ["Entity.User.ToString"], rows: [{ columns: [REAL_NAME] }] },
      { privacy: p, columnLabels: { "Entity.User.ToString": "Entity.User" } },
    );
    expect(table.rows[0]?.values[0]).not.toBe(REAL_NAME);
    cleanup();
  });
});

describe("get: toStr is surrogated without being asked for", () => {
  it("replaces toStr on an entity document", () => {
    const p = policy();
    const out = pseudonymizeDocument(
      { Type: "User", id: 7, toStr: REAL_NAME, userName: "aweber", email: "a@example.com" },
      p,
    );
    const doc = out.value as Record<string, unknown>;
    expect(doc["toStr"]).not.toBe(REAL_NAME);
    expect(out.pseudonymized).toContain("toStr");
    // Structural fields stay readable — the id was never the leak, and hiding it would break `get`.
    expect(doc["id"]).toBe(7);
    expect(doc["Type"]).toBe("User");
    cleanup();
  });

  it("replaces a nested entity's toStr too", () => {
    const p = policy();
    const out = pseudonymizeDocument(
      { Type: "Order", id: 1, customer: { Type: "Customer", id: 9, toStr: REAL_NAME } },
      p,
    );
    // The whole nested value is replaced as an identity, so the label cannot survive inside it.
    expect(JSON.stringify(out.value)).not.toContain(REAL_NAME);
    cleanup();
  });
});

describe("the invariant, so this cannot come back for a token nobody enumerated", () => {
  it("no emitted field equals a real label while its source member is surrogated", () => {
    // The issue's final acceptance point. Asserted as a property over the whole emitted document
    // rather than a list of known field names: the defect was precisely that one route was missed,
    // so a case list would have passed while the bug was live.
    const p = policy();
    const document = {
      Type: "User",
      id: 57,
      name: REAL_NAME,
      toStr: REAL_NAME,
      ToString: REAL_NAME,
      lastNameFirstName: REAL_NAME,
      billingName: REAL_NAME,
      nested: { Type: "DomainRole", id: 3, toStr: REAL_NAME },
    };
    const out = pseudonymizeDocument(document, p);
    expect(JSON.stringify(out.value)).not.toContain(REAL_NAME);
    cleanup();
  });

  it("the same holds for a result table naming every label-ish token", () => {
    const p = policy();
    const columns = ["Entity.ToString", "Entity.Name", "Entity.LastNameFirstName", "Entity.BillingName"];
    const table = resolveResultTable(
      { columns, rows: [{ columns: columns.map(() => REAL_NAME) }] },
      { privacy: p },
    );
    expect(JSON.stringify(table.rows)).not.toContain(REAL_NAME);
    cleanup();
  });
});
