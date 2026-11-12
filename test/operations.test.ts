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
    members: {
      Id: { type: { name: "number" } }, Name: { type: { name: "string" } },
      Customer: { type: { name: "Customer", isLite: true } },
      Address: { type: { name: "AddressEmbedded", isEmbedded: true } }, "Address.City": { type: { name: "string" } },
      Lines: { type: { name: "OrderLineEmbedded", isCollection: true } }, "Lines/Quantity": { type: { name: "number" } },
    },
    operations: {
      "OrderOperation.Ship": { operationType: "Execute", canBeModified: false },
      "OrderOperation.Save": { operationType: "Execute", canBeModified: true, canBeNew: true },
      "OrderOperation.Get": { operationType: "Execute" },            // shadowed by the built-in `get`
      "OrderOperation.Create": { operationType: "Constructor" },
      "OrderOperation.ImportPublicHolidays": { operationType: "Execute" },
      "LegacyOrderOperation.Ship": { operationType: "Execute" },     // a second `Ship` on Order
      "OrderOperation.Approve": { operationType: "Execute" },
      "OrderOperation.Delete": { operationType: "Delete" },
      "OrderOperation.Clone": { operationType: "ConstructorFrom" },
      "OrderOperation.Generate": { operationType: "Constructor", resultIsSaved: true },
      "OrderOperation.Decline": { operationType: "Constructor" },
      "OrderOperation.Merge": { operationType: "ConstructorFromMany" },
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
/** Per record id, for the bulk dry run; falls back to `canExecute`. */
let canExecuteById: Record<string, Record<string, string | null>> = {};
/** Ids whose bulk outcome is an error, and ids the stream leaves out. */
let failIds: string[] = [];
let silentIds: string[] = [];
/** Cut the multi endpoints' last NDJSON line in half, as a stream that broke off would. */
let truncateStream = false;
/** Send the multi endpoints' first line, then press Ctrl-C and never send the rest. */
let hangAfterFirst = false;
/** The interrupt handler the CLI registered through `io.onInterrupt`, if any. */
let interruptHandler: (() => void) | undefined;
/** What `executeLiteWithProgress` answers: a result, an error step, or a stream that stops early. */
let progressMode: "ok" | "error" | "cut" = "ok";

/** A record with MList rows, for documents that change, add and remove rows (#120). */
const ORDER_50 = `{"Type":"Order","id":50,"ticks":"5","toStr":"Order 50","modified":false,"name":"Initech","customer":null,` +
  `"lines":[{"rowId":1,"element":{"Type":"OrderLineEmbedded","toStr":"Widget","modified":false,"quantity":1,"product":"Widget"}},` +
  `{"rowId":2,"element":{"Type":"OrderLineEmbedded","toStr":"Gadget","modified":false,"quantity":2,"product":"Gadget"}}]}`;
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
      if (url.pathname === "/api/entity/Order/50") return new Response(ORDER_50, { headers });
      const multi = /^\/api\/operation\/(executeMultiple|deleteMultiple|constructFromMultiple)\//.exec(url.pathname);
      if (multi !== null) {
        if (answer === "forbidden") {
          return new Response(JSON.stringify({ exceptionType: "System.UnauthorizedAccessException", exceptionMessage: "Approve is not allowed" }), { status: 403, headers });
        }
        const { lites } = JSON.parse(body) as { lites: Array<{ EntityType: string; id: number }> };
        const lines = lites
          .filter((l) => !silentIds.includes(String(l.id)))
          .map((l) => JSON.stringify({ entity: { EntityType: l.EntityType, id: l.id, model: `Order ${l.id}` }, error: failIds.includes(String(l.id)) ? `Order ${l.id} cannot be approved` : null }));
        if (hangAfterFirst) {
          return new Response(new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode((lines[0] ?? "") + "\n"));
              setTimeout(() => interruptHandler?.(), 30);
            },
          }), { headers: { "content-type": "application/x-ndjson" } });
        }
        const text = lines.join("\n") + "\n";
        return new Response(truncateStream ? text.slice(0, text.length - Math.floor((lines.at(-1)?.length ?? 0) / 2)) : text,
          { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.pathname.startsWith("/api/operation/executeLiteWithProgress/")) {
        const steps = [
          `{"currentTask":"Shipping Acme","min":0,"max":2,"position":1,"isFinished":false}`,
          progressMode === "ok" ? `{"isFinished":true,"result":{"entity":${ORDER_42},"canExecute":{}}}`
          : progressMode === "error" ? `{"isFinished":true,"error":{"exceptionType":"Signum.Engine.ConcurrencyException","exceptionMessage":"changed"}}`
          : "",
        ].filter((l) => l !== "");
        return new Response(steps.join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.pathname === "/api/operation/constructFromMany/OrderOperation.Merge") {
        return new Response(`{"entity":{"Type":"Order","id":null,"isNew":true,"toStr":"","modified":true,"name":null},"canExecute":{}}`, { headers });
      }
      const pack = /^\/api\/entityPack\/Order\/(\d+)$/.exec(url.pathname);
      if (pack !== null && pack[1] !== "42") {
        return new Response(`{"entity":${ORDER_42.replace('"id":42', `"id":${pack[1]}`)},"canExecute":${JSON.stringify(canExecuteById[pack[1] as string] ?? canExecute)}}`, { headers });
      }
      if (url.pathname === "/api/exists/Order/42") return new Response("true", { headers });
      if (url.pathname === "/api/exists/Order/99") return new Response("false", { headers });
      if (url.pathname === "/api/entityPackEntity") {
        return new Response(`{"entity":${body},"canExecute":${JSON.stringify(canExecute)}}`, { headers });
      }
      if (url.pathname === "/api/operation/deleteLite/OrderOperation.Delete") return new Response(null, { status: 204 });
      if (url.pathname === "/api/operation/construct/OrderOperation.Decline") return new Response("null", { headers });
      if (url.pathname.startsWith("/api/operation/construct/")) {
        return new Response(`{"entity":{"Type":"Order","id":null,"isNew":true,"toStr":"","modified":true,"name":null},"canExecute":{}}`, { headers });
      }
      if (url.pathname === "/api/operation/executeEntity/OrderOperation.Save" && body.includes('"isNew":true')) {
        return new Response(`{"entity":{"Type":"Order","id":77,"ticks":"1","toStr":"New","modified":false,"name":"New"},"canExecute":{}}`, { headers });
      }
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
  canExecuteById = {};
  failIds = [];
  silentIds = [];
  truncateStream = false;
  hangAfterFirst = false;
  interruptHandler = undefined;
  progressMode = "ok";
});
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

interface Result { code: ExitCode; out: string; err: string; prompts: string[] }

async function cli(argv: string[], o: { tty?: boolean; reply?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<Result> {
  let out = "", err = "";
  const prompts: string[] = [];
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: o.tty === true,
    stdinIsTty: o.tty === true,
    env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: TOKEN, ...(o.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => o.stdin ?? "",
    ...(o.tty === true ? { prompt: async (q: string) => { prompts.push(q); return o.reply ?? ""; } } : {}),
    onInterrupt: (handler) => {
      interruptHandler = handler;
      return () => { if (interruptHandler === handler) interruptHandler = undefined; };
    },
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
    // `Name` as people and help write it; `name` on the wire.
    const r = await cli(["save", "order", "42", "--edit", "Name=Beta", "--yes"]);
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
    saveHandles({ [handle]: "Order;42" }, { SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv, { target: baseUrl });
    const r = await cli(["OrderOperation.Ship", "--lite", handle, "--yes", "--i-understand-an-agent-is-writing", "--json"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.body).toContain(`"id":42`);
    expect(r.out).not.toContain("Erika Mustermann");
    expect(r.out).not.toContain(`"id": 42`);
    const [line] = readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8").trim().split("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({ target: "Order;42", via: handle, caller: "agent" });
  });
});

/**
 * A detected agent changes data only with its own acknowledgement (AC-46.7). `--yes` is something an
 * agent types, and text planted in a row can talk it into typing it.
 */
describe("writes by a detected AI agent (AC-46.7)", () => {
  const agent = { env: { CLAUDECODE: "1" } };

  it("--yes alone is refused with exit 9, naming the acknowledgement, and nothing is sent", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"], agent);
    expect(r.code).toBe(ExitCode.Policy);
    expect(r.err).toContain("--i-understand-an-agent-is-writing");
    expect(r.err).toContain("CLAUDECODE");
    expect(operationCalls()).toEqual([]);
  });

  it("the acknowledgement for reading data does not stand in for it", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes", "--i-understand-data-goes-to-a-model"], agent);
    expect(r.code).toBe(ExitCode.Policy);
    expect(operationCalls()).toEqual([]);
  });

  it("is accepted as the flag or as SIGNUM_ALLOW_AGENT_WRITES=1, still with --yes", async () => {
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes", "--i-understand-an-agent-is-writing"], agent)).code).toBe(ExitCode.Ok);
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"], { env: { CLAUDECODE: "1", SIGNUM_ALLOW_AGENT_WRITES: "1" } })).code).toBe(ExitCode.Ok);
    // Without --yes it still fails: the acknowledgement is about who, --yes about this command.
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--i-understand-an-agent-is-writing"], agent)).code).toBe(ExitCode.Usage);
    expect(operationCalls()).toHaveLength(2);
  });

  it("needs nothing for --dry-run or --explain, which change nothing", async () => {
    canExecute = { "OrderOperation.Ship": null };
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--dry-run"], agent)).code).toBe(ExitCode.Ok);
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--explain"], agent)).code).toBe(ExitCode.Ok);
    expect(operationCalls()).toEqual([]);
  });

  it("does not apply to a script or a person", async () => {
    expect((await cli(["OrderOperation.Ship", "--lite", "Order;42", "--yes"])).code).toBe(ExitCode.Ok);
  });
});

describe("construct and delete (STORY-44, #118)", () => {
  it("constructs from nothing with an explicit Type, and says the result is NOT saved (AC-44.1)", async () => {
    const r = await cli(["create", "order", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const [call] = operationCalls();
    expect(call?.path).toBe("/api/operation/construct/OrderOperation.Create");
    expect(call?.body).toBe(`{"Type":"Order","args":null}`);
    expect(r.err).toContain("NOT saved");
  });

  it("does not call a constructor whose result is saved unsaved", async () => {
    const r = await cli(["OrderOperation.Generate", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("NOT saved");
  });

  it("reports a constructor that declines as an answer, not a crash (AC-44.5)", async () => {
    const r = await cli(["OrderOperation.Decline", "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("declined");
  });

  it("refuses a record for a constructor, which takes none", async () => {
    const r = await cli(["OrderOperation.Create", "--lite", "Order;42", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });

  it("creates a record with a Save and no target, from --edit values only (AC-44.4)", async () => {
    const r = await cli(["save", "order", "--edit", "Name=New", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const [call] = operationCalls();
    expect(call?.path).toBe("/api/operation/executeEntity/OrderOperation.Save");
    expect(call?.body).toBe(`{"entity":{"Type":"Order","isNew":true,"modified":true,"name":"New"},"args":null}`);
    expect((JSON.parse(r.out) as { entity: { id: number } }).entity.id).toBe(77);
    expect(r.err).toContain("created a new Order");
  });

  it("refuses a member the type does not have, for a new record", async () => {
    const r = await cli(["save", "order", "--edit", "Nmae=New", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("no member 'Nmae'");
    expect(operationCalls()).toEqual([]);
  });

  it("constructs from a record by its Lite (AC-44.2)", async () => {
    const r = await cli(["clone", "order", "42", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/constructFromLite/OrderOperation.Clone");
    expect(operationCalls()[0]?.body).toBe(`{"lite":{"EntityType":"Order","id":42},"args":null}`);
  });

  it("deletes behind the guard, saying it cannot be undone, and reports what is gone (AC-44.3)", async () => {
    const refused = await cli(["delete", "order", "42"]);
    expect(refused.code).toBe(ExitCode.Usage);
    const asked = await cli(["delete", "order", "42"], { tty: true, reply: "n" });
    expect(asked.prompts[0]).toContain("cannot be undone");
    expect(operationCalls()).toEqual([]);

    const r = await cli(["delete", "order", "42", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/deleteLite/OrderOperation.Delete");
    expect(JSON.parse(r.out)).toEqual({ deleted: "Order;42" });
  });

  it("a delete of a record that does not exist is a clean not-found, and sends no delete (#118)", async () => {
    const r = await cli(["delete", "order", "99", "--yes"]);
    expect(r.code).toBe(ExitCode.NotFound);
    expect(operationCalls()).toEqual([]);
  });

  it("refuses --edit on a delete, which would apply it to a record that is then removed", async () => {
    const r = await cli(["delete", "order", "42", "--edit", "Name=X", "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });

  it("answers --dry-run for delete, for a constructor and for a new record, sending no operation", async () => {
    canExecute = { "OrderOperation.Delete": "The order has lines" };
    const del = await cli(["delete", "order", "42", "--dry-run", "--json"]);
    expect(del.code).toBe(ExitCode.NotAuthorized);
    expect(del.out).toContain("The order has lines");

    const ctor = await cli(["create", "order", "--dry-run", "--json"]);
    expect(ctor.code).toBe(ExitCode.Ok);
    expect(ctor.out).toContain("constructor has no record to check");

    canExecute = { "OrderOperation.Save": null };
    const fresh = await cli(["save", "order", "--edit", "Name=New", "--dry-run", "--json"]);
    expect(fresh.code).toBe(ExitCode.Ok);
    expect(seen.map((s) => s.path)).toContain("/api/entityPackEntity");
    expect(operationCalls()).toEqual([]);
  });
});

describe("operations over many records (STORY-45, #119)", () => {
  const two = ["OrderOperation.Approve", "--lite", "Order;42", "--lite", "Order;43"];
  const auditLines = () => readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("sends one request with every Lite, and reports each record (AC-45.1)", async () => {
    const r = await cli([...two, "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const [call] = operationCalls();
    expect(call?.path).toBe("/api/operation/executeMultiple/OrderOperation.Approve");
    expect(call?.body).toBe(`{"lites":[{"EntityType":"Order","id":42},{"EntityType":"Order","id":43}],"args":null}`);
    expect(JSON.parse(r.out)).toEqual([{ target: "Order;42", ok: true }, { target: "Order;43", ok: true }]);
    expect(r.err).toContain("on 2 records");
  });

  it("a partial failure lists which failed and why, and exits 10; all failing is 1 (AC-45.3)", async () => {
    failIds = ["43"];
    const partial = await cli([...two, "--yes", "--json"]);
    expect(partial.code).toBe(ExitCode.PartialFailure);
    expect(JSON.parse(partial.out)).toEqual([
      { target: "Order;42", ok: true }, { target: "Order;43", ok: false, error: "Order 43 cannot be approved" },
    ]);
    failIds = ["42", "43"];
    expect((await cli([...two, "--yes"])).code).toBe(ExitCode.Unexpected);
  });

  it("a record the server never reports on counts as failed, not as done", async () => {
    silentIds = ["43"];
    const r = await cli([...two, "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.PartialFailure);
    expect(r.out).toContain("no outcome reported by the server");
  });

  it("an answer cut off mid-line still reports and logs every record, the unread one as failed", async () => {
    truncateStream = true;
    const r = await cli([...two, "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.PartialFailure);
    expect(JSON.parse(r.out)).toEqual([
      { target: "Order;42", ok: true },
      { target: "Order;43", ok: false, error: "no readable outcome: the server's answer was cut off or malformed; check the record" },
    ]);
    expect(auditLines().map((l) => [l["target"], l["ok"]])).toEqual([["Order;42", true], ["Order;43", false]]);
  });

  it("a 403 for the whole request gets the same hint as for one record, and every record is logged", async () => {
    answer = "forbidden";
    const r = await cli([...two, "--yes"]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    expect(r.err).toContain("hidden from the UI");
    expect(auditLines().map((l) => [l["target"], l["ok"], l["exitCode"]])).toEqual([["Order;42", false, 4], ["Order;43", false, 4]]);
  });

  it("logs one line per record with its own outcome (AC-46.6)", async () => {
    failIds = ["43"];
    await cli([...two, "--yes"]);
    expect(auditLines().map((l) => [l["target"], l["ok"]])).toEqual([["Order;42", true], ["Order;43", false]]);
  });

  it("states the count when it refuses without --yes, and when it asks (AC-45.5)", async () => {
    const refused = await cli(two);
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.err).toContain("2 records without --yes");
    const asked = await cli(two, { tty: true, reply: "y" });
    expect(asked.prompts[0]).toContain("2 records");
    expect(asked.code).toBe(ExitCode.Ok);
  });

  it("asks for the count to be typed from 10 records, and for any delete of several (AC-46.5)", async () => {
    const ten = ["OrderOperation.Approve", ...Array.from({ length: 10 }, (_, i) => ["--lite", `Order;${100 + i}`]).flat()];
    const yes = await cli(ten, { tty: true, reply: "y" });
    expect(yes.prompts[0]).toContain("Type 10 to confirm");
    expect(yes.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
    expect((await cli(ten, { tty: true, reply: "10" })).code).toBe(ExitCode.Ok);

    const del = await cli(["delete", "order", "42", "43"], { tty: true, reply: "y" });
    expect(del.prompts[0]).toContain("cannot be undone");
    expect(del.prompts[0]).toContain("Type 2 to confirm");
    expect(del.code).toBe(ExitCode.Usage);
    expect((await cli(["delete", "order", "42", "43"], { tty: true, reply: "2" })).code).toBe(ExitCode.Ok);
    expect(operationCalls().map((c) => c.path)).toContain("/api/operation/deleteMultiple/OrderOperation.Delete");
  });

  it("--dry-run answers per record from each entity pack, sending no operation", async () => {
    canExecuteById = { "43": { "OrderOperation.Approve": "Order 43 is closed" }, "44": { "OrderOperation.Approve": null } };
    const r = await cli(["OrderOperation.Approve", "--lite", "Order;43", "--lite", "Order;44", "--dry-run", "--json"]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    expect(JSON.parse(r.out)).toEqual([
      { target: "Order;43", ok: false, error: "Order 43 is closed" }, { target: "Order;44", ok: true },
    ]);
    expect(operationCalls()).toEqual([]);
  });

  it("constructs one record from many as a pack (constructFromMany)", async () => {
    const r = await cli(["merge", "order", "42", "43", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.body).toBe(`{"lites":[{"EntityType":"Order","id":42},{"EntityType":"Order","id":43}],"args":null,"type":"Order"}`);
    expect(r.err).toContain("NOT saved");
  });

  it("refuses --edit over many records, and a record named twice", async () => {
    expect((await cli([...two, "--edit", "Name=X", "--yes"])).code).toBe(ExitCode.Usage);
    expect((await cli(["OrderOperation.Approve", "--lite", "Order;42", "--lite", "Order;42", "--yes"])).code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });

  it("--explain prints the bulk request and sends nothing", async () => {
    const r = await cli([...two, "--explain"]);
    expect(JSON.parse(r.out)).toMatchObject({ body: { lites: [{ EntityType: "Order", id: 42 }, { EntityType: "Order", id: 43 }] } });
    expect(operationCalls()).toEqual([]);
  });
});

describe("values over many records, interruption and progress (STORY-45, #119)", () => {
  const two = ["OrderOperation.Save", "--lite", "Order;42", "--lite", "Order;43"];
  const sentBody = () => JSON.parse(operationCalls()[0]?.body ?? "{}") as Record<string, unknown>;
  const auditLines = () => readFileSync(auditLogPath({ SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("sends --edit over many records as setters, spelled as reflection spells them (AC-45.4)", async () => {
    const r = await cli([...two, "--edit", "name=Acme", "--edit", "address.city=Berlin", "--edit", "Customer=Customer;7", "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/executeMultiple/OrderOperation.Save");
    expect(sentBody()["setters"]).toEqual([
      { property: "Name", operation: "Set", value: "Acme" },
      { property: "Address.City", operation: "Set", value: "Berlin" },
      { property: "Customer", operation: "Set", value: { EntityType: "Customer", id: 7 } },
    ]);
  });

  it("resolves a handle in a value locally, and --explain keeps it as written (AC-53.2)", async () => {
    const handle = `${HANDLE_PREFIX}abcdef123456`;
    saveHandles({ [handle]: "Customer;7" }, { SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv, { target: baseUrl });
    const shown = await cli([...two, "--edit", `Customer=${handle}`, "--explain"]);
    expect(shown.out).toContain(handle);
    expect(shown.out).not.toContain('"id": 7');
    await cli([...two, "--edit", `Customer=${handle}`, "--yes"]);
    expect(sentBody()["setters"]).toEqual([{ property: "Customer", operation: "Set", value: { EntityType: "Customer", id: 7 } }]);
  });

  it("names the values in the confirmation", async () => {
    const r = await cli([...two, "--edit", "Name=Acme"], { tty: true, reply: "y" });
    expect(r.prompts[0]).toContain('setting Name="Acme"');
  });

  it("refuses values where they would be discarded, or cannot be addressed, sending nothing", async () => {
    const lite = await cli(["OrderOperation.Approve", "--lite", "Order;42", "--lite", "Order;43", "--edit", "Name=X", "--yes"]);
    expect(lite.code).toBe(ExitCode.Usage);
    expect(lite.err).toContain("would be discarded");
    const del = await cli(["OrderOperation.Delete", "--lite", "Order;42", "--lite", "Order;43", "--edit", "Name=X", "--yes"]);
    expect(del.code).toBe(ExitCode.Usage);
    const row = await cli([...two, "--edit", "Lines.0.Quantity=3", "--yes"]);
    expect(row.code).toBe(ExitCode.Usage);
    expect(row.err).toContain("--setters-json");
    const list = await cli([...two, "--edit", "Lines=3", "--yes"]);
    expect(list.err).toContain("is a list");
    const unknown = await cli([...two, "--edit", "Colour=red", "--yes"]);
    expect(unknown.err).toContain("has no member 'Colour'");
    expect(operationCalls()).toEqual([]);
  });

  it("passes --setters-json through, checked for shape, for MList rows (AC-45.4)", async () => {
    const setters = [{
      property: "Lines", operation: "ChangeElements",
      predicate: [{ property: "Quantity", filterOperation: "EqualTo", value: 1 }],
      setters: [{ property: "Quantity", operation: "Set", value: 2 }],
    }];
    const r = await cli([...two, "--setters-json", JSON.stringify(setters), "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(sentBody()["setters"]).toEqual(setters);
  });

  it("names where --setters-json is wrong, and sends nothing", async () => {
    const cases: Array<[unknown, string]> = [
      [[{ property: "Name" }], "[0]: needs an \"operation\""],
      [[{ property: "Name", operation: "Set" }], "Set needs a \"value\""],
      [[{ property: "Name", operation: "Set", value: 1, colour: "red" }], "unknown field 'colour'"],
      [[{ property: "Lines", operation: "ChangeElements", predicate: [{ property: "Quantity", value: 1 }], setters: [{ property: "Quantity", operation: "Set", value: 2 }] }],
        "[0].predicate[0]: a predicate needs a \"filterOperation\""],
      [[], "non-empty JSON array"],
    ];
    for (const [json, message] of cases) {
      const r = await cli([...two, "--setters-json", JSON.stringify(json), "--yes"]);
      expect(r.code).toBe(ExitCode.Usage);
      expect(r.err).toContain(message);
    }
    expect(operationCalls()).toEqual([]);
  });

  it("--setters-json makes even one record a bulk operation, and reads @file", async () => {
    const file = join(configDir, "setters.json");
    await Bun.write(file, JSON.stringify([{ property: "Name", operation: "Set", value: "Müller – Ωmega" }]));
    const r = await cli(["OrderOperation.Save", "--lite", "Order;42", "--setters-json", `@${file}`, "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/executeMultiple/OrderOperation.Save");
    expect(sentBody()["setters"]).toEqual([{ property: "Name", operation: "Set", value: "Müller – Ωmega" }]);
  });

  it("a dry run says the values are not checked", async () => {
    canExecute = { "OrderOperation.Save": null };
    const r = await cli([...two, "--edit", "Name=X", "--dry-run"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("values to set are not checked");
    expect(operationCalls()).toEqual([]);
  });

  it("interrupted mid-batch, keeps what was reported, logs every record, and says how far it got (AC-45.6)", async () => {
    hangAfterFirst = true;
    const r = await cli(["OrderOperation.Approve", "--lite", "Order;42", "--lite", "Order;43", "--yes", "-o", "table"]);
    expect(r.code).toBe(ExitCode.Interrupted);
    expect(r.out).toContain("ok  Order;42");
    expect(r.out).toContain("FAILED  Order;43: interrupted before the server reported it");
    expect(r.err).toContain("the server reported 1 of 2 records");
    expect(auditLines().map((l) => [l["target"], l["ok"], l["exitCode"]])).toEqual([["Order;42", true, undefined], ["Order;43", false, 130]]);
  });

  it("shows each outcome as it arrives, before the batch ends", async () => {
    hangAfterFirst = true;
    const r = await cli(["OrderOperation.Approve", "--lite", "Order;42", "--lite", "Order;43", "--yes", "-o", "ndjson"]);
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ target: "Order;42", ok: true });
  });

  it("reads the records from stdin, a query's rows included (#119, #120)", async () => {
    const handle = `${HANDLE_PREFIX}0123456789ab`;
    saveHandles({ [handle]: "Order;43" }, { SIGNUM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv, { target: baseUrl });
    const rows = `{"Entity":"Order;42","Name":"x"}\n{"Entity":"${handle}","Name":"y"}\n`;
    const r = await cli(["OrderOperation.Approve", "--lite", "-", "--yes", "--json"], { stdin: rows });
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(operationCalls()[0]?.body ?? "{}").lites).toEqual([{ EntityType: "Order", id: 42 }, { EntityType: "Order", id: 43 }]);
    expect(JSON.parse(r.out)).toEqual([{ target: "Order;42", ok: true }, { target: handle, ok: true }]);
  });

  it("--progress runs one record through executeLiteWithProgress and renders its result (AC-45.2)", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(operationCalls()[0]?.path).toBe("/api/operation/executeLiteWithProgress/OrderOperation.Ship");
    expect(JSON.parse(operationCalls()[0]?.body ?? "{}")).toEqual({ lite: { EntityType: "Order", id: 42 }, args: null });
    expect(JSON.parse(r.out).entity.Type).toBe("Order");
  });

  it("--progress under -o ndjson streams each step, then the result", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes", "-o", "ndjson", "--pseudonymize", "off"]);
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ currentTask: "Shipping Acme", min: 0, max: 2, position: 1 });
    expect((lines[1]?.["entity"] as Record<string, unknown>)["Type"]).toBe("Order");
  });

  it("--progress shows a step at a terminal on stderr, rewritten in place", async () => {
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes", "--pseudonymize", "off"], { tty: true });
    expect(r.err).toContain("[1/2] Shipping Acme");
  });

  it("--progress reports an error step as the error it is, and a stream that stops early as one", async () => {
    progressMode = "error";
    const failed = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes"]);
    expect(failed.code).toBe(ExitCode.Concurrency);
    expect(auditLines().at(-1)?.["ok"]).toBe(false);
    progressMode = "cut";
    const cut = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes"]);
    expect(cut.code).toBe(ExitCode.Transport);
    expect(cut.err).toContain("ended before OrderOperation.Ship finished");
  });

  it("refuses --progress with --edit, and over many records", async () => {
    const edit = await cli(["OrderOperation.Save", "--lite", "Order;42", "--edit", "Name=X", "--progress", "--yes"]);
    expect(edit.code).toBe(ExitCode.Usage);
    const many = await cli(["OrderOperation.Ship", "--lite", "Order;42", "--lite", "Order;43", "--progress", "--yes"]);
    expect(many.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });
});

describe("structured input: -f, @file and - (REQ-054, #120)", () => {
  const saved = () => JSON.parse(operationCalls()[0]?.body ?? "{}").entity as Record<string, unknown>;
  const write = async (name: string, value: unknown): Promise<string> => {
    const path = join(configDir, name);
    await Bun.write(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  /** The record as `get` writes it, pseudonymized under the default policy: what a caller edits. */
  const got = async (key: string): Promise<Record<string, unknown>> =>
    JSON.parse((await cli(["get", key, "-o", "json", "--pseudonymize", "heuristic"])).out);

  it("applies a pseudonymized document's one change onto the real record, and nothing else (#120)", async () => {
    const doc = await got("Order;42");
    expect(doc["name"]).not.toBe("Acme");            // the caller never saw the real values…
    doc["name"] = "Globex";
    const file = await write("order.json", doc);
    seen = [];
    const r = await cli(["save", "order", "-f", file, "--yes", "--pseudonymize", "heuristic"]);
    expect(r.code).toBe(ExitCode.Ok);
    const e = saved();
    expect(e["name"]).toBe("Globex");
    expect(e["modified"]).toBe(true);
    // …and none of their surrogates or handles reach the record: everything left alone stays real.
    expect(e["id"]).toBe(42);
    expect(e["ticks"]).toBe("638500000000000017");
    expect(e["customer"]).toEqual({ EntityType: "Customer", id: 9, model: "Erika Mustermann" });
    expect(operationCalls()[0]?.path).toBe("/api/operation/executeEntity/OrderOperation.Save");
  });

  it("a document that changes nothing sends nothing (AC-32.4)", async () => {
    const file = await write("same.json", await got("Order;42"));
    seen = [];
    const r = await cli(["save", "order", "-f", file, "--yes", "--pseudonymize", "heuristic"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("changes nothing");
    expect(operationCalls()).toEqual([]);
  });

  it("refuses a pseudonym copied into a changed value", async () => {
    const doc = await got("Order;42");
    doc["name"] = "name-1fd8";
    const r = await cli(["save", "order", "-f", await write("p.json", doc), "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("is a pseudonym, not a value");
    expect(operationCalls()).toEqual([]);
  });

  it("changes, removes and adds MList rows by rowId (AC-31.3)", async () => {
    const doc = await got("Order;50");
    const lines = doc["lines"] as Array<{ rowId: unknown; element: Record<string, unknown> }>;
    (lines[1] as { element: Record<string, unknown> }).element["quantity"] = 5;
    doc["lines"] = [lines[1], { rowId: null, element: { Type: "OrderLineEmbedded", quantity: 3, product: "Doohickey" } }];
    seen = [];
    const file = await write("rows.json", doc);
    // Read pseudonymized, saved without: the surrogates left in it are refused, never written.
    const mismatched = await cli(["save", "order", "-f", file, "--yes", "--pseudonymize", "off"]);
    expect(mismatched.code).toBe(ExitCode.Usage);
    expect(mismatched.err).toContain("is a pseudonym");
    const r = await cli(["save", "order", "-f", file, "--yes", "--pseudonymize", "heuristic"]);
    expect(r.code).toBe(ExitCode.Ok);
    const e = saved();
    expect(e["name"]).toBe("Initech");
    expect(e["modified"]).toBe(true);
    expect(e["lines"]).toEqual([
      { rowId: 2, element: { Type: "OrderLineEmbedded", toStr: "Gadget", modified: true, quantity: 5, product: "Gadget" } },
      { rowId: null, element: { Type: "OrderLineEmbedded", modified: true, quantity: 3, product: "Doohickey" } },
    ]);
  });

  it("a document written before the record changed is a conflict, exit 7, and sends nothing (#117)", async () => {
    const doc = await got("Order;42");
    doc["name"] = "Globex";
    doc["ticks"] = "1";
    const r = await cli(["save", "order", "-f", await write("stale.json", doc), "--yes"]);
    expect(r.code).toBe(ExitCode.Concurrency);
    expect(operationCalls()).toEqual([]);
  });

  it("takes the record from the document's id, and refuses a different one named beside it", async () => {
    const doc = { Type: "Order", id: 42, name: "Globex" };
    const file = await write("plain.json", doc);
    const r = await cli(["save", "order", "-f", file, "--yes", "--pseudonymize", "off"]);
    expect(r.code).toBe(ExitCode.Ok);
    const clash = await cli(["save", "order", "43", "-f", file, "--yes"]);
    expect(clash.code).toBe(ExitCode.Usage);
    expect(clash.err).toContain("but the command names 43");
  });

  it("creates a record from a document without an id, as the operation's pack or the bare entity (AC-44.4)", async () => {
    const pack = { entity: { Type: "Order", id: null, isNew: true, toStr: "", name: "Hooli", customer: "Customer;7" }, canExecute: {} };
    const r = await cli(["save", "order", "-f", await write("new.json", pack), "--yes"]);
    expect(r.code).toBe(ExitCode.Ok);
    const e = saved();
    expect(e).toMatchObject({ Type: "Order", isNew: true, modified: true, name: "Hooli", customer: { EntityType: "Customer", id: 7 } });
    expect("id" in e).toBe(false);
  });

  it("refuses to create a record from a pseudonymized document", async () => {
    const doc = { Type: "Order", id: null, isNew: true, toStr: "toStr-1a2b", name: "name-1a2b" };
    const r = await cli(["save", "order", "-f", await write("pnew.json", doc), "--yes"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("written pseudonymized");
    expect(operationCalls()).toEqual([]);
  });

  it("reads the document from stdin, and refuses two flags that both want it", async () => {
    const r = await cli(["save", "order", "-f", "-", "--yes", "--pseudonymize", "off"], { stdin: '{"Type":"Order","id":42,"name":"Globex"}' });
    expect(r.code).toBe(ExitCode.Ok);
    expect(saved()["name"]).toBe("Globex");
    const both = await cli(["OrderOperation.Save", "--lite", "-", "-f", "-", "--yes"], { stdin: "Order;42" });
    expect(both.code).toBe(ExitCode.Usage);
    expect(both.err).toContain("both read stdin");
  });

  it("refuses -f where the document would be discarded, or over many records", async () => {
    const file = await write("d.json", { Type: "Order", id: 42, name: "Globex" });
    const lite = await cli(["OrderOperation.Ship", "-f", file, "--yes"]);
    expect(lite.code).toBe(ExitCode.Usage);
    expect(lite.err).toContain("would be discarded");
    const many = await cli(["OrderOperation.Save", "--lite", "Order;42", "--lite", "Order;43", "-f", file, "--yes"]);
    expect(many.code).toBe(ExitCode.Usage);
    expect(operationCalls()).toEqual([]);
  });

  it("--explain describes the document's changes without resolving its handles", async () => {
    const doc = await got("Order;42");
    doc["name"] = "Globex";
    const r = await cli(["save", "order", "-f", await write("x.json", doc), "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("with the changes in -f");
    expect(r.out).not.toContain("Customer;9");
  });

  it("a missing, unreadable or non-UTF-8 file is a clean usage error naming it", async () => {
    const missing = await cli(["save", "order", "-f", "/no/such/order.json", "--yes"]);
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.err).toContain("could not read -f file '/no/such/order.json': no such file");
    const dir = await cli(["save", "order", "-f", configDir, "--yes"]);
    expect(dir.err).toContain("it is a directory");
    const latin1 = join(configDir, "latin1.json");
    await Bun.write(latin1, new Uint8Array([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xfc, 0x22, 0x7d])); // {"n":"<0xFC>"}
    const bad = await cli(["save", "order", "-f", latin1, "--yes"]);
    expect(bad.code).toBe(ExitCode.Usage);
    expect(bad.err).toContain("is not valid UTF-8");
    const lites = await cli(["OrderOperation.Approve", "--lite", "@/no/such/list.txt", "--yes"]);
    expect(lites.err).toContain("could not read --lite file");
  });

  it("decodes UTF-8 with a byte-order mark, non-ASCII intact", async () => {
    const file = join(configDir, "bom.json");
    await Bun.write(file, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"Type":"Order","id":42,"name":"Müller – Ωmega"}')]));
    const r = await cli(["save", "order", "-f", `@${file}`, "--yes", "--pseudonymize", "off"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(saved()["name"]).toBe("Müller – Ωmega");
  });
});
