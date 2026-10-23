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
  disclosure, HANDLE_PREFIX, isIdentityValue, parseMode, pseudonymizeDocument, sensitivity,
  resolvePolicy, surrogate,
} from "../src/core/privacy.ts";
import { resolveResultTable } from "../src/core/resulttable.ts";
import { idColumnTypes, type QueryTokenInfo } from "../src/core/tokens.ts";
import { UsageError } from "../src/core/errors.ts";
import { JsonNumber, parseLossless } from "../src/core/json.ts";

/** The old `classify(name, policy)` shape, kept for readability in these name-only cases. */
const sensitivityOf = (name: string, policy: Parameters<typeof sensitivity>[1]) =>
  sensitivity({ name }, policy);

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
    // ...and names the narrow alternative, so `off` is not the only way anyone finds (#152).
    expect(warnings.join()).toContain(`list them under "allow" in privacy.json`);
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
      expect(sensitivityOf(m, p()).pseudonymize, m).toBe(true);
    }
  });

  it("matches inside a PascalCase member: CustomerName -> [customer, name]", () => {
    const c = sensitivityOf("CustomerName", p());
    expect(c.pseudonymize).toBe(true);
    expect(c.matched).toBe("name");
  });

  it("classifies on the LAST segment of a dotted token", () => {
    expect(sensitivityOf("Entity.Customer.Email", p()).pseudonymize).toBe(true);
    expect(sensitivityOf("Entity.Customer.State", p()).pseudonymize).toBe(false);
  });

  it("leaves plainly non-personal members alone", () => {
    for (const m of ["State", "Total", "Quantity", "OrderDate", "IsActive", "Level"]) {
      expect(sensitivityOf(m, p()).pseudonymize, m).toBe(false);
    }
  });

  it("does NOT misfire on Filename, which merely contains 'name'", () => {
    // Word matching, not substring. `FileName` would still misfire, which is exactly why the
    // disclosure has to name what it replaced (AC-52.6) — a false positive must be visible.
    expect(sensitivityOf("Filename", p()).pseudonymize).toBe(false);
  });

  it("reports WHY, which is what lets an agent explain without deciding", () => {
    expect(sensitivityOf("Email", p()).reason).toBe("heuristic-match");
    expect(sensitivityOf("Total", p()).reason).toBe("not-sensitive");
    expect(sensitivityOf("Email", policy({ callerIsAgent: false })).reason).toBe("mode-off");
  });

  it("an explicit policy overrides heuristics in BOTH directions (AC-52.5)", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ always: ["Total"], allow: ["Name"] }));
    const p2 = policy();
    expect(sensitivityOf("Total", p2)).toMatchObject({ pseudonymize: true, reason: "policy-always" });
    expect(sensitivityOf("Name", p2)).toMatchObject({ pseudonymize: false, reason: "policy-allow" });
  });

  it("strict replaces everything not allowlisted (AC-52.3, AC-52.8)", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "strict", allow: ["State"] }));
    const p2 = policy();
    expect(sensitivityOf("Total", p2)).toMatchObject({ pseudonymize: true, reason: "strict-default" });
    expect(sensitivityOf("State", p2)).toMatchObject({ pseudonymize: false, reason: "policy-allow" });
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
    expect(String(doc["id"])).toStartWith(HANDLE_PREFIX); // the document's own identity
    expect(doc["ticks"]).toBe("638");       // structural — REQ-031 round-trip depends on it
    expect(doc["total"]).toBe(99);          // not sensitive
    expect(doc["name"]).not.toBe("Acme GmbH");
    expect(pseudonymized).toEqual(["name", "id"]);
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

  it("replaces a Lite inside a plain array, label and all", () => {
    // An array element has no member name, so walking into it used to treat `model` as an ordinary
    // member: the real type, id and display string all came through.
    const { value, pseudonymized, handles } = pseudonymizeDocument(
      { Type: "Project", id: 1, members: [{ EntityType: "User", id: 7, model: "Anna Müller" }, "plain"] },
      policy(),
    );
    const members = (value as Record<string, unknown>)["members"] as unknown[];
    expect(String(members[0])).toStartWith(HANDLE_PREFIX);
    expect(members[0]).toBe(surrogate({ EntityType: "User", id: 7 }, "User", policy()));
    expect(members[1]).toBe("plain");
    expect(JSON.stringify(value)).not.toContain("Anna Müller");
    expect(Object.values(handles)).toContain("User;7");
    expect(pseudonymized).toContain("members");
  });

  it("replaces the document's own id with the handle a Lite to it would get", () => {
    const { value, handleDetails } = pseudonymizeDocument({ Type: "Customer", id: 7, toStr: "Acme" }, policy());
    const id = (value as Record<string, unknown>)["id"];
    expect(id).toBe(surrogate({ EntityType: "Customer", id: 7 }, "Customer", policy()));
    expect(handleDetails[String(id)]).toEqual({ lite: "Customer;7", label: "Acme" });
  });

  it("leaves an id alone when the root is not an entity", () => {
    const { value } = pseudonymizeDocument({ id: 7, total: 1 }, policy());
    expect(value).toEqual({ id: 7, total: 1 });
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

/**
 * Identities are judged by VALUE, not by column name.
 *
 * Two individually-correct behaviours combined to leak: #88 renders a Lite's `model` — a person's
 * name — as a readable label, while classification only ever looked at the column NAME. An
 * entity-valued column is called `User`, `Customer` or `Owner`, none of which matches a name-based
 * heuristic, so real names printed under `heuristic`. Only visible once both landed together.
 */
describe("entity references are always identities (the merge leak)", () => {
  it("recognises a Lite by shape, whatever the column is called", () => {
    expect(isIdentityValue({ EntityType: "User", id: 102 })).toBe(true);
    expect(isIdentityValue({ Type: "User", id: 102 })).toBe(true);
  });

  it("does not mistake ordinary values for identities", () => {
    expect(isIdentityValue("Shipped")).toBe(false);
    expect(isIdentityValue(1200.5)).toBe(false);
    expect(isIdentityValue(null)).toBe(false);
    expect(isIdentityValue({ id: 1 })).toBe(false);           // no type
    expect(isIdentityValue({ EntityType: "User" })).toBe(false); // no id
  });

  it("becomes a handle under HEURISTIC, not only under strict", () => {
    // Previously identities were protected only by strict's allowlist rule, so the mode most people
    // will actually run left them readable.
    const h = surrogate({ EntityType: "User", id: 102 }, "User", policy());
    expect(String(h)).toStartWith(HANDLE_PREFIX);
  });
});

/**
 * `get` must protect entity references too — the Brooks review's critical finding.
 *
 * `pseudonymizeDocument` decided from the member NAME alone, so a nested Lite came through with a
 * real type, a real id and a real label under the DEFAULT agent policy — while the disclosure
 * reported that nothing had been pseudonymized. The rule now has one home, so both data paths get it.
 */
describe("entity documents protect nested identities (the get leak)", () => {
  it("replaces a nested Lite with a handle, though `Customer` matches no heuristic", () => {
    const { value, pseudonymized, handles } = pseudonymizeDocument(
      { Type: "Order", id: 42, Customer: { EntityType: "Customer", id: 7, model: "Anna Müller" }, total: 99 },
      policy(),
    );
    const doc = value as Record<string, unknown>;
    expect(String(doc["Customer"])).toStartWith(HANDLE_PREFIX);
    expect(JSON.stringify(doc)).not.toContain("Anna Müller");
    expect(JSON.stringify(doc)).not.toContain('"id":7');
    expect(pseudonymized).toContain("Customer");
    // The handle is recorded, so a human can still audit what the agent acted on (AC-53.4).
    expect(Object.values(handles)).toContain("Customer;7");
  });

  it("still leaves structural keys and non-sensitive values alone", () => {
    const { value } = pseudonymizeDocument({ Type: "Order", id: 42, ticks: "638", total: 99 }, policy());
    expect(value).toEqual({ Type: "Order", id: surrogate({ EntityType: "Order", id: 42 }, "Order", policy()), ticks: "638", total: 99 });
  });

  it("reports what it replaced, so the disclosure cannot claim safety it did not deliver", () => {
    const { pseudonymized } = pseudonymizeDocument(
      { Type: "Order", id: 1, Customer: { EntityType: "Customer", id: 7 } },
      policy(),
    );
    expect(pseudonymized).not.toEqual([]);
  });

  it("agrees with the query path — one rule, both paths", () => {
    // The two paths disagreeing is the defect this consolidation exists to prevent.
    const lite = { EntityType: "Customer", id: 7 };
    const fromDocument = (pseudonymizeDocument({ Customer: lite }, policy()).value as Record<string, unknown>)["Customer"];
    const fromValue = surrogate(lite, "Customer", policy());
    expect(fromDocument).toBe(fromValue);
  });
});

/**
 * Reading some members and nothing else (#152). `strict` with an allowlist is that: the allowed
 * members are shown, everything else is masked. `get` walked INTO an allowed member and re-judged its
 * parts, so under `strict` an allowed reference kept its id and lost its display text, while `query`
 * and `explain --privacy` showed it.
 *
 * The first fix emitted an allowed member whole, which was a leak of its own (security review of
 * #156): a `get` document can carry a referenced entity in full, so allowing `Customer` showed the
 * customer's email, phone and nested references. An allowed value now shows what `query` would show
 * for an allowed column — identity and display text — and whatever it contains is judged on its own.
 */
describe("an allowlisted member shows what query would show, and no more (#152)", () => {
  const COLUMN = { EntityType: "BoardColumn", id: 3, model: "In Progress" };
  const LABELS = [{ EntityType: "Label", id: 1, model: "urgent" }];
  const TASK = { Type: "Task", id: 7, toStr: "Fix the boiler", ticks: "1", title: "Fix the boiler", column: COLUMN, labels: LABELS };

  it("shows an allowed reference and list with their display text, and masks the rest", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "strict", allow: ["Column", "Labels"] }));
    const doc = pseudonymizeDocument(structuredClone(TASK), policy()).value as Record<string, unknown>;
    expect(doc["column"]).toEqual(COLUMN);
    expect(doc["labels"]).toEqual(LABELS);
    expect(doc["title"]).not.toBe("Fix the boiler");
    expect(doc["toStr"]).not.toBe("Fix the boiler");
    expect(String(doc["id"])).toStartWith(HANDLE_PREFIX);
  });

  it("emits an allowed member exactly as the query path emits an allowed column", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "strict", allow: ["Column"] }));
    const p = policy();
    const table = resolveResultTable(
      { columns: ["Column"], rows: [{ entity: { EntityType: "Task", id: 7 }, columns: [COLUMN] }] },
      { requestedColumns: ["Column"], privacy: p },
    );
    const doc = pseudonymizeDocument({ Type: "Task", id: 7, column: COLUMN }, p).value as Record<string, unknown>;
    expect(doc["column"]).toEqual(table.rows[0]?.values[table.columns.indexOf("Column")]);
  });

  /** What allowing `Customer` must NOT reveal: everything a full record carries beyond its label. */
  const SECRETS = ["erika@example.invalid", "+49 170 0000000", "Musterstr. 1", "Max Muster"];
  const CUSTOMER = {
    Type: "Customer", id: 9, ticks: "1", toStr: "Erika Mustermann",
    email: "erika@example.invalid", phone: "+49 170 0000000",
    address: { Type: "AddressEmbedded", toStr: "Musterstr. 1", street: "Musterstr. 1" },
    accountManager: { EntityType: "Employee", id: 4, model: "Max Muster" },
  };
  const shown = (doc: unknown): string => JSON.stringify(doc);

  for (const mode of ["heuristic", "strict"] as const) {
    it(`shows a referenced entity's display text but judges its members on their own (${mode})`, () => {
      writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode, allow: ["Customer"] }));
      const out = pseudonymizeDocument({ Type: "Order", id: 1, customer: structuredClone(CUSTOMER) }, policy());
      const customer = (out.value as Record<string, Record<string, unknown>>)["customer"] ?? {};
      expect(customer["toStr"]).toBe("Erika Mustermann");
      expect(customer["id"]).toBe(9);
      for (const secret of SECRETS) expect(shown(out.value)).not.toContain(secret);
      expect(String(customer["accountManager"])).toStartWith(HANDLE_PREFIX);
      expect(out.pseudonymized).toContain("email");
    });

    it(`judges the entity inside a loaded Lite and each MList row's element on their own (${mode})`, () => {
      writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode, allow: ["Customer", "Customers"] }));
      const loaded = { EntityType: "Customer", id: 9, model: "Erika Mustermann", entity: structuredClone(CUSTOMER) };
      const rows = [{ rowId: 5, element: structuredClone(CUSTOMER) }];
      const out = pseudonymizeDocument({ Type: "Order", id: 1, customer: loaded, customers: rows }, policy());
      const doc = out.value as Record<string, unknown>;
      expect((doc["customer"] as Record<string, unknown>)["model"]).toBe("Erika Mustermann");
      expect((doc["customers"] as Array<Record<string, unknown>>)[0]?.["rowId"]).toBe(5);
      for (const secret of SECRETS) expect(shown(doc)).not.toContain(secret);
    });
  }
});

/**
 * `get` reads entities losslessly (#111), so ids arrive as `identifier` JsonNumbers, not numbers. The
 * identity check used to be `typeof id === "number"` — under that, an exact id made a Lite invisible
 * and it was emitted whole, real label included.
 */
describe("exact ids are still identities (lossless get)", () => {
  const DOC = `{"Type":"Order","id":42,"Customer":{"EntityType":"Customer","id":7,"model":"Anna Müller"},"total":99.50}`;

  it("pseudonymizes a lossless document exactly as the plain one — same handles, same output", () => {
    const plain = pseudonymizeDocument(JSON.parse(DOC), policy());
    const exact = pseudonymizeDocument(parseLossless(DOC), policy());
    // Identical handles are what keep a `get` handle and a `query` handle for one record the same.
    expect(exact.handles).toEqual(plain.handles);
    expect(exact.pseudonymized).toEqual(plain.pseudonymized);
    expect(JSON.stringify(exact.value)).toBe(JSON.stringify(plain.value).replace(`"total":99.5`, `"total":99.50`));
    expect(JSON.stringify(exact.value)).not.toContain("Anna Müller");
  });

  it("records an int64 id past 2^53 exactly, so `unmask` resolves to the real record", () => {
    const { handles } = pseudonymizeDocument(
      parseLossless(`{"Customer":{"EntityType":"Customer","id":9007199254740993,"model":"A"}}`),
      policy(),
    );
    expect(Object.values(handles)).toEqual(["Customer;9007199254740993"]);
  });

  it("only an id is an identity — a tagged plain number is a value", () => {
    expect(isIdentityValue({ EntityType: "Customer", id: new JsonNumber("identifier", "7") })).toBe(true);
    expect(isIdentityValue({ EntityType: "Customer", id: new JsonNumber("number", "7") })).toBe(false);
  });

  it("a sensitive exact number gets a numeric surrogate, like a plain one", () => {
    expect(typeof surrogate(new JsonNumber("number", "4711"), "Salary", policy())).toBe("number");
  });
});

describe("the disclosure names the frequency limit (review finding)", () => {
  it("warns that few distinct values are reversible by counting", () => {
    const d = disclosure(policy(), ["State"]);
    expect(d).toContain("FEW DISTINCT VALUES");
    expect(d).toContain("counting");
  });
});

/**
 * An entity's id is an identity (#157). A plain number named `Id` matched no heuristic and was no
 * Lite, so `--column Entity.Id` gave an agent the real database id under the DEFAULT policy, and the
 * disclosure said nothing was replaced — the other half of a Lite, missed as its label once was (#105).
 */
describe("an entity's id is an identity (#157)", () => {
  it("is recognised by the framework's own key, on the last segment only", () => {
    for (const name of ["Id", "Entity.Id", "Entity.Customer.Id"]) {
      expect(sensitivityOf(name, policy())).toMatchObject({ pseudonymize: true, reason: "identity" });
    }
    for (const name of ["ExternalId", "Idea", "Entity.Id.Something", "Valid"]) {
      expect(sensitivityOf(name, policy()).reason).not.toBe("identity");
    }
  });

  it("is left alone when a human allowlisted it, as any identity is", () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ allow: ["Id"] }));
    expect(sensitivityOf("Entity.Id", policy())).toMatchObject({ pseudonymize: false, reason: "policy-allow" });
  });

  it("becomes the record's own handle when its type is known, and is still masked when it is not", () => {
    const p = policy();
    const table = resolveResultTable(
      {
        columns: ["Entity.Id", "Entity.Customer.Id", "Id"],
        rows: [{ entity: { EntityType: "Order", id: 7 }, columns: [7, 9, 7] }],
      },
      { requestedColumns: ["Entity", "Entity.Id", "Entity.Customer.Id", "Id"], idTypes: { "Entity.Id": "Order", "Entity.Customer.Id": "Customer" }, privacy: p },
    );
    const at = (c: string) => table.rows[0]?.values[table.columns.indexOf(c)];
    expect(at("Entity.Id")).toBe(at("Entity"));
    expect(String(at("Entity.Customer.Id"))).toStartWith(HANDLE_PREFIX);
    expect(table.mintedHandles[String(at("Entity.Customer.Id"))]).toBe("Customer;9");
    expect(typeof at("Id")).toBe("number");
    expect(at("Id")).not.toBe(7);
    expect(table.pseudonymized).toEqual(expect.arrayContaining(["Entity.Id", "Entity.Customer.Id", "Id"]));
  });

  it("takes its type from the property route the server returns", () => {
    const info = (fullKey: string, propertyRoute?: string): QueryTokenInfo => ({
      key: fullKey.split(".").pop() ?? fullKey, fullKey, niceName: undefined, toStr: undefined, kind: undefined,
      type: "number", filterType: "Integer", isGroupable: true, usableInQuery: true, propertyRoute,
    });
    expect(idColumnTypes([
      info("Entity.Customer.Id", "(Customer).Id"),
      info("Id", "(Order).Id"),
      info("Entity.Customer.Name", "(Customer).Name"),
      info("Entity.Owner.Id"),
    ])).toEqual({ "Entity.Customer.Id": "Customer", Id: "Order" });
  });
});
