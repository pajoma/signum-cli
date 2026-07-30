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
import { saveHandles } from "../src/core/config.ts";
import { ExitCode } from "../src/core/errors.ts";
// Asserted via the constant, not a literal: the prefix changed once (ref: -> ref_) and a literal
// here would have to be found and edited again next time.
import { HANDLE_PREFIX } from "../src/core/privacy.ts";

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
    members: {
      UserName: { type: { name: "string" } },
      // The #98 trap, exactly as reported: reflection describes the ENTITY, so a field contributed
      // by a mixin is reported with its mixin prefix. The query description names the same field
      // `FirstName` (see USER_SUB_TOKENS) — reflection members and query tokens are different
      // namespaces, so this name is one `explain` used to offer and `query --column` rejects.
      "[UserProjectMixin].FirstName": { type: { name: "string" } },
    },
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
 * `QueryDescriptionTS` (`QueryController.cs:139-158`): every column the query exposes, keyed by
 * name, PLUS two injected pseudo-tokens — an `AggregateToken` for Count and a `TimeSeriesToken`.
 * `Entity` is present too. The framework's own default-column rule drops all three
 * (`Finder.tsx:383-387`), which is what the CLI must reproduce.
 */
const QUERY_DESCRIPTION = {
  queryKey: "Order",
  columns: {
    Entity: { key: "Entity", fullKey: "Entity", niceName: "Order", type: { name: "Order" }, isGroupable: true },
    Count: { key: "Count", fullKey: "Count", queryTokenType: "Aggregate", type: { name: "number" }, isGroupable: false },
    TimeSeries: { key: "TimeSeries", fullKey: "TimeSeries", queryTokenType: "TimeSeries", type: { name: "DateTime" }, isGroupable: false },
    Id: { key: "Id", fullKey: "Id", niceName: "Id", type: { name: "number" }, isGroupable: true },
    State: { key: "State", fullKey: "State", niceName: "State", type: { name: "string" }, isGroupable: true },
    Total: { key: "Total", fullKey: "Total", niceName: "Total", type: { name: "decimal" }, isGroupable: true },
    // Entity-valued, like the reported UserSkill.User — renders as "User;102" without help.
    Customer: { key: "Customer", fullKey: "Customer", niceName: "Customer",
      queryTokenType: null, filterType: "Lite", type: { name: "Customer" }, isGroupable: true },
  },
};

/** Every executeQuery request the mock received, so tests can assert what was actually sent. */
const executeQueryRequests: Array<{ queryKey: string; columns: Array<{ token: string }> }> = [];

/**
 * Every parseTokens request, so a test can assert the token lists were validated in ONE round trip
 * (#97) rather than one call per slot. Counting calls is the only way to see that: a second call
 * would validate everything just as correctly, so no assertion about the OUTCOME can catch it.
 */
const parseTokensRequests: string[][] = [];

/**
 * Token continuations, keyed by the token asked about (`null` = the query's own root columns).
 * Shapes follow `QueryTokenTS` (`QueryController.cs:251-272`): camelCase, `type` is a
 * TypeReferenceTS, and `queryTokenType` is absent for an ordinary column token.
 */
const SUB_TOKENS: Record<string, unknown[]> = {
  // The query's own root tokens. Kept in step with QUERY_DESCRIPTION: #95's fix validates every
  // named --column and --order against parseTokens, so a token this list omits now fails the way a
  // genuinely invalid one does — which is exactly what caught this fixture being short of `Total`.
  "": [
    { key: "Id", fullKey: "Id", niceName: "Id", type: { name: "number" }, isGroupable: true },
    { key: "Entity", fullKey: "Entity", niceName: "Order", type: { name: "Order" }, isGroupable: true },
    { key: "State", fullKey: "State", niceName: "State", type: { name: "string" }, isGroupable: true },
    { key: "Total", fullKey: "Total", niceName: "Total", type: { name: "decimal" }, isGroupable: true },
    { key: "Customer", fullKey: "Customer", niceName: "Customer", filterType: "Lite",
      type: { name: "Customer" }, isGroupable: true },
  ],
  // Aggregates on a decimal column, transcribed from `QueryUtils.AggregateTokens` (`:292-320`):
  // Integer/Decimal/Boolean get Average, Sum, Min and Max. Added because #97 validates filter
  // tokens, so `--filter "Total.Sum > 100" --group` — a case AC-20.7 names explicitly — started
  // failing as though the token were invalid. The real server resolves it: parseTokens passes
  // SubTokensOptions.All, which includes CanAggregate.
  Total: [
    { key: "Average", fullKey: "Total.Average", niceName: "Average of Total", queryTokenType: "Aggregate",
      type: { name: "decimal" }, isGroupable: false },
    { key: "Sum", fullKey: "Total.Sum", niceName: "Sum of Total", queryTokenType: "Aggregate",
      type: { name: "decimal" }, isGroupable: false },
    { key: "Min", fullKey: "Total.Min", niceName: "Min of Total", queryTokenType: "Aggregate",
      type: { name: "decimal" }, isGroupable: false },
    { key: "Max", fullKey: "Total.Max", niceName: "Max of Total", queryTokenType: "Aggregate",
      type: { name: "decimal" }, isGroupable: false },
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

/**
 * Root tokens for the `UserEntity` query specifically (#98).
 *
 * `SUB_TOKENS` above is keyed only by token path, so it answered for every query alike — the mock
 * ignored `queryKey` entirely. That conflation would hide the one thing #98 is about: the same field
 * has a mixin-prefixed name in reflection and an unprefixed one as a token. `FirstName` here is
 * `[UserProjectMixin].FirstName` there, and nothing else in the fixture could show that.
 */
const USER_SUB_TOKENS = [
  { key: "Id", fullKey: "Id", niceName: "Id", type: { name: "number" }, isGroupable: true },
  { key: "Entity", fullKey: "Entity", niceName: "User", type: { name: "User" }, isGroupable: true },
  { key: "UserName", fullKey: "UserName", niceName: "User name", type: { name: "string" }, isGroupable: true },
  { key: "FirstName", fullKey: "FirstName", niceName: "First name", type: { name: "string" }, isGroupable: true },
];

/**
 * The root tokens of a query, for BOTH `subTokens` and `parseTokens`.
 *
 * The real server resolves both through `QueryUtils.Parse` against one `QueryDescription`, so they
 * cannot disagree. This fixture could: a per-query override added to only one handler made the mock
 * offer `FirstName` from `subTokens` and then reject it from `parseTokens` — which failed the very
 * test asserting that `explain` and `query --column` agree, for a reason that existed only in the
 * mock. One function for both, so the fixture has the same single source the product does.
 */
function rootTokensFor(queryKey: string): unknown[] {
  return queryKey === "UserEntity" ? USER_SUB_TOKENS : (SUB_TOKENS[""] as unknown[]);
}

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
        // Root tokens are per-query — `UserEntity`'s are not Order's (#98). Deeper paths still come
        // from the shared table, which is enough for what the tests walk.
        const children = body.token === null
          ? rootTokensFor(body.queryKey)
          : SUB_TOKENS[body.token] ?? (known.has(body.token) ? [] : undefined);
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
        parseTokensRequests.push(body.tokens);
        const out: unknown[] = [];
        for (const t of body.tokens) {
          const parentKey = t.split(".").slice(0, -1).join("");
          const leaf = t.split(".").pop() as string;
          const parentPath = t.split(".").slice(0, -1).join(".");
          // Same source as subTokens above — see `rootTokensFor`.
          const siblings = (parentPath === "" ? rootTokensFor(body.queryKey) : SUB_TOKENS[parentPath]) as
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
      if (url.pathname.startsWith("/api/query/description/")) {
        return new Response(JSON.stringify(QUERY_DESCRIPTION), { headers });
      }
      if (url.pathname.startsWith("/api/query/executeQuery/")) {
        executeQueryRequests.push(
          (await req.json()) as { queryKey: string; columns: Array<{ token: string }> },
        );
        return new Response(JSON.stringify(RESULT_TABLE), { headers });
      }
      if (url.pathname.startsWith("/api/query/queryValue/")) {
        return new Response("7", { headers });
      }
      if (url.pathname === "/api/entity/Order/42") {
                // `name` is a heuristic hit; Type/id/ticks are structural and must survive untouched.
        return new Response(
          JSON.stringify({ Type: "Order", id: 42, ticks: "638", toStr: "Order 42", name: "Acme GmbH" }),
          { headers },
        );
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

  // ── #98: members are the reflection view, not the token namespace ──────────

  // These pass SIGNUM_TOKEN explicitly rather than leaning on a credential a previous test wrote:
  // the surrounding block is the credential-free one, and an ordering-dependent test that silently
  // exercises the degraded path instead of the real one is worse than no test.

  it("`explain <Type>` lists the query's TOKENS beside its reflection members (#98)", async () => {
    const r = await cli(["explain", "UserEntity", "--url", baseUrl, "--json"], {
      env: { SIGNUM_TOKEN: GOOD_TOKEN },
    });
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as {
      members: Array<{ name: string }>;
      queryTokens: Array<{ key: string }> | null;
      queryTokensUnavailable: string | null;
    };
    // Reflection reports the mixin-prefixed name...
    expect(doc.members.map((m) => m.name)).toContain("[UserProjectMixin].FirstName");
    // ...and the token list reports the same field unprefixed, which is the usable name.
    expect(doc.queryTokens?.map((t) => t.key)).toContain("FirstName");
    expect(doc.queryTokens?.map((t) => t.key)).not.toContain("[UserProjectMixin].FirstName");
    expect(doc.queryTokensUnavailable).toBeNull();
  });

  it("the tokens shown are exactly what `query --column` accepts (#98)", async () => {
    // The third acceptance point: two definitions of "what tokens exist" could disagree, which is
    // the single-source problem. Both read `subTokens`/`parseTokens`, so a token offered here must
    // be one the query path accepts — asserted by round-tripping it, not by inspection.
    const r = await cli(["explain", "UserEntity", "--url", baseUrl, "--json"], {
      env: { SIGNUM_TOKEN: GOOD_TOKEN },
    });
    const offered = (JSON.parse(r.out) as { queryTokens: Array<{ key: string; usableInQuery: boolean }> })
      .queryTokens.filter((t) => t.usableInQuery).map((t) => t.key);
    expect(offered.length).toBeGreaterThan(0);
    for (const token of offered) {
      const q = await cli(["query", "UserEntity", "--column", token, "--url", baseUrl, "--explain"], {
        env: { SIGNUM_TOKEN: GOOD_TOKEN },
      });
      expect(q.code).toBe(ExitCode.Ok);
    }
  });

  it("a mixin-prefixed member offered by `explain` is REJECTED by query (#98, the trap)", async () => {
    // The defect in one assertion: the CLI used to print this name under a bare "MEMBERS" heading
    // with no indication it was unusable.
    const r = await cli(
      ["query", "UserEntity", "--column", "[UserProjectMixin].FirstName", "--url", baseUrl, "--explain"],
      { env: { SIGNUM_TOKEN: GOOD_TOKEN } },
    );
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("invalid query token");
  });

  it("human output names the two namespaces and warns about mixin members (#98)", async () => {
    const r = await cli(["explain", "UserEntity", "--url", baseUrl], {
      tty: true, env: { SIGNUM_TOKEN: GOOD_TOKEN },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("not all are query tokens");
    expect(r.out).toContain("QUERY TOKENS");
    expect(r.err).toContain("mixin prefix");
    // The next-step line must point into the TOKEN namespace, not the member one — it used to
    // say `.<member>`, which is the trap given as advice.
    expect(r.out).toContain(`signum explain UserEntity.<token>`);
    expect(r.out).not.toContain(".<member>");
  });

  it("degrades to members with a note when tokens need a credential (AC-61.4, #98)", async () => {
    // The whole point of the degradation: anonymous `explain <Type>` must keep working, so a
    // missing credential costs the token list and nothing else.
    const fresh = mkdtempSync(join(tmpdir(), "signum-anon3-"));
    const r = await cli(["explain", "UserEntity", "--url", baseUrl], {
      env: { SIGNUM_CONFIG_DIR: fresh },
      tty: true,
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("UserName");                    // members still there
    expect(r.out).not.toContain("QUERY TOKENS");
    expect(r.err).toContain("could not list this query's tokens");
    // And it still explains the trap without the token list to show it — option 3 of the issue.
    expect(r.err).toContain("[SomeMixin].Field");
    rmSync(fresh, { recursive: true, force: true });
  });

  it("--offline skips the token call rather than failing (#98)", async () => {
    const r = await cli(["explain", "UserEntity", "--url", baseUrl, "--offline", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { queryTokens: unknown; queryTokensUnavailable: string | null };
    expect(doc.queryTokens).toBeNull();
    expect(doc.queryTokensUnavailable).toContain("--offline");
  });

  it("a type with no query reports that, not a failure (#98)", async () => {
    const r = await cli(["explain", "Ledger", "--url", baseUrl, "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { hasQuery: boolean; queryTokensUnavailable: string | null };
    expect(doc.hasQuery).toBe(false);
    expect(doc.queryTokensUnavailable).toBe("this type has no query");
  });

  it("does not suggest `query <Type>` for a type that has no query", async () => {
    // Found by running the binary: `explain Ledger` closed with `Next: … signum query Ledger`,
    // which `signum query` then refuses. Same defect class as #98 — offering a dead end.
    const r = await cli(["explain", "Ledger", "--url", baseUrl], { tty: true });
    expect(r.out).not.toContain("signum query Ledger --column");
    expect(r.out).toContain("has no query");
    // And the claim is true: the query path refuses it, so the two agree.
    const q = await cli(["query", "Ledger", "--url", baseUrl, "--explain"], {
      env: { SIGNUM_TOKEN: GOOD_TOKEN },
    });
    expect(q.code).not.toBe(ExitCode.Ok);
  });

  it("under --offline the degraded note blames --offline, not the credential", async () => {
    // Also found by running it: the closing line said "needs a credential" for an --offline run,
    // where a credential would change nothing.
    const r = await cli(["explain", "UserEntity", "--url", baseUrl, "--offline"], {
      tty: true, env: { SIGNUM_TOKEN: GOOD_TOKEN },
    });
    expect(r.err).toContain("Drop --offline");
    expect(r.err).not.toContain("needs a credential");
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

  it("sends the query's DEFAULT columns when none are named (AC-20.3)", async () => {
    // The live-run bug: `columns: []` means "no columns", not "the defaults". The server then
    // injects an entity column because the request has none (AutoDynamicQuery.cs:96-98) and hoists
    // it straight out again, so the user saw a one-column table containing only the Lite key.
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--top", "1", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);

    const sent = executeQueryRequests.at(-1);
    const tokens = (sent?.columns ?? []).map((c) => c.token);
    // Entity, Count and TimeSeries are all excluded — the framework's own rule (Finder.tsx:383-387).
    expect(tokens).toEqual(["Id", "State", "Total", "Customer"]);
  });

  it("--resolve rewrites entity columns to .ToString, so the SERVER returns labels", async () => {
    // The reported problem: a table full of `User;102`. EntityToStringToken (Key == "ToString")
    // resolves the label in the same query — no N+1, no second round trip per row.
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--resolve", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    const tokens = (executeQueryRequests.at(-1)?.columns ?? []).map((c) => c.token);
    // Only the Lite-typed column changes; scalars are left alone.
    expect(tokens).toEqual(["Id", "State", "Total", "Customer.ToString"]);
  });

  it("--resolve leaves the identity column alone — it must stay pasteable", async () => {
    executeQueryRequests.length = 0;
    await cli(["query", "Order", "--resolve", "--column", "Entity", "--column", "State", "--json"]);
    const tokens = (executeQueryRequests.at(-1)?.columns ?? []).map((c) => c.token);
    expect(tokens).toEqual(["Entity", "State"]);
  });

  it("--resolve on explicitly named columns asks parseTokens which are entity-valued", async () => {
    executeQueryRequests.length = 0;
    await cli(["query", "Order", "--resolve", "--column", "State", "--json"]);
    // State is a string, so it is untouched — proving the rewrite is type-driven, not name-driven.
    expect((executeQueryRequests.at(-1)?.columns ?? []).map((c) => c.token)).toEqual(["State"]);
  });

  it("named columns REPLACE the defaults rather than adding to them", async () => {
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--column", "State", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((executeQueryRequests.at(-1)?.columns ?? []).map((c) => c.token)).toEqual(["State"]);
  });

  it("--count resolves no columns — it transfers no rows", async () => {
    const r = await cli(["query", "Order", "--count"], { tty: true });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out.trim()).toBe("7");
  });

  it("--group does NOT get default columns — only the caller can choose grouping keys", async () => {
    const r = await cli(["query", "Order", "--group", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { columns: unknown[]; groupResults: boolean } };
    expect(doc.body.groupResults).toBe(true);
    expect(doc.body.columns).toEqual([]);
  });

  it("--explain resolves the defaults too, so the preview matches what would be sent", async () => {
    const r = await cli(["query", "Order", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as { body: { columns: Array<{ token: string }> } };
    expect(doc.body.columns.map((c) => c.token)).toEqual(["Id", "State", "Total", "Customer"]);
  });

  it("--explain degrades with a note when the defaults cannot be resolved, rather than failing", async () => {
    // The description endpoint needs a credential; --explain must keep working without one.
    const dir = mkdtempSync(join(tmpdir(), "signum-nocred-"));
    const r = await cli(["query", "Order", "--explain"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("could not resolve this query's default columns");
    const doc = JSON.parse(r.out) as { body: { columns: unknown[] } };
    expect(doc.body.columns).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates a named --column WITHOUT --resolve (#95)", async () => {
    // The whole bug: validation lived inside the --resolve branch, so the same invalid column got a
    // precise error with --resolve and a generic 500-derived line without it.
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--column", "NoSuchColumn", "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("invalid query token");
    expect(r.err).toContain("Valid here:");
    // ...and nothing was sent, which is the point of validating client-side (AC-20.7).
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("gives the SAME error with and without --resolve — no flag decides message quality", async () => {
    const without = await cli(["query", "Order", "--column", "NoSuchColumn", "--json"]);
    const with_ = await cli(["query", "Order", "--column", "NoSuchColumn", "--resolve", "--json"]);
    expect(without.code).toBe(with_.code);
    expect(without.err).toBe(with_.err);
  });

  it("validates --order too, which had no validation on any path (#95)", async () => {
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--order", "NoSuchColumn", "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("invalid query token");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("strips the descending `-` before validating an order token", async () => {
    // The minus is our marker, not part of the token; validating `-State` would reject a valid sort.
    const r = await cli(["query", "Order", "--order", "-State", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(executeQueryRequests.at(-1)?.columns).toBeDefined();
  });

  it("accepts valid named columns and orders together, in one round trip", async () => {
    const r = await cli(["query", "Order", "--column", "State", "--order", "-Total", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
  });

  // ── #97: filter tokens ─────────────────────────────────────────────────────
  //
  // #95 fixed --column and --order. Filter tokens still reached executeQuery unvalidated, so a typo
  // in a filter got the generic 500-derived line while the same typo in a column got a precise one.

  it("validates a --filter token before the request (#97)", async () => {
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--filter", "Statee = 'Shipped'", "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("invalid query token 'Statee'");
    // A near miss gets the suggestion rather than the full list — `explainRejection` prefers
    // `nearestTokens`, and 'Statee' is one edit from 'State'.
    expect(r.err).toContain("Did you mean: State?");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("gives a filter typo the SAME quality of error as a column typo (#97)", async () => {
    // The asymmetry #95 removed for --resolve, removed again for the filter/column split: the same
    // misspelled token should not be diagnosed better in one slot than the other.
    const asColumn = await cli(["query", "Order", "--column", "Statee", "--json"]);
    const asFilter = await cli(["query", "Order", "--filter", "Statee = 'Shipped'", "--json"]);
    expect(asFilter.code).toBe(asColumn.code);
    expect(asFilter.err).toBe(asColumn.err);
  });

  it("validates a token nested inside a filter GROUP, not just top-level ones (#97)", async () => {
    // `lowerFilterExpressions` flattens only the OUTERMOST and, so the or below stays a real group
    // with its own `filters` array — the depth a flat walk would miss.
    executeQueryRequests.length = 0;
    const r = await cli([
      "query", "Order", "--filter", "State = 'Shipped' and (Totall > 100 or Id = 2)", "--json",
    ]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("Totall");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("validates --filter-json tokens, at depth, so the escape hatch is not a hole (#97)", async () => {
    const path = join(configDir, "bad-filter.json");
    writeFileSync(path, JSON.stringify([
      { groupOperation: "Or", filters: [{ token: "NoSuchColumn", operation: "EqualTo", value: 1 }] },
    ]));
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--filter-json", path, "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("NoSuchColumn");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("validates a GROUP's own token, which is not a condition (#97)", async () => {
    // `FilterGroupTS.token` (`FilterJsonConverter.cs:128`) — a group carries a token AND children,
    // so a walk that treats the two as either/or silently skips it. The DSL never emits one;
    // --filter-json can.
    const path = join(configDir, "group-token.json");
    writeFileSync(path, JSON.stringify([
      { groupOperation: "Or", token: "NoSuchGroupToken", filters: [{ token: "State", operation: "EqualTo", value: "Shipped" }] },
    ]));
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--filter-json", path, "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("NoSuchGroupToken");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("validates columns, orders and filters in ONE round trip (#97)", async () => {
    parseTokensRequests.length = 0;
    const r = await cli([
      "query", "Order", "--column", "State", "--order", "-Total", "--filter", "Id > 1", "--json",
    ]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(parseTokensRequests).toHaveLength(1);
    // Columns first, then orders, then filter tokens — the order the two positional reads rely on.
    expect(parseTokensRequests[0]).toEqual(["State", "Total", "Id"]);
  });

  it("sends a token named in several conditions only once (#97)", async () => {
    parseTokensRequests.length = 0;
    const r = await cli(["query", "Order", "--filter", "Total > 1 and Total < 500", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(parseTokensRequests[0]).toEqual(["Total"]);
  });

  it("validates an aggregate filter token under --group, where it is legal (AC-20.7, #97)", async () => {
    parseTokensRequests.length = 0;
    const r = await cli(["query", "Order", "--filter", "Total.Sum > 100", "--group", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(parseTokensRequests[0]).toEqual(["Total.Sum"]);
  });

  it("still catches a misspelled aggregate under --group", async () => {
    const r = await cli(["query", "Order", "--filter", "Total.Sumn > 100", "--group", "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("invalid query token");
  });

  it("refuses a filter token that parseTokens accepts but a filter cannot use (AC-24.7, #97)", async () => {
    // `.Nested` is offered by subTokens and accepted by parseTokens (SubTokensOptions.All), but a
    // filter is parsed without CanNested, so executeQuery would 500. filter.ts catches this by name
    // for the DSL; --filter-json bypassed that, which left the hole on the least-checked path.
    const path = join(configDir, "nested-filter.json");
    writeFileSync(path, JSON.stringify([
      { token: "Entity.Details.Nested", operation: "EqualTo", value: 1 },
    ]));
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--filter-json", path, "--json"]);
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("cannot be used in a filter");
    expect(r.err).toContain("Entity.Details.Nested");
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("--explain degrades on a missing credential for filter tokens too (#97)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signum-nocred-"));
    const r = await cli(["query", "Order", "--filter", "State = 'Shipped'", "--explain"], {
      env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: baseUrl },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("could not validate the query's tokens");
    // The filter still reaches the previewed request — degraded validation must not drop input.
    const doc = JSON.parse(r.out) as { body: { filters: Array<{ token: string }> } };
    expect(doc.body.filters[0]?.token).toBe("State");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an unreadable --filter-json path even under a detected agent caller (#97)", async () => {
    // Moved beside the DSL parse: a bad path is a diagnostic about the caller's OWN input, so it
    // must not be masked by the data-gate refusal, exactly as --filter already was not.
    const r = await cli(["query", "Order", "--filter-json", "/nonexistent/filters.json", "--json"], {
      env: { CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("could not read --filter-json file");
    expect(r.err).not.toContain("refusing");
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

  it("gives an agent PSEUDONYMIZED entity data instead of a refusal (REQ-057, AC-51.4)", async () => {
    // m1 refused outright and named pseudonymization as "the intended remedy". The remedy exists
    // now, so the honest behaviour is to apply it rather than keep refusing.
    const r = await cli(["get", "Order", "42"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("pseudonymized (heuristic)");
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    // `name` matched the heuristic and was replaced...
    expect(doc["name"]).not.toBe("Acme GmbH");
    expect(String(doc["name"])).toMatch(/-[0-9a-f]{4}$/);
    // ...while structural keys survive untouched. Replacing Type/id/ticks would corrupt the
    // document and break the round-trip invariants REQ-031 depends on.
    expect(doc["id"]).toBe(42);
    expect(doc["Type"]).toBe("Order");
    expect(doc["ticks"]).toBe("638");
  });

  it("--exists is likewise allowed under pseudonymization — it emits no personal values", async () => {
    const r = await cli(["get", "Order", "42", "--exists"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok);
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

/**
 * End-to-end handles — REQ-058 (#52) · STORY-53.
 *
 * The point of a handle is that an agent can ACT on a record it cannot identify. So the test that
 * matters is the round trip: query as an agent, get a ref:, then use that ref: to fetch the record —
 * with the handle resolved locally and never reaching the server.
 */
describe("ref: handles, end to end (REQ-058)", () => {
  /** A fresh profile with the shared credential, so handles start empty. */
  function profile(): string {
    const d = mkdtempSync(join(tmpdir(), "signum-e2e-refs-"));
    writeFileSync(join(d, "credential.json"), readFileSync(join(configDir, "credential.json")));
    return d;
  }

  it("emits ref: for the Entity column under strict, and stores it", async () => {
    const d = profile();
    const r = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    const handle = String(rows[0]?.["Entity"]);
    expect(handle).toStartWith(HANDLE_PREFIX);

    // Stored BEFORE emission, so what we printed is always resolvable.
    const stored = JSON.parse(readFileSync(join(d, "handles.json"), "utf8")) as Record<string, string>;
    expect(stored[handle]).toBe("Order;42");
    rmSync(d, { recursive: true, force: true });
  });

  it("accepts the handle where a Lite key goes, and resolves it LOCALLY (AC-53.2)", async () => {
    const d = profile();
    const q = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    const handle = String((JSON.parse(q.out) as Array<Record<string, unknown>>)[0]?.["Entity"]);

    // The mock only answers /api/entity/Order/42 — so a passing fetch proves the handle was
    // translated before the request, not forwarded.
    const g = await cli(["get", handle, "--json", "--pseudonymize", "off", "--i-understand-data-goes-to-a-model"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    expect(g.code).toBe(ExitCode.Ok);
    expect((JSON.parse(g.out) as Record<string, unknown>)["id"]).toBe(42);
    rmSync(d, { recursive: true, force: true });
  });

  it("an unknown handle fails locally and is NEVER sent (AC-53.5)", async () => {
    const d = profile();
    const r = await cli(["get", "ref:ffffffffffff", "--i-understand-data-goes-to-a-model"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("cannot resolve ref:ffffffffffff");
    rmSync(d, { recursive: true, force: true });
  });

  it("unmask resolves a handle for a human", async () => {
    const d = profile();
    const q = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    const handle = String((JSON.parse(q.out) as Array<Record<string, unknown>>)[0]?.["Entity"]);

    const r = await cli(["unmask", handle], { tty: true, env: { SIGNUM_CONFIG_DIR: d } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Order;42");
    rmSync(d, { recursive: true, force: true });
  });

  it("REFUSES an agent, even though pseudonymization opened the data gate (AC-53.4)", async () => {
    // This is the one command that needs its own check. Since REQ-057, an agent passes openData
    // whenever pseudonymization is active — correct for pseudonymized rows, and exactly wrong here,
    // because resolving a handle is the act of removing the protection.
    const d = profile();
    saveHandles({ "ref:aaaaaaaaaaaa": "Order;42" }, { SIGNUM_CONFIG_DIR: d } as unknown as NodeJS.ProcessEnv);
    const r = await cli(["unmask", "ref:aaaaaaaaaaaa"], {
      env: { SIGNUM_CONFIG_DIR: d, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Policy);
    expect(r.err).toContain("for a human");
    rmSync(d, { recursive: true, force: true });
  });

  it("--list counts without revealing, --clear expires everything (AC-53.3, AC-53.6)", async () => {
    const d = profile();
    saveHandles({ "ref:aaaaaaaaaaaa": "Order;42" }, { SIGNUM_CONFIG_DIR: d } as unknown as NodeJS.ProcessEnv);

    const list = await cli(["unmask", "--list"], { tty: true, env: { SIGNUM_CONFIG_DIR: d } });
    expect(list.out).toContain("1 handle stored");
    expect(list.out).not.toContain("Order;42"); // a count is not a disclosure

    const cleared = await cli(["unmask", "--clear"], { tty: true, env: { SIGNUM_CONFIG_DIR: d } });
    expect(cleared.out).toContain("removed");
    const after = await cli(["unmask", "ref:aaaaaaaaaaaa"], { tty: true, env: { SIGNUM_CONFIG_DIR: d } });
    expect(after.code).toBe(ExitCode.Usage);
    expect(after.err).toContain("cannot resolve");
    rmSync(d, { recursive: true, force: true });
  });

  it("rejects something that is not a handle rather than pretending to resolve it", async () => {
    const r = await cli(["unmask", "Order;42"], { tty: true, env: { SIGNUM_CONFIG_DIR: configDir } });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("not a handle");
  });
});

/**
 * REQ-078 (#90) — the last piece of the agent-mediated workflow.
 *
 * An agent composes the query and hands a human the command rather than reading the rows. Available
 * under any policy, because a command line is not data.
 */
describe("explain --privacy agrees with what the query actually does (AC-52.11)", () => {
  it("reports an entity-typed member as an identity, matching the value-based rule", async () => {
    // Introspection that contradicts behaviour is worse than none: an agent would confidently tell a
    // human "User will not be hidden" while the query hid it.
    const r = await cli(["explain", "Order", "--privacy", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    const doc = JSON.parse(r.out) as {
      members: Array<{ member: string; pseudonymize: boolean; reason: string }>;
    };
    const state = doc.members.find((m) => m.member === "State");
    expect(state).toMatchObject({ pseudonymize: false, reason: "not-sensitive" });
  });

  it("says nothing is hidden when the mode is off", async () => {
    const r = await cli(["explain", "Order", "--privacy", "--json"], {
      tty: true, env: { SIGNUM_CONFIG_DIR: configDir },
    });
    const doc = JSON.parse(r.out) as { mode: string; members: Array<{ pseudonymize: boolean }> };
    expect(doc.mode).toBe("off");
    expect(doc.members.every((m) => !m.pseudonymize)).toBe(true);
  });
});

describe("--as-command: emit the invocation, not the data (REQ-078)", () => {
  it("prints a runnable command and sends NO query", async () => {
    executeQueryRequests.length = 0;
    const r = await cli(["query", "Order", "--top", "5", "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out.trim()).toBe("signum query Order --top 5");
    // The point: no rows were fetched, so none could leak.
    expect(executeQueryRequests).toHaveLength(0);
  });

  it("is allowed under a detected agent with NO acknowledgement — it emits no data", async () => {
    const r = await cli(["query", "Order", "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("refusing to emit");
    expect(r.err).not.toContain("pseudonymized (");
  });

  it("carries filters through, quoted so the line runs verbatim", async () => {
    const r = await cli(["query", "Order", "--filter", "State = Shipped", "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.out.trim()).toBe('signum query Order --filter "State = Shipped"');
  });

  it("omits the acknowledgement flag — a human at a terminal needs no such assertion", async () => {
    const r = await cli(["query", "Order", "--as-command", "--i-understand-data-goes-to-a-model"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.out).not.toContain("i-understand");
    expect(r.out.trim()).toBe("signum query Order");
  });

  it("works for get too, and quotes a Lite key", async () => {
    const r = await cli(["get", "Order;42", "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out.trim()).toBe('signum get "Order;42"');
  });

  it("still validates the query key, so the human is never handed a broken command", async () => {
    // The echo sits AFTER validation deliberately: an unvalidated command would be a footgun
    // handed to someone who trusted the agent that produced it.
    const r = await cli(["query", "Nope", "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("unknown query key");
  });

  it("is REJECTED on a command that does not support it, rather than ignored", async () => {
    // The project's own rule since the --filer QA finding: a flag that does nothing must say so.
    const r = await cli(["types", "--url", baseUrl, "--as-command"], {
      env: { SIGNUM_CONFIG_DIR: configDir },
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("--as-command");
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

  it("gives an agent rows instead of a refusal, now that a remedy exists (REQ-057, AC-51.4)", async () => {
    const r = await cli(["query", "Order", "--json"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Ok); // m1 refused this outright
  });

  it("heuristic mode leaves non-sensitive columns alone but ALWAYS protects identities", async () => {
    // State and Total match no heuristic, so they are untouched — a rule that replaced them would
    // be over-firing. The Entity column is different: it is an identity by VALUE, whatever the
    // column is called, so it becomes a handle even under heuristic. Name-based rules cannot catch
    // that, because entity columns are called User/Customer/Owner, not "name".
    const r = await cli(["query", "Order", "--json"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(rows[0]?.["State"]).toBe("Shipped");
    expect(rows[0]?.["Total"]).toBe(1200.5);
    expect(String(rows[0]?.["Entity"])).toStartWith(HANDLE_PREFIX);
    expect(r.err).toContain("pseudonymized (heuristic): Entity");
  });

  it("an identity is protected even when its column name suggests nothing (the merge leak)", async () => {
    // #88's label rendering surfaced a Lite's `model` — a person's name — while classification only
    // looked at the column name. Two individually-correct behaviours that jointly printed real
    // names. Judged by value, the identity is caught regardless.
    const r = await cli(["query", "Order", "-o", "csv"], { env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" } });
    expect(r.out).not.toContain("Order;42");
    expect(r.out).toContain(HANDLE_PREFIX);
  });

  it("strict mode replaces everything not allowlisted, and discloses honestly (AC-52.6, 52.8)", async () => {
    const r = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("pseudonymized (strict)");
    // The disclosure must admit its own incompleteness rather than imply safety.
    expect(r.err).toContain("INCOMPLETE");
    expect(r.err).toContain("GDPR Art. 4(5)");
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(rows[0]?.["State"]).not.toBe("Shipped");
  });

  it("surrogates are STABLE — the same value reads the same across invocations (AC-52.1)", async () => {
    // Per-profile secret, not per-run: without this a multi-step agent workflow could not correlate
    // anything and surrogates would be no better than redaction (ADR 0009 Q1, AC-53.8).
    const a = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    const b = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(a.out).toBe(b.out);
    // ...and the same value in two rows maps to the same surrogate, which is what makes grouping work.
    const rows = JSON.parse(a.out) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["State"]).not.toBe(rows[1]?.["State"]); // Shipped vs Delivered stay distinct
  });

  it("STILL refuses when a human's profile turns pseudonymization off (STORY-51 preserved)", async () => {
    // The refusal is not gone, it is conditional: if the configured policy is `off`, an agent gets
    // nothing rather than silently getting real values. That is the one case where the m1 behaviour
    // remains exactly right.
    const dir = mkdtempSync(join(tmpdir(), "signum-privoff-"));
    writeFileSync(join(dir, "credential.json"), readFileSync(join(configDir, "credential.json")));
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ mode: "off" }));
    const r = await cli(["query", "Order"], { env: { SIGNUM_CONFIG_DIR: dir, CLAUDECODE: "1" } });
    expect(r.code).toBe(ExitCode.Policy);
    expect(r.err).toContain("--i-understand-data-goes-to-a-model");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an agent cannot LOOSEN the policy without the human acknowledgement (AC-52.10)", async () => {
    // The whole point of ADR 0009: the caller asking for weaker protection is the caller that wants
    // the data. Tightening is free; loosening is not the caller's to decide.
    const r = await cli(["query", "Order", "--pseudonymize", "off"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.err).toContain("refusing to loosen pseudonymization");
  });

  it("an agent CAN tighten the policy freely, and it is silent", async () => {
    const r = await cli(["query", "Order", "--pseudonymize", "strict", "--json"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("refusing to loosen");
    expect(r.err).toContain("pseudonymized (strict)");
  });

  it("with the acknowledgement, loosening works and is LOGGED", async () => {
    const r = await cli(["query", "Order", "--pseudonymize", "off", "--json", "--i-understand-data-goes-to-a-model"], {
      env: { SIGNUM_CONFIG_DIR: configDir, CLAUDECODE: "1" },
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("loosened to 'off'");
    // Real values, and no disclosure claiming otherwise.
    expect(r.err).not.toContain("pseudonymized (");
  });

  it("a human at a terminal is unaffected — no surrogates, no flag (AC-51.5)", async () => {
    const r = await cli(["query", "Order"], { tty: true, env: { SIGNUM_CONFIG_DIR: configDir } });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("pseudonymized (");
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

  it("--caller-context agent forces pseudonymization even on an interactive TTY", async () => {
    // Tightening the context still tightens the outcome; it just now means surrogates rather than
    // a refusal, which is the same protection with a usable result.
    const r = await cli(["query", "Order", "--caller-context", "agent", "--json"], {
      tty: true, env: { SIGNUM_CONFIG_DIR: configDir },
    });
    expect(r.code).toBe(ExitCode.Ok);
    // Tightening the context tightens the outcome: the identity column is now protected, while
    // State and Total — which match no heuristic — are left exactly as they were.
    expect(r.err).toContain("pseudonymized (heuristic): Entity");
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(rows[0]?.["State"]).toBe("Shipped");
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
