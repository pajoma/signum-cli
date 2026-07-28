/**
 * Pseudonymization engine — REQ-057 (#51) · STORY-52 · ADR 0007, ADR 0009.
 *
 * The unit-level half. The end-to-end behaviour (gate evolution, disclosure, `--privacy`) is in
 * test/integration.test.ts; this covers classification and surrogate properties, which is where
 * subtle wrongness would hide.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify, disclosure, parseMode, pseudonymizeDocument, resolvePolicy, surrogate,
} from "../src/core/privacy.ts";
import { UsageError } from "../src/core/errors.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-privacy-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;
const policy = (o: Partial<Parameters<typeof resolvePolicy>[0]> = {}) =>
  resolvePolicy({ callerIsAgent: true, acknowledged: false, env: env(), ...o });

describe("mode resolution — the policy is not the caller's to weaken (AC-52.10)", () => {
  it("defaults to heuristic under an agent and off for everyone else (AC-51.5)", () => {
    expect(policy({ callerIsAgent: true }).mode).toBe("heuristic");
    expect(policy({ callerIsAgent: false }).mode).toBe("off");
  });

  it("a caller may TIGHTEN freely", () => {
    expect(policy({ requested: "strict" }).mode).toBe("strict");
  });

  it("a caller may NOT loosen under an agent without the human acknowledgement", () => {
    expect(() => policy({ requested: "off" })).toThrow(UsageError);
    expect(() => policy({ requested: "off" })).toThrow(/refusing to loosen/);
  });

  it("loosening with the acknowledgement works and is LOGGED, never silent", () => {
    const warnings: string[] = [];
    const p = policy({ requested: "off", acknowledged: true, warn: (l) => warnings.push(l) });
    expect(p.mode).toBe("off");
    expect(warnings.join()).toContain("loosened");
  });

  it("a human at a terminal may loosen freely — there is nothing to protect them from", () => {
    expect(policy({ callerIsAgent: false, requested: "off" }).mode).toBe("off");
  });

  it("a profile policy file overrides the default", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "strict" }));
    const p = policy();
    expect(p.mode).toBe("strict");
    expect(p.origin).toBe("profile");
  });

  it("a BROKEN policy file keeps the safe default rather than disabling protection", () => {
    writeFileSync(join(dir, "privacy.json"), "{ not json");
    const warnings: string[] = [];
    const p = policy({ warn: (l) => warnings.push(l) });
    expect(p.mode).toBe("heuristic"); // NOT off
    expect(warnings.join()).toContain("could not read");
  });

  it("rejects an unknown mode as a usage error", () => {
    expect(() => parseMode("maybe")).toThrow(/unknown pseudonymization mode/);
  });
});

describe("classification, with reasons (REQ-059)", () => {
  const p = () => policy();

  it("matches English and German member names (AC-52.4)", () => {
    for (const m of ["Name", "Email", "Phone", "Nachname", "Telefon", "Geburtsdatum", "IBAN", "Steuernummer"]) {
      expect(classify(m, p()).pseudonymize, m).toBe(true);
    }
  });

  it("matches inside a PascalCase member: CustomerName -> [customer, name]", () => {
    const c = classify("CustomerName", p());
    expect(c.pseudonymize).toBe(true);
    expect(c.matched).toBe("name");
  });

  it("classifies on the LAST segment of a dotted token", () => {
    expect(classify("Entity.Customer.Email", p()).pseudonymize).toBe(true);
    expect(classify("Entity.Customer.State", p()).pseudonymize).toBe(false);
  });

  it("leaves plainly non-personal members alone", () => {
    for (const m of ["State", "Total", "Quantity", "OrderDate", "IsActive", "Level"]) {
      expect(classify(m, p()).pseudonymize, m).toBe(false);
    }
  });

  it("does NOT misfire on Filename, which merely contains 'name'", () => {
    // Word matching, not substring. `FileName` would still misfire, which is exactly why the
    // disclosure has to name what it replaced (AC-52.6) — a false positive must be visible.
    expect(classify("Filename", p()).pseudonymize).toBe(false);
  });

  it("reports WHY, which is what lets an agent explain without deciding", () => {
    expect(classify("Email", p()).reason).toBe("heuristic-match");
    expect(classify("Total", p()).reason).toBe("not-sensitive");
    expect(classify("Email", policy({ callerIsAgent: false })).reason).toBe("mode-off");
  });

  it("an explicit policy overrides heuristics in BOTH directions (AC-52.5)", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ always: ["Total"], allow: ["Name"] }));
    const p2 = policy();
    expect(classify("Total", p2)).toMatchObject({ pseudonymize: true, reason: "policy-always" });
    expect(classify("Name", p2)).toMatchObject({ pseudonymize: false, reason: "policy-allow" });
  });

  it("strict replaces everything not allowlisted (AC-52.3, AC-52.8)", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "strict", allow: ["State"] }));
    const p2 = policy();
    expect(classify("Total", p2)).toMatchObject({ pseudonymize: true, reason: "strict-default" });
    expect(classify("State", p2)).toMatchObject({ pseudonymize: false, reason: "policy-allow" });
  });
});

describe("surrogate properties (AC-52.1, AC-52.7)", () => {
  it("is STABLE for the same value — that is what makes grouping possible", () => {
    const p = policy();
    expect(surrogate("Müller", "Name", p)).toBe(surrogate("Müller", "Name", p));
  });

  it("correlates the same value ACROSS columns, so a person is one surrogate", () => {
    // Derived from the value ALONE, deliberately: an agent must be able to see that
    // Customer.Name and Owner.Name are the same person without learning who. Only the label prefix
    // differs — the identity lives in the digest, so that is what must match.
    const p = policy();
    const digest = (v: unknown) => String(v).split("-").pop();
    expect(digest(surrogate("Müller", "Entity.Customer.Name", p)))
      .toBe(digest(surrogate("Müller", "Entity.Owner.Name", p)));
    // ...and the prefixes really are different, or the assertion above would be vacuous.
    expect(String(surrogate("Müller", "Entity.Customer.Name", p))).toStartWith("Customer-");
    expect(String(surrogate("Müller", "Entity.Owner.Name", p))).toStartWith("Owner-");
  });

  it("distinguishes different values", () => {
    const p = policy();
    expect(surrogate("Müller", "Name", p)).not.toBe(surrogate("Schmidt", "Name", p));
  });

  it("differs between profiles — the secret is per profile, not global", () => {
    const other = mkdtempSync(join(tmpdir(), "signum-privacy2-"));
    try {
      const a = surrogate("Müller", "Name", policy());
      const b = surrogate("Müller", "Name", resolvePolicy({
        callerIsAgent: true, acknowledged: false, env: { SIGNUM_CONFIG_DIR: other } as unknown as NodeJS.ProcessEnv,
      }));
      expect(a).not.toBe(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("keeps a number NUMERIC, so a delimited column stays parseable", () => {
    expect(typeof surrogate(42, "Salary", policy())).toBe("number");
  });

  it("labels a string surrogate readably, from the token's parent (ADR 0007)", () => {
    expect(String(surrogate("Müller", "Entity.Customer.Name", policy()))).toMatch(/^Customer-[0-9a-f]{4}$/);
  });

  it("leaves null, undefined and booleans alone — absence and one bit identify nobody", () => {
    const p = policy();
    expect(surrogate(null, "Name", p)).toBeNull();
    expect(surrogate(undefined, "Name", p)).toBeUndefined();
    expect(surrogate(true, "Name", p)).toBe(true);
  });

  it("digests a Lite by type+id, so an incidental label change does not change the surrogate", () => {
    const p = policy();
    const a = surrogate({ EntityType: "User", id: 102, model: "alice" }, "User", p);
    const b = surrogate({ EntityType: "User", id: 102 }, "User", p);
    expect(a).toBe(b);
  });
});

describe("entity documents (for `get`)", () => {
  it("replaces sensitive members and leaves structural keys intact", () => {
    const { value, pseudonymized } = pseudonymizeDocument(
      { Type: "Customer", id: 7, ticks: "638", name: "Acme GmbH", total: 99 },
      policy(),
    );
    const doc = value as Record<string, unknown>;
    expect(doc["Type"]).toBe("Customer");   // structural
    expect(doc["id"]).toBe(7);              // structural — REQ-058 handles identity, not this
    expect(doc["ticks"]).toBe("638");       // structural — REQ-031 round-trip depends on it
    expect(doc["total"]).toBe(99);          // not sensitive
    expect(doc["name"]).not.toBe("Acme GmbH");
    expect(pseudonymized).toEqual(["name"]);
  });

  it("recurses into nested objects and arrays", () => {
    const { value } = pseudonymizeDocument(
      { Type: "Order", id: 1, lines: [{ email: "a@b.c", qty: 2 }] },
      policy(),
    );
    const line = ((value as Record<string, unknown>)["lines"] as Array<Record<string, unknown>>)[0]!;
    expect(line["email"]).not.toBe("a@b.c");
    expect(line["qty"]).toBe(2);
  });

  it("does nothing at all when the mode is off", () => {
    const doc = { name: "Acme GmbH" };
    const { value, pseudonymized } = pseudonymizeDocument(doc, policy({ callerIsAgent: false }));
    expect(value).toEqual(doc);
    expect(pseudonymized).toEqual([]);
  });
});

describe("disclosure (AC-52.6, AC-52.9)", () => {
  it("says what was replaced, admits incompleteness, and never claims compliance", () => {
    const d = disclosure(policy(), ["Name", "Email"]);
    expect(d).toContain("Name, Email");
    expect(d).toContain("INCOMPLETE");
    expect(d).toContain("GDPR Art. 4(5)");
    expect(d).toContain("not a compliance control");
  });

  it("stays silent when nothing was replaced — no noise, no false reassurance", () => {
    expect(disclosure(policy(), [])).toBe("");
    expect(disclosure(policy({ callerIsAgent: false }), ["Name"])).toBe("");
  });
});
