/**
 * `--explain` on every command that sends a request (REQ-053, #122).
 *
 * The rule is enforced in one place — `SignumHttp` shows any request not marked `prepare` and sends
 * nothing — so this test does not trust a command to have remembered the flag. It enumerates EVERY
 * built-in and subcommand from the help registry, and fails when one is missing from the table
 * below: a new command must be classified before the suite passes, and a request-issuing one is then
 * run with `--explain` against a server that records what reached it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { saveHandles } from "../src/core/handles.ts";
import { COMMANDS } from "../src/core/help.ts";
import { SignumHttp } from "../src/core/http.ts";

const TOKEN = "secret-explain-token-7f3a";

const REFLECTION = {
  Order: {
    kind: "Entity", entityKind: "Main", niceName: "Order", queryDefined: true,
    members: { Id: { type: { name: "number" } }, Name: { type: { name: "string" } } },
    operations: {
      "OrderOperation.Ship": { operationType: "Execute", canBeModified: false },
      "OrderOperation.Save": { operationType: "Execute", canBeModified: true, canBeNew: true },
    },
  },
};

/** Reads a command may send under --explain to BUILD its request — never the request itself. */
const PREPARATION = [/^\/api\/reflection\/types$/, /^\/api\/query\/parseTokens$/, /^\/api\/query\/description\//, /^\/api\/entityPack\//];

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
      if (path === "/api/query/parseTokens") {
        return new Response(JSON.stringify([{ key: "Entity", fullKey: "Entity", niceName: "Entity", type: { name: "Order" }, queryTokenType: "Entity" }]), { headers });
      }
      if (path.startsWith("/api/query/description/")) {
        return new Response(JSON.stringify({ queryKey: "Order", columns: { Entity: { name: "Entity", fullKey: "Entity", niceName: "Entity", type: { name: "Order" } } } }), { headers });
      }
      if (path.startsWith("/api/entityPack/")) return new Response(`{"entity":{"Type":"Order","id":42},"canExecute":{"OrderOperation.Ship":null}}`, { headers });
      return new Response(JSON.stringify({ exceptionMessage: `the mock was not supposed to be asked for ${path}` }), { status: 500, headers });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-explain-"));
  seen = [];
});

interface Result { code: ExitCode; out: string; err: string }

async function cli(argv: string[], o: { stdin?: string; human?: boolean } = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: false,
    stdinIsTty: o.stdin === undefined,
    env: {
      SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: url, SIGNUM_TOKEN: TOKEN,
      SIGNUM_CALLER_CONTEXT: o.human === true ? "interactive" : "automated",
    } as NodeJS.ProcessEnv,
    readStdin: async () => o.stdin ?? "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

type Case =
  | { sends: true; argv: string[]; stdin?: string; human?: boolean; setup?: () => void; after?: () => void }
  | { sends: false; why: string };

/**
 * Every command and subcommand, classified. `sends: false` names why it has no request to explain;
 * the rest are run below. A key missing here fails the first test.
 */
const CASES: Record<string, Case[]> = {
  help: [{ sends: false, why: "static text" }],
  version: [{ sends: true, argv: ["version"] }],
  "auth login": [{
    sends: true, argv: ["auth", "login", "--with-token"], stdin: "a-pasted-token",
    // Explained, so nothing is stored either.
    after: () => expect(existsSync(join(dir, "credential.json"))).toBe(false),
  }],
  "auth status": [{ sends: true, argv: ["auth", "status"] }],
  "auth whoami": [{ sends: true, argv: ["auth", "whoami"] }],
  "auth switch": [{ sends: false, why: "changes the local default target only" }],
  "auth logout": [{ sends: false, why: "removes a local credential; Signum revokes nothing (AC-07.2)" }],
  types: [{ sends: true, argv: ["types"] }],
  queries: [{ sends: true, argv: ["queries"] }],
  operations: [{ sends: true, argv: ["operations", "Order"] }],
  explain: [
    { sends: true, argv: ["explain", "Order"] },
    { sends: true, argv: ["explain", "Order.Entity"] },
  ],
  query: [{ sends: true, argv: ["query", "Order"] }],
  get: [{ sends: true, argv: ["get", "Order;42"] }],
  unmask: [{
    sends: true, human: true, argv: ["unmask", "--in", "WORK", "--labels", "fetch"],
    setup: () => {
      saveHandles({ ref_aaaaaaaaaaaa: "Order;42" }, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv, { target: url });
      writeFileSync(join(dir, "WORK", "r.md"), "ref_aaaaaaaaaaaa");
    },
    // Stopped before any file was written.
    after: () => expect(readdirSync(join(dir, "WORK"))).toEqual(["r.md"]),
  }],
  "cache show": [{ sends: false, why: "reads the local cache" }],
  "cache clear": [{ sends: false, why: "deletes the local cache" }],
  "cache path": [{ sends: false, why: "prints a local path" }],
  "instance add": [{ sends: false, why: "writes the local registry" }],
  "instance set": [{ sends: false, why: "writes the local registry" }],
  "instance list": [{ sends: false, why: "reads the local registry" }],
  "instance remove": [{ sends: false, why: "writes the local registry" }],
  "instance path": [{ sends: false, why: "prints a local path" }],
  // Operations are not built-ins; every route family is listed here by hand.
  "<operation>": [
    { sends: true, argv: ["OrderOperation.Ship", "--lite", "Order;42", "--yes"] },
    { sends: true, argv: ["save", "order", "42", "--edit", "Name=X", "--yes"] },
    { sends: true, argv: ["OrderOperation.Ship", "--lite", "Order;42", "--lite", "Order;43", "--yes"] },
    { sends: true, argv: ["OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes"] },
    { sends: true, argv: ["OrderOperation.Ship", "--lite", "Order;42", "--dry-run"] }, // composes (AC-43.6)
  ],
};

describe("--explain covers every request-issuing command (REQ-053, #122)", () => {
  it("classifies every built-in and subcommand, so a new one cannot quietly omit it", () => {
    const expected = COMMANDS.flatMap((c) => (c.subcommands ?? []).length > 0
      ? (c.subcommands ?? []).map((s) => `${c.name} ${s.name}`)
      : [c.name]);
    const classified = Object.keys(CASES).filter((k) => k !== "<operation>");
    expect(classified.sort()).toEqual([...expected].sort());
  });

  for (const [command, cases] of Object.entries(CASES)) {
    cases.forEach((c, i) => {
      if (!c.sends) return;
      it(`${command} #${i + 1} (${c.argv.join(" ")}) shows its request, redacted, and sends nothing`, async () => {
        const work = join(dir, "WORK");
        if (c.argv.includes("WORK")) {
          rmSync(work, { recursive: true, force: true });
          (await import("node:fs")).mkdirSync(work);
        }
        c.setup?.();
        const argv = [...c.argv.map((a) => (a === "WORK" ? work : a)), "--explain"];
        const r = await cli(argv, { ...(c.stdin !== undefined ? { stdin: c.stdin } : {}), ...(c.human === true ? { human: true } : {}) });
        expect({ code: r.code, err: r.err }).toEqual({ code: ExitCode.Ok, err: expect.any(String) });

        // What it would have sent: a request, with every credential redacted.
        const shown = r.out.trim().split(/\n(?=\{)/).map((d) => JSON.parse(d) as Record<string, unknown>)
          .find((d) => typeof d["method"] === "string" && typeof d["url"] === "string");
        expect(shown).toBeDefined();
        // Where a credential goes out it is redacted; `version` asks anonymously and sends none.
        const auth = (shown?.["headers"] as Record<string, string>)["Authorization"];
        if (auth !== undefined) expect(auth).toBe("<redacted>");
        expect(r.out + r.err).not.toContain(TOKEN);
        expect(r.out + r.err).not.toContain("a-pasted-token");

        // What reached the server: preparation reads at most, and never an operation.
        for (const path of seen) expect(PREPARATION.some((p) => p.test(path))).toBe(true);
        c.after?.();
      });
    });
  }
});

describe("the preparation mark", () => {
  it("is refused on an operation request, so --explain can never send a write", async () => {
    const http = new SignumHttp({ baseUrl: url, token: TOKEN, explain: () => {} });
    await expect(http.request({ method: "POST", path: "api/operation/executeLite/OrderOperation.Ship", body: {}, prepare: true }))
      .rejects.toThrow(/marked as preparation/);
    expect(seen).toEqual([]);
  });
});

describe("--trace (REQ-053)", () => {
  it("is --verbose by another name: traffic on stderr, credentials redacted", async () => {
    const r = await cli(["--trace", "types"], { human: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain(`> GET ${url}/api/reflection/types`);
    expect(r.err).toContain("Authorization: <redacted>");
    expect(r.err).not.toContain(TOKEN);
  });

  it("redacts the credential on the write paths too, single and bulk", async () => {
    for (const argv of [
      ["--trace", "OrderOperation.Ship", "--lite", "Order;42", "--yes"],
      ["--trace", "OrderOperation.Ship", "--lite", "Order;42", "--lite", "Order;43", "--yes"],
      ["--trace", "OrderOperation.Ship", "--lite", "Order;42", "--progress", "--yes"],
    ]) {
      const r = await cli(argv, { human: true });
      // The mock refuses the operation itself; what matters is what the trace printed on the way.
      expect(r.err).toContain("> POST ");
      expect(r.err).toContain("Authorization: <redacted>");
      expect(r.out + r.err).not.toContain(TOKEN);
    }
  });
});
