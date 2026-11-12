/**
 * Operations — the write path. STORY-40 to STORY-43 and STORY-46 (docs/stories/operations.md);
 * #112 to #117.
 *
 * Every write hazard in this API fails QUIETLY: an edit sent as a Lite is dropped, an unmarked change
 * is discarded, a bare object argument arrives as null, a numeric ticks is a false conflict. So these
 * tests assert what went over the WIRE — the mock records every request — not only the exit code.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { ExitCode, UsageError } from "../src/core/errors.ts";
import { assertPermit, auditLogPath } from "../src/core/guard.ts";
import { saveHandles } from "../src/core/handles.ts";
import { JsonNumber } from "../src/core/json.ts";
import { parseMetadata } from "../src/core/metadata.ts";
import { encodeArgs, kebab, resolveKey, resolveVerbNoun } from "../src/core/operations.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";

const TOKEN = "test-token-ops";

/** Order's operations as reflection sends them: `operationType` and `canBeModified` decide the route. */
const REFLECTION = {
  Order: {
    kind: "Entity", entityKind: "Main", niceName: "Order", queryDefined: true,
    members: { Id: { type: { name: "number" } }, Name: { type: { name: "string" } } },
    operations: {
      "OrderOperation.Ship": { operationType: "Execute", canBeModified: false },
      "OrderOperation.Save": { operationType: "Execute", canBeModified: true, canBeNew: true },
      "OrderOperation.Get": { operationType: "Execute" },            // shadowed by the built-in `get`
      "OrderOperation.Create": { operationType: "Constructor" },
      "OrderOperation.ImportPublicHolidays": { operationType: "Execute" },
      "LegacyOrderOperation.Ship": { operationType: "Execute" },     // a second `Ship` on Order
      "OrderOperation.Approve": { operationType: "Execute" },
    },
  },
  HolidayCalendar: {
    kind: "Entity", entityKind: "Main", niceName: "Holiday calendar",
    members: {}, operations: { "HolidayCalendarOperation.ImportPublicHolidays": { operationType: "Execute" } },
  },
  Customer: {
    kind: "Entity", entityKind: "Main", niceName: "Customer", members: {},
    operations: { "OrderOperation.Approve": { operationType: "Execute" } },  // one key, two types
  },
};

const md = parseMetadata(REFLECTION, { url: "x", fetchedAt: "", fromCache: false, stale: false, authenticated: true });

describe("naming an operation (STORY-41, #116)", () => {
  it("resolves <verb> <noun> case-insensitively and kebab-tolerantly (AC-41.2, AC-41.7)", () => {
    expect(resolveVerbNoun(md, "save", "order").key).toBe("OrderOperation.Save");
    expect(resolveVerbNoun(md, "import-public-holidays", "holiday-calendar").key).toBe("HolidayCalendarOperation.ImportPublicHolidays");
    expect(resolveVerbNoun(md, "ImportPublicHolidays", "HolidayCalendar").key).toBe("HolidayCalendarOperation.ImportPublicHolidays");
    expect(kebab("ImportPublicHolidays")).toBe("import-public-holidays");
  });

  it("lists both keys and refuses when a verb is ambiguous on one type (AC-41.3)", () => {
    expect(() => resolveVerbNoun(md, "ship", "order")).toThrow(/ambiguous for Order: OrderOperation.Ship, LegacyOrderOperation.Ship/);
  });

  it("suggests near verbs for an unknown one (AC-41.4)", () => {
    expect(() => resolveVerbNoun(md, "sav", "order")).toThrow(UsageError);
    try { resolveVerbNoun(md, "sav", "order"); } catch (e) { expect((e as UsageError).hint).toContain("save"); }
  });

  it("accepts the canonical key verbatim, in any case (AC-41.1)", () => {
    expect(resolveKey(md, "OrderOperation.Save").type.name).toBe("Order");
    expect(resolveKey(md, "orderoperation.save").key).toBe("OrderOperation.Save");
  });

  it("answers a namespace-qualified key with the real format and the real key (AC-41.5)", () => {
    try {
      resolveKey(md, "Signum.Shop.OrderOperation.Save");
      throw new Error("not refused");
    } catch (e) {
      expect((e as UsageError).message).toContain("not namespace-qualified");
      expect((e as UsageError).hint).toContain("OrderOperation.Save");
    }
  });

  it("needs the target's type when one key runs on several types", () => {
    expect(() => resolveKey(md, "OrderOperation.Approve")).toThrow(/several types: Order, Customer/);
    expect(resolveKey(md, "OrderOperation.Approve", "Customer").type.name).toBe("Customer");
  });
});

describe("encoding args (STORY-42, #115)", () => {
  const warnings: string[] = [];
  const opts = (o: Partial<Parameters<typeof encodeArgs>[1]> = {}) =>
    ({ handles: {}, allowCustomObjects: false, warn: (l: string) => warnings.push(l), ...o });
  beforeEach(() => { warnings.length = 0; });

  it("keeps the order typed across all four flags (AC-42.1)", () => {
    const args = encodeArgs([["arg", "7"], ["arg-lite", "Customer;3"], ["arg-string", "x"], ["arg-json", "[1,[2]]"]], opts());
    expect(JSON.stringify(args)).toBe(`[7,{"EntityType":"Customer","id":3},"x",[1,[2]]]`);
  });

  it("lets the flag decide the shape, never the content (#115)", () => {
    // `Customer;3` is a Lite only when asked for one; as a string it stays a string.
    expect(JSON.stringify(encodeArgs([["arg-string", "Customer;3"]], opts()))).toBe(`["Customer;3"]`);
    expect(JSON.stringify(encodeArgs([["arg-string", "42"]], opts()))).toBe(`["42"]`);
    expect(JSON.stringify(encodeArgs([["arg", "42"], ["arg", "true"], ["arg", "null"]], opts()))).toBe(`[42,true,null]`);
  });

  it("keeps a number's digits exact, which the server reads as a decimal (AC-42.5)", () => {
    const [n] = encodeArgs([["arg", "12345678901234567890.10"]], opts()) ?? [];
    expect(n).toBeInstanceOf(JsonNumber);
    expect(JSON.stringify([n])).toBe("[12345678901234567890.10]");
  });

  it("warns that a date-shaped --arg-string arrives as a date (AC-42.3)", () => {
    encodeArgs([["arg-string", "2026-01-01"]], opts());
    expect(warnings.join()).toContain("date-shaped");
  });

  it("refuses an object the server would receive as null, nested or not (AC-42.4)", () => {
    expect(() => encodeArgs([["arg-json", `{"a":1}`]], opts())).toThrow(/receives as null/);
    expect(() => encodeArgs([["arg-json", `[{"EntityType":"Customer","id":1},{"b":2}]`]], opts())).toThrow(/\[1\]/);
    expect(encodeArgs([["arg-json", `{"a":1}`]], opts({ allowCustomObjects: true }))).toHaveLength(1);
    expect(encodeArgs([["arg-json", `{"Type":"AddressEmbedded","city":"X"}`]], opts())).toHaveLength(1);
  });

  it("resolves a handle locally, so it never reaches the server (AC-53.2)", () => {
    const handle = `${HANDLE_PREFIX}aaaaaaaaaaaa`;
    const args = encodeArgs([["arg-lite", handle]], opts({ handles: { [handle]: "Customer;9" } }));
    expect(JSON.stringify(args)).toBe(`[{"EntityType":"Customer","id":9}]`);
  });

  it("says args are positional when given a name (cli-surface example)", () => {
    expect(() => encodeArgs([["arg-lite", "Customer=Customer;7"]], opts())).toThrow(/positional, not named/);
  });

  it("is null, not empty, when no --arg was given", () => {
    expect(encodeArgs([["lite", "Order;42"]], opts())).toBeNull();
  });
});

describe("the guard cannot be skipped (STORY-46, #113)", () => {
  it("refuses to send without a permit minted by confirmMutation", () => {
    expect(() => assertPermit({ operation: "X", target: "Y", realTarget: "Y", url: "u" })).toThrow(/without confirmation/);
  });
});

// ─── end to end, against a mock that records every request ───────────────────

interface Seen { method: string; path: string; body: string }
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let seen: Seen[] = [];
/** What the next operation call answers; reset per test. */
let answer: "pack" | "validation" | "concurrency" | "forbidden" = "pack";
/** `canExecute` the entity pack reports for a dry run. */
let canExecute: Record<string, string | null> = {};

const ORDER_42 = `{"Type":"Order","id":42,"ticks":"638500000000000017","toStr":"Order 42","modified":false,"name":"Acme","customer":{"EntityType":"Customer","id":9,"model":"Erika Mustermann"}}`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      seen.push({ method: req.method, path: url.pathname, body });
      const headers = { "content-type": "application/json" };
      if (url.pathname === "/api/reflection/types") return new Response(JSON.stringify(REFLECTION), { headers });
      if (url.pathname === "/api/entity/Order/42") return new Response(ORDER_42, { headers });
      if (url.pathname === "/api/entityPack/Order/42") {
        return new Response(`{"entity":${ORDER_42},"canExecute":${JSON.stringify(canExecute)}}`, { headers });
      }
      if (url.pathname.startsWith("/api/operation/")) {
        if (answer === "validation") {
          return new Response(JSON.stringify({ title: "Validation error", errors: { "request.entity.name": ["Name is too long"] } }), { status: 400, headers });
        }
        if (answer === "concurrency") {
          return new Response(JSON.stringify({ exceptionType: "Signum.Engine.ConcurrencyException", exceptionMessage: "Concurrency" }), { status: 500, headers });
        }
        if (answer === "forbidden") {
          return new Response(JSON.stringify({ exceptionType: "System.UnauthorizedAccessException", exceptionMessage: "Ship is not allowed" }), { status: 403, headers });
        }
        return new Response(`{"entity":${ORDER_42.replace('"Acme"', '"Shipped Co"')},"canExecute":{"OrderOperation.Ship":"Already shipped"}}`, { headers });
      }
      return new Response(JSON.stringify({ exceptionMessage: "unhandled" }), { status: 404, headers });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "signum-ops-"));
  seen = [];
  answer = "pack";
  canExecute = {};
});
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

interface Result { code: ExitCode; out: string; err: string; prompts: string[] }

async function cli(argv: string[], o: { tty?: boolean; reply?: string; env?: Record<string, string> } = {}): Promise<Result> {
  let out = "", err = "";
  const prompts: string[] = [];
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: o.tty === true,
    stdinIsTty: o.tty === true,
    env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: TOKEN, ...(o.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => "",
    ...(o.tty === true ? { prompt: async (q: string) => { prompts.push(q); return o.reply ?? ""; } } : {}),
  };
  try {
    return { code: await run(argv, io), out, err, prompts };
  } catch (e) {
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err, prompts };
  }
}

const operationCalls = () => seen.filter((s) => s.path.startsWith("/api/operation/"));

describe("executing an operation (STORY-40, #114)", () => {
  it("sends an identity-only operation as a Lite, with its args (AC-40.2)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--arg", "3", "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    const [call] = operationCalls();
    expect(call?.path).toBe("/api/operation/executeLite/OrderOperation.Ship");
    expect(call?.body).toBe(`{"lite":{"EntityType":"Order","id":42},"args":[3]}`);
  });

  it("sends a canBeModified operation the fresh entity with the edit marked, ticks as a string (AC-32.1, #117)", async () => {
    const r = await cli(["save", "order", "42", "--edit", "name=Beta", "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    const [call] = operationCalls();
    expect(call?.path).toBe("/api/operation/executeEntity/OrderOperation.Save");
    const sent = JSON.parse(call?.body ?? "{}") as { entity: Record<string, unknown>; args: unknown };
    expect(sent.entity["name"]).toBe("Beta");
    expect(sent.entity["modified"]).toBe(true);
    expect(call?.body).toContain(`"ticks":"638500000000000017"`);
    expect(sent.args).toBeNull();
  });

  it("never sends an edited graph as a Lite: it refuses, and sends nothing (#114)", async () => {
    const r = await cli(["OrderOperation.Approve", "--lite", "Order;42", "--edit", "name=Beta", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--edit would be discarded");
    expect(operationCalls()).toEqual([]);
  });

  it("says when every edit is already the value, and sends nothing (AC-32.4)", async () => {
    const r = await cli(["save", "order", "42", "--edit", "name=Acme", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("nothing was sent");
    expect(operationCalls()).toEqual([]);
  });

  it("renders the returned pack: the refreshed entity and its new canExecute (AC-40.4)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes", "--json"]);
    const doc = JSON.parse(r.out) as { entity: Record<string, unknown>; canExecute: Record<string, unknown> };
    expect(doc.entity["name"]).toBe("Shipped Co");
    expect(doc.canExecute["OrderOperation.Ship"]).toBe("Already shipped");
  });

  it("reports a 400 as a validation failure with the server's field message (AC-40.6)", async () => {
    answer = "validation";
    const r = await cli(["save", "order", "42", "--edit", "name=Beta", "--yes"]);
    expect(r.code).toBe(ExitCode.Validation);
    expect(r.err).toContain("Name is too long");
  });

  it("reports a stale ticks as a concurrency conflict naming refetch and retry (AC-33.2, #117)", async () => {
    answer = "concurrency";
    const r = await cli(["save", "order", "42", "--edit", "name=Beta", "--yes"]);
    expect(r.code).toBe(ExitCode.Concurrency);
    expect(r.err).toContain("changed since you read it");
    expect(r.err).toContain("Refetch and retry");
    expect(operationCalls()).toHaveLength(1); // never auto-retried (AC-33.4)
  });

  it("says a 403 may mean the operation is hidden from the UI (AC-40.5)", async () => {
    answer = "forbidden";
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    expect(r.err).toContain("hidden from the UI");
  });

  it("leaves a shadowed verb to the built-in, and reaches the operation by its key (AC-41.8)", async () => {
    const builtin = await cli(["get", "order", "42", "--json"]);
    expect(builtin.code).toBe(ExitCode.Ok);
    expect(operationCalls()).toEqual([]);
    const op = await cli(["OrderOperation.Get", "--lite", "Order;42", "--yes"]);
    expect(op.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/executeLite/OrderOperation.Get");
  });

  it("answers `<verb> <Type> --help` with the operations help, sending nothing", async () => {
    const r = await cli(["ship", "order", "--help"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("OPERATIONS");
    expect(r.out).toContain("--dry-run");
    expect(seen).toEqual([]);
  });

  it("refuses construct and delete for now, naming where they land", async () => {
    const r = await cli(["OrderOperation.Create", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("#118");
    expect(operationCalls()).toEqual([]);
  });

  it("--explain prints the exact request and sends nothing (AC-42.7)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--arg-string", "x", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { url: string; body: unknown };
    expect(doc.url).toEndWith("/api/operation/executeLite/OrderOperation.Ship");
    expect(doc.body).toEqual({ lite: { EntityType: "Order", id: 42 }, args: ["x"] });
    expect(operationCalls()).toEqual([]);
  });
});

describe("the destructive-action guard (STORY-46, #113)", () => {
  it("without a terminal and without --yes, exits non-zero at once and sends nothing (AC-46.3)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("without --yes");
    expect(r.prompts).toEqual([]);
    expect(operationCalls()).toEqual([]);
  });

  it("at a terminal, names the operation, the record and the application, and stops on no (AC-46.1)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42"], { tty: true, reply: "n" });
    expect(r.prompts[0]).toContain("OrderOperation.Ship");
    expect(r.prompts[0]).toContain("Order;42");
    expect(r.prompts[0]).toContain(baseUrl);
    expect(r.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });

  it("at a terminal, sends on yes", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42"], { tty: true, reply: "yes" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()).toHaveLength(1);
  });

  it("--yes and -y skip the prompt in both contexts (AC-46.2)", async () => {
    for (const yes of ["--yes", "-y"]) {
      const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", yes], { tty: true, reply: "n" });
      expect(r.prompts).toEqual([]);
      expect(r.code).toBe(ExitCode.Ok);
    }
  });

  it("records every attempt locally with its outcome, no credential (AC-46.6)", async () => {
    await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"]);
    answer = "forbidden";
    await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"]);
    const lines = readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l["operation"], l["target"], l["ok"]])).toEqual([
      ["OrderOperation.Ship", "Order;42", true], ["OrderOperation.Ship", "Order;42", false],
    ]);
    expect(lines[1]?.["exitCode"]).toBe(ExitCode.NotAuthorized);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("does not record a preview or a dry run, which change nothing", async () => {
    await cli(["OrderOperation.Ship", "--lite", "Order;42", "--explain"]);
    canExecute = { "OrderOperation.Ship": null };
    await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run"]);
    expect(existsSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv))).toBe(false);
  });
});

describe("--dry-run (STORY-43, #112)", () => {
  it("reports permitted from the entity pack and sends no operation (AC-43.1, AC-43.4)", async () => {
    canExecute = { "OrderOperation.Ship": null };
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(r.out)).toMatchObject({ operation: "OrderOperation.Ship", permitted: true });
    expect(operationCalls()).toEqual([]);
    expect(seen.map((s) => s.path)).toContain("/api/entityPack/Order/42");
  });

  it("shows the server's reason verbatim when blocked, and exits 4 (AC-43.2)", async () => {
    canExecute = { "OrderOperation.Ship": "The order is not in state Ordered" };
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run"]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    expect(r.out).toContain("The order is not in state Ordered");
  });

  it("reads a key absent from canExecute as not permitted, never as unknown (#112)", async () => {
    canExecute = {};
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run", "--json"]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    const doc = JSON.parse(r.out) as Record<string, string>;
    expect(doc["reason"]).toContain("gives no reason");
    expect(r.out + r.err).not.toContain("unknown operation");
  });

  it("says it checks permission, not success (AC-43.5), and works under an agent", async () => {
    canExecute = { "OrderOperation.Ship": null };
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out + r.err).toContain("not success"); // JSON off a terminal, so inside the document
  });

  it("composes with --explain: the request and the verdict, sending nothing (AC-43.6)", async () => {
    canExecute = { "OrderOperation.Ship": null };
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run", "--explain", "--json"]);
    expect(r.out).toContain("/api/operation/executeLite/OrderOperation.Ship");
    expect(r.out).toContain(`"permitted": true`);
    expect(operationCalls()).toEqual([]);
  });
});

describe("an agent acting through a handle (AC-53.2, AC-53.7)", () => {
  it("resolves the handle locally, gets a pseudonymized result, and the log keeps the real target", async () => {
    const handle = `${HANDLE_PREFIX}bbbbbbbbbbbb`;
    saveHandles({ [handle]: "Order;42" }, { SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
    const r = await cli(["OrderOperation.Ship", "--lite", handle, "--yes", "--json"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.body).toContain(`"id":42`);
    expect(r.out).not.toContain("Erika Mustermann");
    expect(r.out).not.toContain(`"id": 42`);
    const [line] = readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8").trim().split("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({ target: "Order;42", via: handle });
  });
});
