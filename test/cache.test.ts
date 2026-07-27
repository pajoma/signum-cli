/**
 * Metadata cache surface — STORY-24 · AC-24.3 (explicitly clearable), AC-24.4 (fully offline).
 *
 * Both ACs were previously unmet for the same reason: the capability existed but nothing reached
 * it. `loadMetadata` implemented `offline` correctly and was tested at the module level, but no
 * flag anywhere set it, so a user could not make discovery work offline. And the cache had no
 * inspection or clearing surface at all — hashed filenames in a directory the user had to guess.
 *
 * These tests drive the CLI, not the module, because reachability is the thing that was missing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../src/cli.ts";
import { ExitCode } from "../src/core/errors.ts";

const REFLECTION = {
  Order: { kind: "Main", queryDefined: true, members: { Id: { type: { name: "number" } } }, operations: {} },
  Invoice: { kind: "Main", queryDefined: true, members: {}, operations: {} },
};

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl: string;
let dir: string;
/** Every request the mock actually received — "offline" is a claim about this number. */
let hits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits++;
      const url = new URL(req.url);
      if (url.pathname === "/api/reflection/types") {
        return new Response(JSON.stringify(REFLECTION), {
          headers: { "content-type": "application/json", "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
        });
      }
      return new Response(JSON.stringify({ exceptionMessage: "unhandled" }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-cache-test-")); hits = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Result { code: ExitCode; out: string; err: string }

async function cli(argv: string[], opts: { env?: Record<string, string>; tty?: boolean } = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: opts.tty === true,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: dir, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

/** Populate the cache the way a user would: run a discovery command once, online. */
async function warm(): Promise<void> {
  const r = await cli(["types", "--url", baseUrl, "--json"]);
  expect(r.code).toBe(ExitCode.Ok);
}

describe("`--offline` makes a warm cache reachable (AC-24.4)", () => {
  it("serves discovery from cache WITHOUT touching the network", async () => {
    await warm();
    const afterWarm = hits;

    const r = await cli(["types", "--url", baseUrl, "--offline", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const types = (JSON.parse(r.out) as Array<{ name: string }>).map((t) => t.name).sort();
    expect(types).toEqual(["Invoice", "Order"]);

    // The load-bearing assertion. Without it this test would still pass if --offline merely
    // revalidated with If-Modified-Since and got a 304 — which is NOT offline, and would hang
    // or fail on a machine with no route to the server.
    expect(hits).toBe(afterWarm);
  });

  it("`explain` works offline too — not just the list commands", async () => {
    await warm();
    const afterWarm = hits;
    const r = await cli(["explain", "Order", "--url", baseUrl, "--offline", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as { name: string }).name).toBe("Order");
    expect(hits).toBe(afterWarm);
  });

  it("flags the result as cached, so an offline answer is never mistaken for a fresh one", async () => {
    await warm();
    const r = await cli(["types", "--url", baseUrl, "--offline"], { tty: true });
    expect(r.err).toContain("using cached metadata");
  });

  it("SIGNUM_OFFLINE=1 is equivalent to the flag", async () => {
    await warm();
    const afterWarm = hits;
    const r = await cli(["types", "--url", baseUrl, "--json"], { env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_OFFLINE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(hits).toBe(afterWarm);
  });

  it("with a COLD cache it fails cleanly, naming the fix — never a hang or a stack", async () => {
    const r = await cli(["types", "--url", "http://never-fetched.invalid", "--offline"]);
    expect(r.code).toBe(ExitCode.Transport);
    expect(r.err).toContain("no cached metadata");
    expect(r.err).toContain("online once");
  });

  it("is accepted by query and get, not just the discovery commands", async () => {
    await warm();
    // --explain so no credential and no query round trip is needed; the point is that the flag
    // is not rejected and the metadata step is satisfied from cache.
    const afterWarm = hits;
    const r = await cli(["query", "Order", "--url", baseUrl, "--offline", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { queryKey: string } };
    expect(doc.body.queryKey).toBe("Order");
    expect(hits).toBe(afterWarm);
  });
});

describe("`signum cache show` (AC-24.3)", () => {
  it("reports nothing cached on a fresh install, as success not an error", async () => {
    const r = await cli(["cache", "show"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("no cached metadata");
    expect(r.out).toBe("");
  });

  it("lists a warm entry with its target, scope and type count", async () => {
    await warm();
    const r = await cli(["cache", "show", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const rows = JSON.parse(r.out) as Array<{ url: string; scope: string; types: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe(baseUrl);
    expect(rows[0]?.scope).toBe("anon"); // fetched without a credential
    expect(rows[0]?.types).toBe(2);
  });

  it("bare `signum cache` is the same as `cache show` — the harmless one", async () => {
    await warm();
    const bare = await cli(["cache", "--json"]);
    const explicit = await cli(["cache", "show", "--json"]);
    expect(bare.out).toBe(explicit.out);
  });

  it("human output names the target and does not leak the hashed path into stdout", async () => {
    await warm();
    const r = await cli(["cache", "show"], { tty: true });
    expect(r.out).toContain(baseUrl);
    expect(r.out).toContain("anon");
  });
});

describe("`signum cache clear` (AC-24.3)", () => {
  it("removes every cached document and reports what went", async () => {
    await warm();
    const r = await cli(["cache", "clear", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as { cleared: number }).cleared).toBe(1);

    const after = await cli(["cache", "show", "--json"]);
    expect(JSON.parse(after.out)).toEqual([]);
  });

  it("a cleared cache really is cold — offline then fails", async () => {
    await warm();
    await cli(["cache", "clear"]);
    const r = await cli(["types", "--url", baseUrl, "--offline"]);
    expect(r.code).toBe(ExitCode.Transport);
    expect(r.err).toContain("no cached metadata");
  });

  it("--url clears only that target", async () => {
    await warm();
    const r = await cli(["cache", "clear", "--url", "http://a-different-target.invalid", "--json"]);
    expect((JSON.parse(r.out) as { cleared: number }).cleared).toBe(0);
    const still = await cli(["cache", "show", "--json"]);
    expect(JSON.parse(still.out)).toHaveLength(1);
  });

  it("clearing a target removes BOTH its anonymous and authenticated documents", async () => {
    // The auth/anon split is invisible to the user (config.ts cachePath), so clearing "the cache
    // for this target" must not leave half of it behind for them to trip over later.
    await warm(); // anonymous
    const { saveMetadataCache } = await import("../src/core/config.ts");
    saveMetadataCache(baseUrl, true, REFLECTION, undefined, { SIGNUM_CONFIG_DIR: dir } as NodeJS.ProcessEnv);

    const before = await cli(["cache", "show", "--json"]);
    expect(JSON.parse(before.out)).toHaveLength(2);

    const r = await cli(["cache", "clear", "--url", baseUrl, "--json"]);
    expect((JSON.parse(r.out) as { cleared: number }).cleared).toBe(2);
    const after = await cli(["cache", "show", "--json"]);
    expect(JSON.parse(after.out)).toEqual([]);
  });

  it("clearing an empty cache is success, not an error", async () => {
    const r = await cli(["cache", "clear"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("no cached metadata to clear");
  });
});

describe("`signum cache path`", () => {
  it("prints the directory bare on stdout, so it composes in a shell", async () => {
    // Deliberately NOT a TTY: `ls "$(signum cache path)"` never is, and that is the whole use.
    // Resolving to the off-TTY JSON default here would make the command useless.
    const r = await cli(["cache", "path"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toBe(join(dir, "cache") + "\n");
  });

  it("--json is still honoured when asked for explicitly", async () => {
    const r = await cli(["cache", "path", "--json"]);
    expect((JSON.parse(r.out) as { cacheDir: string }).cacheDir).toBe(join(dir, "cache"));
  });

  it("names a real directory once the cache is warm", async () => {
    await warm();
    const r = await cli(["cache", "path"]);
    const p = r.out.trim();
    expect(existsSync(p)).toBe(true);
    expect(readdirSync(p).length).toBeGreaterThan(0);
  });
});

describe("cache command surface", () => {
  it("an unknown subcommand is a usage error naming the valid ones", async () => {
    const r = await cli(["cache", "bogus"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("show, clear, path");
  });

  it("rejects an unrecognized flag rather than ignoring it", async () => {
    const r = await cli(["cache", "clear", "--evrything"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--evrything");
  });

  it("needs no target and no credential — it is a purely local command", async () => {
    // Deliberately no --url and no SIGNUM_URL: reaching for the cache must not require
    // resolving a target, or it would be useless in exactly the broken states it diagnoses.
    const r = await cli(["cache", "show"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("no target application");
  });

  it("is not blocked by the agent data gate — a cache listing is metadata (AC-51.3)", async () => {
    await warm();
    const r = await cli(["cache", "show", "--json"], { env: { SIGNUM_CONFIG_DIR: dir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("refusing to emit");
  });
});
