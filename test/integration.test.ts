/**
 * End-to-end tests against a mock Signum server.
 *
 * REQ-077 · the offline half of the test strategy. Nothing here has been validated against a
 * REAL Signum application — these fixtures encode what the framework *source* says the wire
 * looks like. When a live app becomes available, diff its responses against these fixtures
 * first; where they disagree, the live app wins and these change.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/**
 * Whether this fixture's app configures `AuthLogic.AnonymousUser`. The real target application does
 * NOT (observed 2026-07-28, #83), which is why false is the default — it decides whether an invalid
 * token degrades to a null `currentUser` or is rejected with a 403.
 */
let anonymousUserConfigured = false;

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
  // A reflected type with NO query. `queryDefined` is omitted rather than set to false because
  // that is what the wire looks like: TypeInfoTS.QueryDefined carries
  // [JsonIgnore(WhenWritingDefault)] (ReflectionServer.cs:474), so false is simply absent.
  // `signum queries` must not offer it, and `signum query` must not accept it — those two used
  // to disagree.
  Ledger: { kind: "Main", niceName: "Ledger", members: { Id: { type: { name: "number" } } }, operations: {} },
};

/**
 * Token continuations, keyed by the token asked about (`null` = the query's own root columns).
 * Shapes follow `QueryTokenTS` (`QueryController.cs:251-272`): camelCase, `type` is a
 * TypeReferenceTS, and `queryTokenType` is absent for an ordinary column token.
 */
const SUB_TOKENS: Record<string, unknown[]> = {
  "": [
    { key: "Id", fullKey: "Id", niceName: "Id", type: { name: "number" }, isGroupable: true },
    { key: "Entity", fullKey: "Entity", niceName: "Order", type: { name: "Order" }, isGroupable: true },
    { key: "State", fullKey: "State", niceName: "State", type: { name: "string" }, isGroupable: true },
  ],
  Entity: [
    { key: "Customer", fullKey: "Entity.Customer", niceName: "Customer", type: { name: "Customer" }, isGroupable: true },
    { key: "Details", fullKey: "Entity.Details", niceName: "Details", type: { name: "OrderDetail" }, isGroupable: false },
  ],
  "Entity.Customer": [
    { key: "Name", fullKey: "Entity.Customer.Name", niceName: "Name", type: { name: "string" }, isGroupable: true },
  ],
  "Entity.Details": [
    // The AC-24.7 trap: offered by subTokens (SubTokensOptions.All includes CanNested) but
    // rejected by executeQuery, which never passes CanNested.
    { key: "Nested", fullKey: "Entity.Details.Nested", niceName: "Nested", queryTokenType: "Nested",
      type: { name: "OrderDetail" }, isGroupable: false },
    { key: "Count", fullKey: "Entity.Details.Count", niceName: "Count", queryTokenType: "Aggregate",
      type: { name: "number" }, isGroupable: false },
  ],
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
    async fetch(req) {
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
        if (authenticated) {
          return new Response(JSON.stringify({ userName: "alice", toStr: "alice" }), { headers });
        }
        // A bad token behaves DIFFERENTLY depending on the target app, and this fixture used to
        // model only one of the two (#83, found by the first live run).
        //
        // TokenAuthenticator returns null for a malformed token rather than throwing
        // (`AuthTokensServer.cs:66-74`), then the chain continues:
        //   app configures AuthLogic.AnonymousUser -> 200 with a null body
        //   app does NOT                           -> currentUser has no [SignumAllowAnonymous],
        //                                             so InvalidAuthenticator throws -> 403
        // The real target application does the latter, so that is the default here; the
        // anonymous-user variant is selectable, because both are legitimate Signum deployments
        // and the CLI has to handle each.
        if (anonymousUserConfigured) {
          return new Response(JSON.stringify(null), { headers });
        }
        return new Response(
          JSON.stringify({
            exceptionType: "Signum.Services.AuthenticationException",
            exceptionMessage: "No authentication information found!",
          }),
          { status: 403, headers },
        );
      }

      if (!authenticated) {
        // 403 for auth failure, never 401 — with exceptionType as the discriminator.
        return new Response(
          JSON.stringify({ exceptionType: "Signum.Services.AuthenticationException", exceptionMessage: "bad token" }),
          { status: 403, headers },
        );
      }

      // Token discovery. QueryController carries no [SignumAllowAnonymous], so these sit AFTER
      // the authentication check above — unlike api/reflection/types, they need a credential.
      if (url.pathname === "/api/query/subTokens") {
        const body = (await req.json()) as { queryKey: string; token: string | null };
        // A VALID token with no continuations returns an empty list; only an INVALID one throws.
        // The real server parses first (QueryUtils.Parse) and then enumerates, so conflating the
        // two would make every leaf look like a typo.
        const known = new Set(
          Object.values(SUB_TOKENS).flatMap((list) => (list as Array<{ fullKey: string }>).map((c) => c.fullKey)),
        );
        const children = SUB_TOKENS[body.token ?? ""]
          ?? (body.token !== null && known.has(body.token) ? [] : undefined);
        if (children === undefined) {
          // An unknown token throws FormatException, which the framework's exception filter has
          // no arm for — so it arrives as HTTP 500 (SignumExceptionFilterAttribute.cs:131-146).
          return new Response(
            JSON.stringify({
              exceptionType: "System.FormatException",
              exceptionMessage: `Token with key '${String(body.token).split(".").pop()}' not found on token '${String(body.token).split(".").slice(0, -1).join(".")}' of query ${body.queryKey}`,
            }),
            { status: 500, headers },
          );
        }
        return new Response(JSON.stringify(children), { headers });
      }
      if (url.pathname === "/api/query/parseTokens") {
        const body = (await req.json()) as { queryKey: string; tokens: string[] };
        const out: unknown[] = [];
        for (const t of body.tokens) {
          const parentKey = t.split(".").slice(0, -1).join("");
          const leaf = t.split(".").pop() as string;
          const siblings = SUB_TOKENS[t.split(".").slice(0, -1).join(".")] as
            Array<{ key: string; fullKey: string }> | undefined;
          const hit = siblings?.find((c) => c.key === leaf);
          if (hit === undefined) {
            return new Response(
              JSON.stringify({
                exceptionType: "System.FormatException",
                exceptionMessage: parentKey === ""
                  ? `Column '${leaf}' not found on query ${body.queryKey}`
                  : `Token with key '${leaf}' not found on token '${t.split(".").slice(0, -1).join(".")}' of query ${body.queryKey}`,
              }),
              { status: 500, headers },
            );
          }
          out.push(hit);
        }
        return new Response(JSON.stringify(out), { headers });
      }

      // These two must be checked BEFORE the generic executeQuery catch-all below, or that
      // catch-all shadows them and every query key silently returns RESULT_TABLE regardless
      // (a mock-fixture bug caught by the very tests it was added to support).
      if (url.pathname === "/api/query/executeQuery/BadInput") {
        return new Response(
          JSON.stringify({ title: "One or more validation errors occurred.", errors: { Total: ["must be positive"] } }),
          { status: 400, headers },
        );
      }
      if (url.pathname === "/api/query/executeQuery/Broken") {
        return new Response(JSON.stringify({ exceptionMessage: "something went wrong server-side" }), { status: 500, headers });
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
      if (url.pathname === "/api/entity/Order/400") {
        return new Response(JSON.stringify({ title: "bad request" }), { status: 400, headers });
      }
      // Same entity, addressable by both the clean name and the class name (AC-30.4).
      if (url.pathname === "/api/entity/User/7") {
        return new Response(JSON.stringify({ Type: "User", id: 7, toStr: "bob" }), { headers });
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
    expect(types.map((t) => t.name).sort()).toEqual(["BadInput", "Broken", "Ledger", "Order", "UserEntity"]);
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

  // Every test above passes --json explicitly. The human-table rendering that a developer at
  // a terminal actually sees had NO coverage at all until the tests below (QA finding).

  it("`types` renders a human table on a TTY", async () => {
    const r = await cli(["types", "--url", baseUrl], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Order");
    expect(r.out).toContain("members");
  });

  it("`types <pattern>` with no match reports it, not a silent empty result", async () => {
    const r = await cli(["types", "zzz-nomatch", "--url", baseUrl], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("no types matching");
  });

  it("`queries` renders a human list and filters by pattern", async () => {
    const all = await cli(["queries", "--url", baseUrl], { tty: true });
    expect(all.out).toContain("Order");
    const filtered = await cli(["queries", "zzz-nomatch", "--url", baseUrl], { tty: true });
    expect(filtered.err).toContain("no queries");
  });

  it("`queries` omits a reflected type that defines no query", async () => {
    const r = await cli(["queries", "--url", baseUrl, "--json"]);
    const keys = (JSON.parse(r.out) as Array<{ queryKey: string }>).map((q) => q.queryKey);
    expect(keys).toContain("Order");
    expect(keys).not.toContain("Ledger");
  });

  it("`operations` with no type argument lists every operation across every type", async () => {
    const r = await cli(["operations", "--url", baseUrl, "--json"]);
    const ops = JSON.parse(r.out) as Array<{ type: string }>;
    expect(ops.some((o) => o.type === "Order")).toBe(true);
    expect(ops.some((o) => o.type === "UserEntity")).toBe(true);
  });

  it("`operations` renders a human list, marking the shadowed verb", async () => {
    const r = await cli(["operations", "Order", "--url", baseUrl], { tty: true });
    expect(r.out).toContain("SHADOWED");
    expect(r.out).toContain("OrderOperation.Ship");
  });

  it("`operations <UnknownType>` is a not-found error, same as explain's", async () => {
    const r = await cli(["operations", "Bogus", "--url", baseUrl]);
    expect(r.code).toBe(ExitCode.NotFound);
  });

  it("`operations <Type>` with zero operations says so rather than printing nothing", async () => {
    const r = await cli(["operations", "BadInput", "--url", baseUrl], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("no operations found"); // diagnostic, correctly on stderr
  });

  it("`explain` with no argument at all is a usage error with examples", async () => {
    const r = await cli(["explain", "--url", baseUrl]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("signum explain Order");
  });

  it("`explain <OperationKey>` describes the operation, not a type — happy path was untested", async () => {
    const r = await cli(["explain", "OrderOperation.Ship", "--url", baseUrl, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { kind: string; key: string; command: string };
    expect(doc.kind).toBe("operation");
    expect(doc.key).toBe("OrderOperation.Ship");
    expect(doc.command).toBe("signum ship order");
  });

  it("`explain <OperationKey>` in human format names the invoke-as command and shadowing", async () => {
    const shipR = await cli(["explain", "OrderOperation.Ship", "--url", baseUrl], { tty: true });
    expect(shipR.out).toContain("signum ship order");
    const getR = await cli(["explain", "OrderOperation.Get", "--url", baseUrl], { tty: true });
    expect(getR.out).toContain("shadowed by a built-in");
  });

  it("`explain <Query>.<token>` needs a credential — token discovery is NOT anonymous", async () => {
    // QueryController has no [SignumAllowAnonymous], unlike api/reflection/types. So discovery
    // is not uniformly credential-free, and the boundary falls in the middle of one command.
    const fresh = mkdtempSync(join(tmpdir(), "signum-anon-"));
    const r = await cli(["explain", "Order.Entity.Customer", "--url", baseUrl], {
      env: { SIGNUM_CONFIG_DIR: fresh },
    });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("`explain <Query>` alone still works with no credential (AC-61.4 unchanged)", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "signum-anon2-"));
    const r = await cli(["explain", "Order", "--url", baseUrl, "--json"], {
      env: { SIGNUM_CONFIG_DIR: fresh },
    });
    expect(r.code).toBe(ExitCode.Ok);
    // The old "walking a token path is m2" note is gone; the anonymous single-segment path is
    // unchanged and must stay credential-free.
    expect((JSON.parse(r.out) as { name: string }).name).toBe("Order");
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("login and status (STORY-12, STORY-06)", () => {
  it("refuses to read a token from a TTY rather than hanging (STORY-09)", async () => {
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("stdin");
  });

  it("rejects a bad token with the handoff instructions, when the server 403s it (AC-12.3)", async () => {
    // The target application's actual behaviour (#83): no AuthLogic.AnonymousUser configured, so
    // currentUser — which carries no [SignumAllowAnonymous] — is refused outright.
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], { stdin: "wrong-token" });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    expect(r.err).toContain("the server rejected this token");
    // The point of the fix: a bad paste must show HOW to get a good one, not just "re-authenticate".
    expect(r.err).toContain('sessionStorage.getItem("authToken")');
  });

  it("rejects a bad token that DEGRADES to anonymous, on an app that configures one (AC-12.3)", async () => {
    // The other legitimate deployment shape: AuthLogic.AnonymousUser is configured, the token is
    // silently degraded, and currentUser answers 200 with a null body. Both must be handled — this
    // is the variant the fixture used to model exclusively, which is why it hid the one above.
    anonymousUserConfigured = true;
    try {
      const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], { stdin: "wrong-token" });
      expect(r.code).toBe(ExitCode.NotAuthenticated);
      expect(r.err).toContain("anonymous");
      expect(r.err).toContain('sessionStorage.getItem("authToken")');
    } finally {
      anonymousUserConfigured = false;
    }
  });

  it("auth status reports a 403'd token as REACHABLE — the server answered (#83)", async () => {
    // `reachable: false` next to an auth error sent a reader hunting a network problem that did not
    // exist. Only a transport failure means unreachable.
    const dir = mkdtempSync(join(tmpdir(), "signum-badtok-"));
    const r = await cli(["auth", "status", "--json"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: "deliberately-invalid" },
    });
    const doc = JSON.parse(r.out) as { reachable: boolean; authenticated: boolean; detail: string | null };
    expect(doc.reachable).toBe(true);
    expect(doc.authenticated).toBe(false);
    expect(doc.detail).toContain("not authenticated");
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a genuinely unreachable host still reports reachable: false", async () => {
    // The other side of the same fix — the distinction has to cut both ways to be worth anything.
    const dir = mkdtempSync(join(tmpdir(), "signum-unreach-"));
    const r = await cli(["auth", "status", "--json"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: "http://127.0.0.1:1", SIGNUM_TOKEN: "whatever" },
    });
    const doc = JSON.parse(r.out) as { reachable: boolean };
    expect(doc.reachable).toBe(false);
    rmSync(dir, { recursive: true, force: true });
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

  it("survives a token rotated during login validation and stores the REPLACEMENT (AC-04.4)", async () => {
    // A browser token old enough to rotate on its very first use is the common case for a
    // session that has been open a while. Validation runs before any credential exists, so the
    // default rotation handler (rotateCredential, which UPDATES a stored credential) failed with
    // "no stored credential to rotate" and aborted the whole login — losing the replacement and
    // costing the user another browser handoff.
    const dir = mkdtempSync(join(tmpdir(), "signum-rotate-login-"));
    rotateNext = true;
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], {
      env: { SIGNUM_CONFIG_DIR: dir }, stdin: GOOD_TOKEN + "\n",
    });
    rotateNext = false;

    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("no stored credential to rotate");
    // Off a TTY login reports as JSON, so the rotation is reported there rather than on stderr.
    expect(JSON.parse(r.out) as { rotatedOnLogin: boolean }).toMatchObject({ rotatedOnLogin: true });

    const stored = JSON.parse(readFileSync(join(dir, "credential.json"), "utf8")) as
      { token: string; rotatedAt?: string };
    expect(stored.token).toBe(ROTATED_TOKEN);
    expect(stored.rotatedAt).toBeDefined();
    // And the stored credential actually works — the point of keeping the replacement.
    const after = await cli(["auth", "status"], { env: { SIGNUM_CONFIG_DIR: dir } });
    expect(after.code).toBe(ExitCode.Ok);
    expect(after.out).toContain("alice");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the submitted token unchanged when the server does not rotate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signum-norotate-login-"));
    const r = await cli(["auth", "login", "--url", baseUrl, "--with-token"], {
      env: { SIGNUM_CONFIG_DIR: dir }, stdin: GOOD_TOKEN + "\n",
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(JSON.parse(r.out) as { rotatedOnLogin: boolean }).toMatchObject({ rotatedOnLogin: false });
    const stored = JSON.parse(readFileSync(join(dir, "credential.json"), "utf8")) as
      { token: string; rotatedAt?: string };
    expect(stored.token).toBe(GOOD_TOKEN);
    expect(stored.rotatedAt).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
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

  it("a trailing slash on --url still matches the stored credential (M2 regression)", async () => {
    // Log in without a trailing slash, then use the credential with one — and vice versa.
    // Before URL normalization these were distinct targets and the second call said
    // "no credential", the exact "log in, next command forgets you" trap.
    const dir = mkdtempSync(join(tmpdir(), "signum-slash-"));
    await cli(["auth", "login", "--url", baseUrl, "--with-token"], { env: { SIGNUM_CONFIG_DIR: dir }, stdin: GOOD_TOKEN + "\n" });
    const r = await cli(["auth", "status", "--url", baseUrl + "/"], { env: { SIGNUM_CONFIG_DIR: dir }, tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("alice");
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

  it("rejects a type that `signum queries` never offered, before any request", async () => {
    // The other half of the DRY fix: discovery filters on queryDefined, so execution must too.
    // Previously `Ledger` passed findType() and was sent to the server, which answered 404 —
    // contradicting the promise that an invalid query key is caught locally (AC-20.7).
    const r = await cli(["query", "Ledger"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("no query you can run");
    expect(r.err).toContain("signum queries");
  });

  it("puts the Entity column where it was asked for, end to end (AC-21.2)", async () => {
    const r = await cli([
      "query", "Order", "--column", "State", "--column", "Entity", "--column", "Total", "--json",
    ]);
    expect(r.code).toBe(ExitCode.Ok);
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    // The mock returns columns ["State","Total"] with Entity hoisted, so a correct client
    // reconstructs exactly the shape the caller requested.
    expect(Object.keys(rows[0] ?? {})).toEqual(["State", "Entity", "Total"]);
    expect(rows[0]?.["Entity"]).toEqual({ EntityType: "Order", id: 42 });
  });

  it("csv carries the Entity column too — it used to be dropped entirely (AC-21.2)", async () => {
    const r = await cli(["query", "Order", "--column", "Entity", "--column", "State", "-o", "csv"]);
    expect(r.code).toBe(ExitCode.Ok);
    // The mock ignores the requested column list and always returns ["State","Total"], which is
    // exactly the interesting case: the SERVER's columns are authoritative, and the request order
    // only decides where the hoisted Entity goes back — first here, since it was asked for first.
    expect(r.out).toBe(
      "Entity,State,Total\n" +
      "Order;42,Shipped,1200.5\n" +
      "Order;43,Delivered,87.25\n",
    );
  });

  it("--count returns only the count", async () => {
    const r = await cli(["query", "Order", "--count"], { tty: true });
    expect(r.out.trim()).toBe("7");
  });

  it("maps a 400 response to Validation, not a generic failure (was untested for query)", async () => {
    const r = await cli(["query", "BadInput", "--i-understand-data-goes-to-a-model"]);
    expect(r.code).toBe(ExitCode.Validation);
  });

  it("maps a generic 500 with no exceptionType to Unexpected, not Concurrency", async () => {
    const r = await cli(["query", "Broken", "--i-understand-data-goes-to-a-model"]);
    expect(r.code).toBe(ExitCode.Unexpected);
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

  it("--exists reports presence without fetching the entity", async () => {
    const r = await cli(["get", "Order", "42", "--exists", "--i-understand-data-goes-to-a-model"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out.trim()).toBe("exists");
  });

  it("--exists on a missing entity reports absence with exit 5, not a crash", async () => {
    const r = await cli(["get", "Order", "999", "--exists"], { tty: true });
    expect(r.code).toBe(ExitCode.NotFound);
    expect(r.err).toContain("does not exist");
  });

  it("resolves the entity CLASS name the same as the clean name (AC-30.4)", async () => {
    const clean = await cli(["get", "User", "7", "--json"]);
    const withSuffix = await cli(["get", "UserEntity", "7", "--json"]);
    expect(clean.code).toBe(ExitCode.Ok);
    expect(withSuffix.code).toBe(ExitCode.Ok);
    expect(clean.out).toBe(withSuffix.out);
  });

  it("a malformed Lite key (empty id after ';') falls back to the whole string as a type name", async () => {
    // Documents the current, slightly confusing fallback: parseLiteKey's guard rejects an
    // empty id, so "Order;" is NOT parsed as a Lite reference — it becomes the literal type
    // name "Order;", which does not exist, so this is an "unknown type" error rather than a
    // crash or a misleading "Lite" error.
    const r = await cli(["get", "Order;", "1"]);
    expect(r.code).toBe(ExitCode.NotFound);
    expect(r.err).toContain("Order;");
  });

  it("blocks entity data under a detected agent context, same as query (STORY-51 parity)", async () => {
    const r = await cli(["get", "Order", "42"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Policy);
  });

  it("blocks --exists under a detected agent context too", async () => {
    const r = await cli(["get", "Order", "42", "--exists"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Policy);
  });

  it("--explain is exempt from the agent gate, same as query", async () => {
    const r = await cli(["get", "Order", "42", "--explain"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("maps a 400 response to a validation error, not a generic failure", async () => {
    const r = await cli(["get", "Order", "400"]);
    expect(r.code).toBe(ExitCode.Validation);
  });

  it("errors on a tabular output format instead of silently emitting JSON (H3)", async () => {
    // An entity is a document, not a table; csv/tsv/name have no meaning for it. Silently
    // coercing to JSON gives a pipeline malformed data with no signal — so it must be an
    // explicit usage error naming the formats that do work.
    const r = await cli(["get", "Order", "42", "-o", "csv", "--i-understand-data-goes-to-a-model"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("json");
  });

  it("still supports json and ndjson for get", async () => {
    const j = await cli(["get", "Order", "42", "-o", "json", "--i-understand-data-goes-to-a-model"]);
    expect(j.code).toBe(ExitCode.Ok);
    const nd = await cli(["get", "Order", "42", "-o", "ndjson", "--i-understand-data-goes-to-a-model"]);
    expect(nd.code).toBe(ExitCode.Ok);
  });

  it("on a TTY, get still renders json (the human default) without complaint", async () => {
    const r = await cli(["get", "Order", "42", "--i-understand-data-goes-to-a-model"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Order 42");
  });
});

/**
 * Live token discovery — REQ-012 · AC-24.2, AC-24.7, AC-63.1.
 *
 * The last acceptance criterion on STORY-24. `explain <Query>.<token>` used to print
 * "walking a token path needs api/query/subTokens, which is m2" and then silently show the root
 * type instead.
 */
describe("token discovery (AC-24.2)", () => {
  it("validates the path and lists its continuations", async () => {
    const r = await cli(["explain", "Order.Entity", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as {
      kind: string; queryKey: string; token: string;
      subTokens: Array<{ key: string; fullKey: string; usableInQuery: boolean }>;
    };
    expect(doc.kind).toBe("token");
    expect(doc.queryKey).toBe("Order");
    expect(doc.token).toBe("Entity");
    expect(doc.subTokens.map((t) => t.key)).toEqual(["Customer", "Details"]);
    // fullKey is what actually goes on the wire in a --column/--filter, so it must be complete.
    expect(doc.subTokens[0]?.fullKey).toBe("Entity.Customer");
  });

  it("walks more than one segment deep", async () => {
    const r = await cli(["explain", "Order.Entity.Customer", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { token: string; subTokens: Array<{ key: string }> };
    expect(doc.token).toBe("Entity.Customer");
    expect(doc.subTokens.map((t) => t.key)).toEqual(["Name"]);
  });

  it("reports a leaf as a leaf, not as an empty list", async () => {
    const r = await cli(["explain", "Order.Entity.Customer.Name"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("leaf");
  });

  it("human output names the token, its type, and each continuation's type", async () => {
    const r = await cli(["explain", "Order.Entity"], { tty: true });
    expect(r.out).toContain("Order.Entity");
    expect(r.out).toContain("CONTINUATIONS");
    expect(r.out).toContain("Customer");
    // The next-step line has to be copy-pasteable, which is the point of tracking fullKey.
    expect(r.out).toContain("--column Entity");
  });

  it("marks a `.Nested` continuation as unusable in a query (AC-24.7)", async () => {
    // subTokens resolves with SubTokensOptions.All, which includes CanNested; filter parsing
    // never passes it. So the server offers a token it will then reject — and discovering that
    // at query time is too late.
    const r = await cli(["explain", "Order.Entity.Details", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { subTokens: Array<{ key: string; usableInQuery: boolean }> };
    const nested = doc.subTokens.find((t) => t.key === "Nested");
    expect(nested?.usableInQuery).toBe(false);
    const count = doc.subTokens.find((t) => t.key === "Count");
    expect(count?.usableInQuery).toBe(true);
  });

  it("warns about the `.Nested` trap in human output too", async () => {
    const r = await cli(["explain", "Order.Entity.Details"], { tty: true });
    expect(r.out).toContain("not usable in a query");
    expect(r.err).toContain("SubTokensOptions.All");
  });

  it("carries the token KIND through, so an aggregate is identifiable", async () => {
    const r = await cli(["explain", "Order.Entity.Details", "--json"]);
    const doc = JSON.parse(r.out) as { subTokens: Array<{ key: string; tokenKind: string | null }> };
    expect(doc.subTokens.find((t) => t.key === "Count")?.tokenKind).toBe("Aggregate");
  });
});

describe("an invalid token is a USAGE error, not a server crash (AC-63.1)", () => {
  it("maps FormatException-on-500 to a validation error, never exit 1", async () => {
    // QueryUtils.Parse throws FormatException for an unknown token, and Signum's exception filter
    // has no arm for it — so a typo arrives as HTTP 500. Reporting that as "unexpected, please
    // report it" sends the user to file a bug about their own input.
    const r = await cli(["explain", "Order.Entity.Custmer"]);
    // Usage (2), the same class as an unknown query key — the caller's input is wrong. The
    // load-bearing part is that it is NOT Unexpected (1) "please report it", which is what a
    // raw 500 would otherwise produce.
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.code).not.toBe(ExitCode.Unexpected);
    expect(r.err).toContain("invalid query token");
    expect(r.err).not.toContain("please report it");
  });

  it("suggests the near match from the server's own continuation list (AC-63.1)", async () => {
    const r = await cli(["explain", "Order.Entity.Custmer"]);
    // Edit distance, not substring containment — containment cannot get Customer from Custmer.
    expect(r.err).toContain("Did you mean: Customer?");
  });

  it("routes to `signum explain <Query>` for the full list", async () => {
    const r = await cli(["explain", "Order.Entity.Custmer"]);
    expect(r.err).toContain("signum explain Order");
  });

  it("a bad FIRST segment is reported against the query, not a parent token", async () => {
    const r = await cli(["explain", "Order.Nonsense"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("not found on query Order");
  });
});

describe("token discovery cannot come from cache", () => {
  it("--offline says so plainly instead of silently degrading", async () => {
    // The old behaviour for an unwalkable path was to show the root type instead, which is the
    // kind of silent substitution this project treats as worse than an error.
    const r = await cli(["explain", "Order.Entity", "--offline"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--offline cannot walk the token path");
    expect(r.err).toContain("api/query/subTokens");
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

/**
 * AC-09.2 — "every credential can be supplied by environment variable".
 *
 * m1's only credential is a browser handoff, and a CI runner has no browser, so without this a
 * pipeline could not authenticate at all except by writing credential.json itself. That made the
 * AC unmet in exactly the scenario STORY-09 is written about.
 */
describe("SIGNUM_TOKEN, for a non-interactive run (AC-09.2)", () => {
  /** A config dir with no credential in it, so only the environment can authenticate. */
  const fresh = () => mkdtempSync(join(tmpdir(), "signum-envtok-"));

  it("authenticates with no stored credential at all", async () => {
    const dir = fresh();
    const r = await cli(["query", "Order", "--json"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: GOOD_TOKEN },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as Array<Record<string, unknown>>)[0]?.["State"]).toBe("Shipped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is never written to disk — an ambient credential stays ambient", async () => {
    const dir = fresh();
    await cli(["query", "Order", "--json"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: GOOD_TOKEN },
    });
    // A CI run must not leave a token behind on a shared runner.
    expect(existsSync(join(dir, "credential.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes precedence over a stored credential — an explicit variable beats ambient state", async () => {
    // configDir holds a credential for baseUrl already. A bogus env token must WIN, and therefore
    // fail, proving precedence rather than a silent fallback to the stored one.
    const r = await cli(["auth", "status", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_TOKEN: "not-a-valid-token" },
    });
    const doc = JSON.parse(r.out) as { credential: string; authenticated: boolean };
    expect(doc.credential).toBe("environment");
    expect(doc.authenticated).toBe(false);
  });

  it("auth status reports the environment as the credential source", async () => {
    const r = await cli(["auth", "status"], {
      env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_TOKEN: GOOD_TOKEN },
      tty: true, // the human rendering is what names the source; JSON is asserted above
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("SIGNUM_TOKEN");
    expect(r.err).toContain("ambient");
    expect(r.out + r.err).not.toContain(GOOD_TOKEN); // AC-06.3 still holds
  });

  it("a rotation WARNS instead of failing — there is nowhere to write it back to", async () => {
    // The default rotation handler updates the STORED credential and would fail with "no stored
    // credential to rotate", turning a successful request into a hard error. Same shape as the
    // login-time rotation defect the Brooks review found.
    const dir = fresh();
    rotateNext = true;
    const r = await cli(["query", "Order", "--json"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: GOOD_TOKEN },
    });
    rotateNext = false;
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("cannot be updated from here");
    expect(r.err).not.toContain("no stored credential to rotate");
    expect(existsSync(join(dir, "credential.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an empty SIGNUM_TOKEN is ignored, not treated as a credential", async () => {
    const dir = fresh();
    const r = await cli(["query", "Order"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl, SIGNUM_TOKEN: "" },
    });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the not-authenticated message names SIGNUM_TOKEN as the non-interactive route", async () => {
    const dir = fresh();
    const r = await cli(["query", "Order"], { env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl } });
    expect(r.code).toBe(ExitCode.NotAuthenticated);
    expect(r.err).toContain("SIGNUM_TOKEN");
    rmSync(dir, { recursive: true, force: true });
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

describe("version (previously 0% covered)", () => {
  it("reports the CLI's own version with no target configured", async () => {
    const r = await cli(["version"], { env: { SIGNUM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "signum-ver-")) }, tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("signum");
  });

  it("the reported version is the one in package.json — single source of truth (M4)", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    const r = await cli(["version", "--json"], { env: { SIGNUM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "signum-ver2-")) } });
    expect((JSON.parse(r.out) as { cli: string }).cli).toBe(pkg.version);
  });

  it("reports the target as reachable when it responds", async () => {
    const r = await cli(["version", "--url", baseUrl, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { target: { reachable: boolean } | null };
    expect(doc.target?.reachable).toBe(true);
  });

  it("reports the target as unreachable rather than crashing, when it does not respond", async () => {
    const r = await cli(["version", "--url", "http://127.0.0.1:1", "--json"]);
    expect(r.code).toBe(ExitCode.Ok); // version itself still succeeds — only the target probe fails
    const doc = JSON.parse(r.out) as { target: { reachable: boolean } | null };
    expect(doc.target?.reachable).toBe(false);
  });
});

describe("caller-context override end-to-end (AC-50.4) — previously only unit-tested", () => {
  it("--caller-context interactive lets data through despite an agent marker, and logs the loosening", async () => {
    const r = await cli(
      ["query", "Order", "--json", "--caller-context", "interactive"],
      { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } },
    );
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("loosened");
  });

  it("--caller-context agent forces the gate even on an interactive TTY with no agent markers", async () => {
    const r = await cli(["query", "Order", "--caller-context", "agent"], { tty: true, env: { SIGNUM_CONFIG_DIR: configDir } });
    expect(r.code).toBe(ExitCode.Policy);
  });

  it("tightening the context is silent — no loosening warning", async () => {
    const r = await cli(["query", "Order", "--caller-context", "agent"], { tty: true, env: { SIGNUM_CONFIG_DIR: configDir } });
    expect(r.err).not.toContain("loosened");
  });

  it("SIGNUM_ALLOW_AGENT_DATA=1 works as an alternative to the flag", async () => {
    const r = await cli(["query", "Order", "--json"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1", SIGNUM_ALLOW_AGENT_DATA: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
  });

  it("an invalid --caller-context value is a usage error, not a silent no-op", async () => {
    const r = await cli(["query", "Order", "--caller-context", "nonsense"]);
    expect(r.code).toBe(ExitCode.Usage);
  });
});
