/**
 * End-to-end tests against a mock Signum server.
 *
 * REQ-077 · the offline half of the test strategy. Nothing here has been validated against a
 * REAL Signum application — these fixtures encode what the framework *source* says the wire
 * looks like. When a live app becomes available, diff its responses against these fixtures
 * first; where they disagree, the live app wins and these change.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../src/cli.ts";
import { ExitCode } from "../src/core/errors.ts";

const GOOD_TOKEN = "test-token-aaaa";
const ROTATED_TOKEN = "test-token-bbbb";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let configDir: string;
/** Set when the server decides to rotate; consumed by the next response. */
let rotateNext = false;

const REFLECTION = {
  Order: {
    kind: "Main",
    niceName: "Order",
    queryDefined: true,
    members: {
      Id: { type: { name: "number" }, niceName: "Id" },
      State: { type: { name: "string" }, niceName: "State" },
      Total: { type: { name: "decimal" }, niceName: "Total" },
    },
    operations: {
      "OrderOperation.Ship": { niceName: "Ship" },
      "OrderOperation.Get": { niceName: "Get" }, // collides with the built-in `get`
    },
  },
  UserEntity: {
    kind: "Main",
    niceName: "User",
    queryDefined: true,
    members: { UserName: { type: { name: "string" } } },
    operations: { "UserOperation.Save": { niceName: "Save" } },
  },
  // Exist purely so their query keys pass the metadata-validation step before hitting the
  // 400/500 fixture routes above.
  BadInput: { kind: "Main", queryDefined: true, members: {}, operations: {} },
  Broken: { kind: "Main", queryDefined: true, members: {}, operations: {} },
};

/** Interned: `State` cells are indices, `Total` cells are literals. */
const RESULT_TABLE = {
  columns: ["State", "Total"],
  uniqueValues: { State: ["Shipped", "Delivered"] },
  rows: [
    { entity: { EntityType: "Order", id: 42 }, columns: [0, 1200.5] },
    { entity: { EntityType: "Order", id: 43 }, columns: [1, 87.25] },
  ],
  totalElements: 7,
};

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "signum-test-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const token = auth?.replace(/^Bearer /, "");

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (rotateNext && token === GOOD_TOKEN) {
        headers["New_Token"] = ROTATED_TOKEN; // AuthTokensServer.cs:85-94
        rotateNext = false;
      }

      // Anonymous — no credential required (AC-61.4).
      if (url.pathname === "/api/reflection/types") {
        return new Response(JSON.stringify(REFLECTION), {
          headers: { ...headers, "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
        });
      }

      const authenticated = token === GOOD_TOKEN || token === ROTATED_TOKEN;

      if (url.pathname === "/api/auth/currentUser") {
        // A bad token degrades SILENTLY to anonymous rather than erroring (AC-04.6).
        return new Response(JSON.stringify(authenticated ? { userName: "alice", toStr: "alice" } : null), { headers });
      }

      if (!authenticated) {
        // 403 for auth failure, never 401 — with exceptionType as the discriminator.
        return new Response(
          JSON.stringify({ exceptionType: "Signum.Services.AuthenticationException", exceptionMessage: "bad token" }),
          { status: 403, headers },
        );
      }

      if (url.pathname.startsWith("/api/query/executeQuery/")) {
        return new Response(JSON.stringify(RESULT_TABLE), { headers });
      }
      if (url.pathname.startsWith("/api/query/queryValue/")) {
        return new Response("7", { headers });
      }
      if (url.pathname === "/api/entity/Order/42") {
        return new Response(JSON.stringify({ Type: "Order", id: 42, ticks: "638", toStr: "Order 42" }), { headers });
      }
      if (url.pathname === "/api/entity/Order/999") {
        return new Response(JSON.stringify({ exceptionMessage: "not found" }), { status: 404, headers });
      }
      if (url.pathname === "/api/exists/Order/42") return new Response("true", { headers });
      if (url.pathname === "/api/exists/Order/999") return new Response("false", { headers });
      if (url.pathname === "/api/operation/executeLite/OrderOperation.Ship") {
        return new Response(
          JSON.stringify({ exceptionType: "System.UnauthorizedAccessException", exceptionMessage: "not allowed" }),
          { status: 403, headers },
        );
      }
      // A query key that always returns 400 ValidationProblemDetails, for testing that path.
      if (url.pathname === "/api/query/executeQuery/BadInput") {
        return new Response(
          JSON.stringify({ title: "One or more validation errors occurred.", errors: { Total: ["must be positive"] } }),
          { status: 400, headers },
        );
      }
      // A query key that always returns a generic 500 with no exceptionType.
      if (url.pathname === "/api/query/executeQuery/Broken") {
        return new Response(JSON.stringify({ exceptionMessage: "something went wrong server-side" }), { status: 500, headers });
      }
      if (url.pathname === "/api/entity/Order/400") {
        return new Response(JSON.stringify({ title: "bad request" }), { status: 400, headers });
      }
      return new Response(JSON.stringify({ exceptionMessage: "unhandled" }), { status: 404, headers });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

interface Result { code: ExitCode; out: string; err: string }

async function cli(argv: string[], opts: { stdin?: string; env?: Record<string, string>; tty?: boolean } = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: opts.tty === true,
    stdinIsTty: opts.stdin === undefined,
    env: { SIGNUM_CONFIG_DIR: configDir, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    readStdin: async () => opts.stdin ?? "",
  };
  try {
    const code = await run(argv, io);
    return { code, out, err };
  } catch (e) {
    // Mirror production error reporting (cli.ts `report`) so tests see the hint too —
    // the hint is where help routing lives, and asserting on it is the point.
    const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

describe("discovery without credentials (STORY-24, STORY-61)", () => {
  it("lists types with only a URL — no login (AC-61.4)", async () => {
    const r = await cli(["types", "--url", baseUrl, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const types = JSON.parse(r.out) as Array<{ name: string }>;
    expect(types.map((t) => t.name).sort()).toEqual(["BadInput", "Broken", "Order", "UserEntity"]);
  });

  it("explains a type from metadata", async () => {
    const r = await cli(["explain", "Order", "--url", baseUrl, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { name: string; members: unknown[] };
    expect(doc.name).toBe("Order");
    expect(doc.members.length).toBe(3);
  });

  it("flags an operation verb shadowed by a built-in (AC-41.8)", async () => {
    const r = await cli(["operations", "Order", "--url", baseUrl, "--json"]);
    const ops = JSON.parse(r.out) as Array<{ key: string; shadowed: boolean }>;
    expect(ops.find((o) => o.key === "OrderOperation.Get")?.shadowed).toBe(true);
    expect(ops.find((o) => o.key === "OrderOperation.Ship")?.shadowed).toBe(false);
  });

  it("suggests near matches for an unknown type (AC-63.4)", async () => {
    const r = await cli(["explain", "Ordr", "--url", baseUrl]);
    expect(r.code).toBe(ExitCode.NotFound);
    expect(r.err).toContain("Order");
  });
});

describe("login and status (STORY-12, STORY-06)", () => {
  it("refuses to read a token from a TTY rather than hanging (STORY-09)", async () => {
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("stdin");
  });

  it("rejects a token that resolves to anonymous (AC-12.3)", async () => {
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], { stdin: "wrong-token" });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    expect(r.err).toContain("anonymous");
  });

  it("stores a valid token with 0600 permissions (AC-04.1, AC-11.5)", async () => {
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], { stdin: GOOD_TOKEN + "\n" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("alice");
    const mode = statSync(join(configDir, "credential.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never prints the token (AC-06.3, AC-11.1)", async () => {
    const r = await cli(["auth", "status"]);
    expect(r.out + r.err).not.toContain(GOOD_TOKEN);
    expect(r.out).toContain("alice");
    expect(r.code).toBe(ExitCode.Ok);
  });
});

describe("auth lifecycle edges (QA coverage — previously 0% tested)", () => {
  // Each test below uses its OWN isolated config dir, never the shared `configDir`, so
  // logging out or leaving things unconfigured here cannot affect later describe blocks that
  // depend on `configDir` already holding a valid credential.

  it("`auth status` on a genuinely fresh install — the first thing anyone runs", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "signum-fresh-status-"));
    const r = await cli(["auth", "status"], { env: { SIGNUM_CONFIG_DIR: fresh }, tty: true });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    expect(r.out).toContain("Not configured");
  });

  it("`auth status --json` on a fresh install reports null target and 'none' credential", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "signum-fresh-status-json-"));
    const r = await cli(["auth", "status", "--json"], { env: { SIGNUM_CONFIG_DIR: fresh } });
    const doc = JSON.parse(r.out) as { target: string | null; credential: string };
    expect(doc.target).toBeNull();
    expect(doc.credential).toBe("none");
  });

  it("`auth logout` with nothing stored says so and still exits 0", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "signum-logout-empty-"));
    const r = await cli(["auth", "logout"], { env: { SIGNUM_CONFIG_DIR: fresh } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("No stored credential");
  });

  it("`auth logout` removes a stored credential and is honest that it is local-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signum-logout-"));
    await cli(["auth", "login", "--url", baseUrl, "--with-token"], { env: { SIGNUM_CONFIG_DIR: dir }, stdin: GOOD_TOKEN + "\n" });
    const before = await cli(["auth", "status"], { env: { SIGNUM_CONFIG_DIR: dir } });
    expect(before.code).toBe(ExitCode.Ok);

    const r = await cli(["auth", "logout"], { env: { SIGNUM_CONFIG_DIR: dir } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("removed");
    // Signum performs no server-side token revocation — the CLI must not imply that it does.
    expect(r.err).toContain("local only");

    const after = await cli(["auth", "status"], { env: { SIGNUM_CONFIG_DIR: dir } });
    expect(after.code).toBe(ExitCode.NotAuthenticated);
  });

  it("`auth` with no subcommand is a usage error, not a crash", async () => {
    const r = await cli(["auth"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("subcommand");
  });

  it("`auth bogus` names the valid subcommands", async () => {
    const r = await cli(["auth", "bogus"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("login, status, logout");
  });

  it("`auth status --url <other>` when logged into a DIFFERENT url reports no credential for it", async () => {
    // The realistic mistake: logged into dev, points --url at a different target and forgets.
    const dir = mkdtempSync(join(tmpdir(), "signum-mismatch-"));
    await cli(["auth", "login", "--url", baseUrl, "--with-token"], { env: { SIGNUM_CONFIG_DIR: dir }, stdin: GOOD_TOKEN + "\n" });
    const r = await cli(["auth", "status", "--url", "http://127.0.0.1:1"], { env: { SIGNUM_CONFIG_DIR: dir }, tty: true });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    expect(r.out).toContain("none for this target");
  });

  it("login against an unreachable host fails with a transport error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signum-unreachable-"));
    const r = await cli(["auth", "login", "--url", "http://127.0.0.1:1", "--with-token"], {
      env: { SIGNUM_CONFIG_DIR: dir },
      stdin: "some-token\n",
    });
    expect(r.code).toBe(ExitCode.Transport);
  });
});

describe("query (STORY-20, STORY-21, STORY-22)", () => {
  it("de-interns the result table end to end (AC-21.1)", async () => {
    const r = await cli(["query", "Order", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(rows[0]?.["State"]).toBe("Shipped");
    expect(rows[1]?.["State"]).toBe("Delivered");
    expect(rows[0]?.["Total"]).toBe(1200.5);
  });

  it("emits Lite keys for -o name", async () => {
    const r = await cli(["query", "Order", "-o", "name"]);
    expect(r.out).toBe("Order;42\nOrder;43\n");
  });

  it("renders a human table when stdout is a TTY (AC-22.1)", async () => {
    const r = await cli(["query", "Order"], { tty: true });
    expect(r.out).toContain("State");
    expect(r.out).toContain("Shipped");
    expect(r.err).toContain("2 of 7 rows"); // AC-21.5
  });

  it("--explain sends nothing and prints the request (AC-20.6)", async () => {
    const r = await cli(["query", "Order", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { method: string; body: { pagination: unknown } };
    expect(doc.method).toBe("POST");
    expect(doc.body.pagination).toEqual({ mode: "Firsts", elementsPerPage: 50 });
  });

  it("defaults to a bounded page, never All (AC-23.2)", async () => {
    const r = await cli(["query", "Order", "--explain"]);
    expect(r.out).not.toContain('"All"');
  });

  it("lowers --filter onto the exact QueryRequestTS wire shape (REQ-021)", async () => {
    const r = await cli(["query", "Order", "--filter", "State = Shipped", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { filters: unknown[] } };
    expect(doc.body.filters).toEqual([{ token: "State", operation: "EqualTo", value: "Shipped" }]);
  });

  it("combines and/or grouping, --filter-json, and repeated --filter (all ANDed)", async () => {
    // --filter-json takes a FILE PATH (or `-` for stdin, not yet wired for query) — never
    // inline JSON text, per design/filter-expression-syntax.md's own examples.
    const filterJsonFile = join(configDir, "filters.json");
    writeFileSync(filterJsonFile, '[{"token":"Entity.Customer.Name","operation":"Contains","value":"Acme"}]');
    const r = await cli([
      "query", "Order",
      "--filter", "State = Shipped or State = Delivered",
      "--filter", "Total > 100",
      "--filter-json", filterJsonFile,
      "--explain",
    ]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { filters: unknown[] } };
    expect(doc.body.filters).toEqual([
      { groupOperation: "Or", filters: [
        { token: "State", operation: "EqualTo", value: "Shipped" },
        { token: "State", operation: "EqualTo", value: "Delivered" },
      ] },
      { token: "Total", operation: "GreaterThan", value: 100 },
      { token: "Entity.Customer.Name", operation: "Contains", value: "Acme" },
    ]);
  });

  it("gives a clean UsageError on a --filter-json path that does not exist", async () => {
    const r = await cli(["query", "Order", "--filter-json", "/no/such/file.json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("could not read --filter-json file");
  });

  it("rejects null inside 'in' with a client-side error, never sent to the server", async () => {
    const r = await cli(["query", "Order", "--filter", "State in Shipped,null"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("cannot include null");
  });

  it("requires --group for an aggregate-shaped token, before any request", async () => {
    const r = await cli(["query", "Order", "--filter", "Total.Sum > 100"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--group");
  });

  it("--group sets groupResults on the wire request", async () => {
    const r = await cli(["query", "Order", "--filter", "Total.Sum > 100", "--group", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { groupResults: boolean } };
    expect(doc.body.groupResults).toBe(true);
  });

  it("identifies which --filter failed when more than one was given", async () => {
    const r = await cli(["query", "Order", "--filter", "A = 1", "--filter", "B ==="]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--filter #2");
  });

  it("rejects an unknown query key from cache, before any request (AC-20.7)", async () => {
    const r = await cli(["query", "Nope"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("unknown query key");
  });

  it("--count returns only the count", async () => {
    const r = await cli(["query", "Order", "--count"], { tty: true });
    expect(r.out.trim()).toBe("7");
  });

  it("rejects an unrecognized flag rather than silently ignoring it (QA finding)", async () => {
    // A typo'd --filer instead of --filter must not run the query unfiltered and unwarned —
    // that is exactly the silent-wrong-data-on-production risk this project is built against.
    const r = await cli(["query", "Order", "--filer", "State = Shipped", "--i-understand-data-goes-to-a-model"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--filer");
  });

  it("suggests the likely intended flag for a near-miss typo", async () => {
    const r = await cli(["query", "Order", "--filer", "State = Shipped"]);
    expect(r.err).toContain("--filter");
  });

  it("still accepts every flag query actually declares (no false positives from the new check)", async () => {
    const r = await cli([
      "query", "Order",
      "--filter", "State = Shipped", "--column", "State", "--order", "-State",
      "--page", "1", "--page-size", "10", "--group", "--i-understand-data-goes-to-a-model",
    ]);
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("--explain works with NO stored credential — it sends nothing (AC-20.6)", async () => {
    const r = await cli(["query", "Order", "--explain"], {
      env: { SIGNUM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "signum-noauth-")), SIGNUM_URL: baseUrl },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(r.out).method).toBe("POST");
  });

  it("rejects combining --top with --page rather than silently preferring one (QA finding)", async () => {
    const r = await cli(["query", "Order", "--top", "5", "--page", "2", "--explain"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("pagination");
  });

  it("rejects combining --all with --top", async () => {
    const r = await cli(["query", "Order", "--all", "--top", "5", "--explain"]);
    expect(r.code).toBe(ExitCode.Usage);
  });
});

describe("colour (AC-22.1, QA finding)", () => {
  it("a TTY table render carries ANSI codes end-to-end", async () => {
    const r = await cli(["query", "Order"], { tty: true });
    expect(r.out).toContain("\x1b[");
  });

  it("--no-color suppresses it even on a TTY", async () => {
    const r = await cli(["query", "Order", "--no-color"], { tty: true });
    expect(r.out).not.toContain("\x1b[");
  });

  it("NO_COLOR env var suppresses it even on a TTY", async () => {
    const r = await cli(["query", "Order"], { tty: true, env: { NO_COLOR: "1" } });
    expect(r.out).not.toContain("\x1b[");
  });

  it("non-TTY (json) output never carries ANSI codes regardless", async () => {
    const r = await cli(["query", "Order", "--json"], { tty: false });
    expect(r.out).not.toContain("\x1b[");
  });
});

describe("get (STORY-30)", () => {
  it("retrieves by type and id", async () => {
    const r = await cli(["get", "Order", "42", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as { id: number }).id).toBe(42);
  });

  it("accepts a Lite key (AC-30.2)", async () => {
    const r = await cli(["get", "Order;42", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("returns exit 5 for a missing entity (AC-30.7)", async () => {
    const r = await cli(["get", "Order", "999"]);
    expect(r.code).toBe(ExitCode.NotFound);
  });

  it("--explain works with NO stored credential (QA finding, parity with query)", async () => {
    const r = await cli(["get", "Order", "42", "--explain"], {
      env: { SIGNUM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "signum-noauth-get-")), SIGNUM_URL: baseUrl },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(r.out).method).toBe("GET");
  });

  it("rejects an unrecognized flag rather than silently ignoring it", async () => {
    const r = await cli(["get", "Order", "42", "--exsits"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--exsits");
  });
});

describe("token rotation (STORY-04)", () => {
  it("adopts a New_Token header and persists it (AC-04.4)", async () => {
    rotateNext = true;
    const r = await cli(["query", "Order", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const stored = JSON.parse(readFileSync(join(configDir, "credential.json"), "utf8")) as { token: string; rotatedAt?: string };
    expect(stored.token).toBe(ROTATED_TOKEN);
    expect(stored.rotatedAt).toBeDefined();
  });

  it("keeps working with the rotated token", async () => {
    const r = await cli(["auth", "status"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("alice");
  });
});

describe("403 disambiguation (STORY-08)", () => {
  it("maps an AuthenticationException 403 to exit 3, not 4", async () => {
    const r = await cli(["query", "Order"], { env: { SIGNUM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "signum-empty-")), SIGNUM_URL: baseUrl } });
    // No credential in this fresh config dir.
    expect(r.code).toBe(ExitCode.NotAuthenticated);
  });

  it("never branches on 401 — the mock never sends one, and neither does Signum", async () => {
    const r = await cli(["query", "Order", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
  });
});

describe("privacy gate (STORY-50, STORY-51)", () => {
  it("surfaces a --filter syntax error even under a detected agent (not masked by the gate)", async () => {
    // A parse error is a diagnostic about the agent's OWN input, not data — it must never be
    // hidden behind "refusing to emit data", or the agent can never see its own mistake.
    const r = await cli(["query", "Order", "--filter", "State ==="], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("could not parse filter");
    expect(r.err).not.toContain("refusing to emit");
  });

  it("refuses row data under a detected agent, with exit 9", async () => {
    const r = await cli(["query", "Order"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Policy);
    expect(r.err).toContain("--i-understand-data-goes-to-a-model");
  });

  it("allows metadata under a detected agent (AC-51.3)", async () => {
    const r = await cli(["types", "--url", baseUrl, "--json"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("allows --explain under a detected agent — it emits no data", async () => {
    const r = await cli(["query", "Order", "--explain"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("proceeds with the acknowledgement flag", async () => {
    const r = await cli(["query", "Order", "--json", "--i-understand-data-goes-to-a-model"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
  });
});

describe("redaction (STORY-11)", () => {
  it("redacts the Authorization header in verbose traces (AC-11.2)", async () => {
    const r = await cli(["query", "Order", "--json", "-v"]);
    expect(r.err).toContain("<redacted>");
    expect(r.err + r.out).not.toContain(ROTATED_TOKEN);
    expect(r.err + r.out).not.toContain(GOOD_TOKEN);
  });
});
