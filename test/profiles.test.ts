/**
 * Profiles (REQ-001, STORY-05, #121): several target applications on one machine, which one a
 * command reaches, and what is kept apart per target.
 *
 * Two mock applications hold the SAME record, `Order;42`, under different names — test data and
 * production data share ids all the time. Everything here is about not confusing the two: the
 * resolution order that picks the target, and the handle store that must not let a handle minted
 * against one reach the other's record.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { ExitCode, exitCodeOf, CliError } from "../src/core/errors.ts";
import { addInstance } from "../src/core/instances.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";

const REFLECTION = {
  Order: {
    kind: "Entity", entityKind: "Main", niceName: "Order", queryDefined: true,
    members: { Id: { type: { name: "number" } }, Name: { type: { name: "string" } } },
    operations: { "OrderOperation.Ship": { operationType: "Execute", canBeModified: false } },
  },
};

interface App { url: string; name: string; seen: string[]; server: ReturnType<typeof Bun.serve> }

function app(name: string, customer: string): App {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      const headers = { "content-type": "application/json" };
      if (path === "/api/reflection/types") return new Response(JSON.stringify(REFLECTION), { headers });
      if (path === "/api/auth/currentUser") return new Response(JSON.stringify({ userName: `${name}-user` }), { headers });
      if (path === "/api/entity/Order/42") {
        return new Response(`{"Type":"Order","id":42,"ticks":"1","toStr":"Order 42","modified":false,"name":"${customer}"}`, { headers });
      }
      return new Response(JSON.stringify({ exceptionMessage: "unhandled" }), { status: 404, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, name, seen, server };
}

let test: App;
let prod: App;
beforeAll(() => {
  test = app("test", "Acme Test");
  prod = app("prod", "Real Customer GmbH");
});
afterAll(() => {
  test.server.stop(true);
  prod.server.stop(true);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-profiles-"));
  test.seen.length = 0;
  prod.seen.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Result { code: ExitCode; out: string; err: string; prompts: string[] }

async function cli(argv: string[], o: { env?: Record<string, string>; stdin?: string; tty?: boolean; reply?: string } = {}): Promise<Result> {
  let out = "", err = "";
  const prompts: string[] = [];
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: o.tty === true,
    stdinIsTty: o.stdin === undefined,
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_CALLER_CONTEXT: "automated", ...(o.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => o.stdin ?? "",
    ...(o.tty === true ? { prompt: async (q: string) => { prompts.push(q); return o.reply ?? ""; } } : {}),
  };
  try {
    return { code: await run(argv, io), out, err, prompts };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err, prompts };
  }
}

const login = (a: App) => cli(["auth", "login", "--url", a.url, "--with-token"], { stdin: `${a.name}-token` });
const targetOf = async (args: string[], env: Record<string, string> = {}): Promise<string | null> =>
  (JSON.parse((await cli(["auth", "status", "--json", ...args], { env })).out) as { target: string | null }).target;

/** `get` as an agent: the record's id comes back as its handle, stored for that target. */
async function handleFor(a: App): Promise<string> {
  const r = await cli(["get", "Order;42", "--json", "--url", a.url], { env: { SIGNUM_CALLER_CONTEXT: "agent", SIGNUM_TOKEN: "t" } });
  expect(r.code).toBe(ExitCode.Ok);
  return String((JSON.parse(r.out) as { id: unknown }).id);
}

describe("which target a command reaches (AC-05.2)", () => {
  it("takes the flag, then the environment, then the default, and fails with none", async () => {
    // None at all: a command that needs a target fails, naming every way to give one.
    const none = await cli(["types"]);
    expect(none.code).toBe(ExitCode.Usage);
    expect(none.err).toContain("no target application specified");

    await login(test);
    await login(prod);
    addInstance("test", test.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    addInstance("prod", prod.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);

    // The default is the latest login…
    expect(await targetOf([])).toBe(prod.url);
    // …the environment beats it…
    expect(await targetOf([], { SIGNUM_URL: test.url })).toBe(test.url);
    expect(await targetOf([], { SIGNUM_INSTANCE: "test" })).toBe(test.url);
    // …and a flag beats the environment.
    expect(await targetOf(["--url", prod.url], { SIGNUM_URL: test.url })).toBe(prod.url);
    expect(await targetOf(["-i", "prod"], { SIGNUM_INSTANCE: "test" })).toBe(prod.url);
  });

  it("auth switch changes the default, and a variable still takes precedence over it", async () => {
    await login(test);
    await login(prod);
    addInstance("test", test.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    const sw = await cli(["auth", "switch", "test"]);
    expect(sw.code).toBe(ExitCode.Ok);
    expect(sw.out).toContain(`Default target: test (${test.url})`);
    expect(await targetOf([])).toBe(test.url);
    expect(await targetOf([], { SIGNUM_URL: prod.url })).toBe(prod.url);
    const noted = await cli(["auth", "switch", prod.url], { env: { SIGNUM_URL: test.url } });
    expect(noted.err).toContain("SIGNUM_URL is set and still takes precedence");
  });

  it("auth switch refuses a target nobody logged in to, saying how to", async () => {
    addInstance("test", test.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    const r = await cli(["auth", "switch", "test"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("no stored credential for test");
    expect(r.err).toContain("signum -i test auth login");
    const unknown = await cli(["auth", "switch", "tset"]);
    expect(unknown.err).toContain("Did you mean 'test'?");
  });
});

describe("auth status names the profiles (AC-05.4)", () => {
  it("lists every profile, marks the active one and the default, and prints no token", async () => {
    await login(test);
    await login(prod);
    addInstance("test", test.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    addInstance("idle", "https://idle.example", { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    prod.seen.length = 0; // the logins contacted it; from here only `test` may be

    const json = JSON.parse((await cli(["auth", "status", "--json", "-i", "test"])).out) as {
      instance: string | null; profiles: Array<{ instance: string | null; url: string; credential: string; active: boolean; default: boolean }>;
    };
    expect(json.instance).toBe("test");
    expect(json.profiles).toEqual(expect.arrayContaining([
      { instance: "test", url: test.url, credential: "stored", active: true, default: false },
      { instance: null, url: prod.url, credential: "stored", active: false, default: true },
      { instance: "idle", url: "https://idle.example", credential: "none", active: false, default: false },
    ]));

    const text = await cli(["auth", "status", "-i", "test", "-o", "table"]);
    expect(text.out).toContain(`Target        test (${test.url})`);
    expect(text.out).toMatch(/\* test\s+http/);
    expect(text.out + text.err).not.toContain("test-token");
    expect(text.out + text.err).not.toContain("prod-token");
    // Only the active target is contacted; the list is local state.
    expect(prod.seen).toEqual([]);
  });
});

describe("no config file is needed (AC-05.3)", () => {
  it("runs from flags and variables alone", async () => {
    const r = await cli(["types", "--url", test.url, "-o", "json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(existsSync(join(dir, "credential.json"))).toBe(false);
    expect(existsSync(join(dir, "instances.json"))).toBe(false);
  });
});

describe("what is kept per target (#121, AC-53.6)", () => {
  it("a handle minted against one application does not resolve against another", async () => {
    const minted = await handleFor(test);
    expect(minted).toStartWith(HANDLE_PREFIX);
    // Against its own application it acts on the record…
    const own = await cli(["get", minted, "--json", "--url", test.url], { env: { SIGNUM_CALLER_CONTEXT: "agent", SIGNUM_TOKEN: "t" } });
    expect(own.code).toBe(ExitCode.Ok);
    // …against the other it is unknown, and the other application is never asked for Order;42 —
    // which there is a different customer's record.
    prod.seen.length = 0;
    const other = await cli(["get", minted, "--json", "--url", prod.url], { env: { SIGNUM_CALLER_CONTEXT: "agent", SIGNUM_TOKEN: "t" } });
    expect(other.code).toBe(ExitCode.Usage);
    expect(other.err).toContain(`cannot resolve ${minted}`);
    expect(other.err).toContain("per target application");
    expect(prod.seen).not.toContain("/api/entity/Order/42");
  });

  it("gives the same record a different handle, and the same value a different surrogate, in each", async () => {
    const inTest = await handleFor(test);
    const inProd = await handleFor(prod);
    expect(inTest).not.toBe(inProd);
    // Each in its own store, so `unmask --clear` and friends see both.
    expect(readdirSync(join(dir, "targets")).length).toBe(2);
  });

  it("unmask, for a person, still reads every application's handles", async () => {
    const a = await handleFor(test);
    const b = await handleFor(prod);
    const r = await cli(["unmask", a, b], { tty: true, env: { SIGNUM_CALLER_CONTEXT: "interactive" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Order;42");
    const cleared = await cli(["unmask", "--clear", "--yes"], { env: { SIGNUM_CALLER_CONTEXT: "interactive" } });
    expect(cleared.code).toBe(ExitCode.Ok);
    expect(readdirSync(join(dir, "targets")).flatMap((d) => readdirSync(join(dir, "targets", d)))).not.toContain("handles.json");
  });
});

describe("the confirmation names the profile (AC-05.6)", () => {
  it("says which instance a write goes to, not only its URL", async () => {
    addInstance("prod", prod.url, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    const r = await cli(["OrderOperation.Ship", "--lite", "Order;42", "-i", "prod"], {
      tty: true, reply: "n", env: { SIGNUM_TOKEN: "t", SIGNUM_CALLER_CONTEXT: "interactive" },
    });
    expect(r.prompts[0]).toContain(`at prod (${prod.url})`);
    expect(r.code).toBe(ExitCode.Usage);
  });
});
