/**
 * `get --pack` and `get <Type>` — REQ-030's m2 half (#138, AC-30.3, AC-30.5).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { saveHandles } from "../src/core/handles.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";

const REFLECTION = {
  Order: { kind: "Entity", entityKind: "Main", entityData: "Transactional", queryDefined: true, members: {}, operations: {} },
  Country: { kind: "Entity", entityKind: "String", entityData: "Master", queryDefined: true, members: {}, operations: {} },
};

// An id past 2^53 and a decimal with a trailing zero: both must survive exactly (#111).
const COUNTRIES = `[` +
  `{"Type":"Country","id":1,"ticks":"1","toStr":"Germany","modified":false,"name":"Germany"},` +
  `{"Type":"Country","id":2,"ticks":"1","toStr":"France","modified":false,"name":"France"},` +
  `{"Type":"Country","id":9007199254740993,"ticks":"1","toStr":"Big","modified":false,"name":"Big","rate":1.10}]`;

const PACK = `{"entity":{"Type":"Order","id":42,"ticks":"1","toStr":"Order 42","modified":false,"name":"Acme",` +
  `"customer":{"EntityType":"Customer","id":7,"model":"Anna Müller"}},` +
  `"canExecute":{"OrderOperation.Ship":null,"OrderOperation.Cancel":"Already shipped"},` +
  `"approver":{"EntityType":"User","id":3,"model":"Erika Mustermann"}}`;

let server: ReturnType<typeof Bun.serve>;
let url: string;
let seen: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      const headers = { "content-type": "application/json" };
      if (path === "/api/reflection/types") return new Response(JSON.stringify(REFLECTION), { headers });
      if (path === "/api/entityPack/Order/42") return new Response(PACK, { headers });
      if (path === "/api/entityPack/Order/99") return new Response(JSON.stringify({ exceptionMessage: "Order 99 not found" }), { status: 404, headers });
      if (path === "/api/fetchAll/Country") return new Response(COUNTRIES, { headers });
      return new Response(JSON.stringify({ exceptionMessage: `unexpected ${path}` }), { status: 500, headers });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-get-pack-"));
  seen = [];
});

interface Result { code: ExitCode; out: string; err: string }
async function cli(argv: string[], context: "interactive" | "agent" = "interactive", extra: Record<string, string> = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: false,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: url, SIGNUM_TOKEN: "t", SIGNUM_CALLER_CONTEXT: context, ...extra } as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}
const sentFetches = () => seen.filter((p) => p !== "/api/reflection/types");

describe("get --pack (AC-30.3)", () => {
  it("returns the entity with canExecute, in one call to entityPack", async () => {
    const r = await cli(["get", "Order;42", "--pack", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(sentFetches()).toEqual(["/api/entityPack/Order/42"]);
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect((doc["entity"] as Record<string, unknown>)["name"]).toBe("Acme");
    expect(doc["canExecute"]).toEqual({ "OrderOperation.Ship": null, "OrderOperation.Cancel": "Already shipped" });
    // What the application added to its pack is kept.
    expect(doc["approver"]).toEqual({ EntityType: "User", id: 3, model: "Erika Mustermann" });
  });

  it("pseudonymizes the entity AND what the application added, for an agent", async () => {
    const r = await cli(["get", "Order", "42", "--pack", "--json"], "agent");
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).not.toContain("Anna Müller");
    expect(r.out).not.toContain("Erika Mustermann");
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect(String((doc["entity"] as Record<string, unknown>)["id"])).toStartWith(HANDLE_PREFIX);
    expect(String(doc["approver"])).toStartWith(HANDLE_PREFIX);
    // The permission map is metadata about the operations, and stays readable.
    expect(doc["canExecute"]).toEqual({ "OrderOperation.Ship": null, "OrderOperation.Cancel": "Already shipped" });
  });

  it("says, at a terminal, that an absent key was withheld rather than nonexistent (AC-08.5)", async () => {
    const r = await cli(["get", "Order;42", "--pack", "-o", "table"]);
    expect(r.err).toContain("withheld for this login");
  });

  it("a not-found behind a handle names the handle, never the id", async () => {
    saveHandles({ ref_aaaaaaaaaaaa: "Order;99" }, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv, { target: url });
    const r = await cli(["get", "ref_aaaaaaaaaaaa", "--pack"], "agent");
    expect(r.code).toBe(ExitCode.NotFound);
    expect(r.err).toContain("ref_aaaaaaaaaaaa not found");
    expect(r.err).not.toContain("99");
  });

  it("refuses what makes no sense, before any request", async () => {
    for (const [argv, msg] of [
      [["get", "Order;42", "--pack", "--exists"], "choose one of --pack and --exists"],
      [["get", "Order", "--pack"], "--pack is about one record"],
      [["get", "Order;42", "--top", "5"], "bound a listing"],
    ] as const) {
      const r = await cli([...argv]);
      expect(r.code).toBe(ExitCode.Usage);
      expect(r.err).toContain(msg);
    }
    expect(seen).toEqual([]);
  });
});

describe("get <Type> (AC-30.5)", () => {
  it("lists a master-data type through fetchAll, exactly", async () => {
    const r = await cli(["get", "Country", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(sentFetches()).toEqual(["/api/fetchAll/Country"]);
    expect(r.out).toContain("9007199254740993");
    expect(r.out).toContain("1.10");
    expect((JSON.parse(r.out) as unknown[]).length).toBe(3);
  });

  it("shows --top n and counts the rest; --all shows every one; ndjson is one per line", async () => {
    const top = await cli(["get", "Country", "--top", "2", "--json"]);
    expect((JSON.parse(top.out) as unknown[]).length).toBe(2);
    expect(top.err).toContain("2 of 3 shown (--top 2); --all shows every one");
    // Pseudonymized, the total is an aggregate it is not given (AC-51.3).
    const agent = await cli(["get", "Country", "--top", "2", "--json"], "agent");
    expect(agent.err).toContain("2 shown (--top 2); there are more");
    expect(agent.err).not.toContain("of 3");
    const all = await cli(["get", "Country", "--all", "-o", "ndjson"]);
    expect(all.out.trim().split("\n")).toHaveLength(3);
    expect(all.err).not.toContain("shown");
  });

  it("pseudonymizes each entity as its own document for an agent", async () => {
    const r = await cli(["get", "Country", "--json"], "agent");
    const docs = JSON.parse(r.out) as Array<Record<string, unknown>>;
    const ids = docs.map((d) => String(d["id"]));
    expect(ids.every((i) => i.startsWith(HANDLE_PREFIX))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(r.out).not.toContain("Germany");
  });

  it("refuses a transactional type without asking the server, pointing at the query that pages", async () => {
    const r = await cli(["get", "Order"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("transactional data");
    expect(r.err).toContain("signum query Order --entities --top 20");
    expect(sentFetches()).toEqual([]);
  });

  it("is data: an agent without pseudonymization and without the acknowledgement gets nothing", async () => {
    const r = await cli(["get", "Country"], "agent", { SIGNUM_PSEUDONYMIZE: "off" });
    expect(r.code).not.toBe(ExitCode.Ok);
    expect(sentFetches()).toEqual([]);
  });

  it("--explain shows the request and sends it not", async () => {
    const r = await cli(["get", "Country", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(r.out)).toMatchObject({ method: "GET", url: `${url}/api/fetchAll/Country` });
    expect(sentFetches()).toEqual([]);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
