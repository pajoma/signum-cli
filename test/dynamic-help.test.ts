/**
 * Help that knows the application — STORY-61 (AC-61.1, AC-61.3, AC-61.5) for a query. The operation
 * half (AC-61.2) is in operations.test.ts, beside the operations it describes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";

const REFLECTION = {
  Order: { kind: "Entity", entityKind: "Main", niceName: "Order", queryDefined: true, members: {}, operations: {} },
};
// As QueryController.cs:144-158 builds it: Count and TimeSeries injected, then the query's columns.
const DESCRIPTION = {
  queryKey: "Order",
  columns: {
    Count: { key: "Count", fullKey: "Count", niceName: "Count", type: { name: "number" }, queryTokenType: "Aggregate" },
    TimeSeries: { key: "TimeSeries", fullKey: "TimeSeries", niceName: "Time series", type: { name: "DateTime" }, queryTokenType: "TimeSeries" },
    Entity: { key: "Entity", fullKey: "Entity", niceName: "Order", type: { name: "Order" }, filterType: "Lite" },
    Name: { key: "Name", fullKey: "Name", niceName: "Name", type: { name: "string" }, filterType: "String" },
    State: { key: "State", fullKey: "State", niceName: "State", type: { name: "OrderState" }, filterType: "Enum" },
  },
};

let seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      const headers = { "content-type": "application/json" };
      if (path === "/api/reflection/types") return new Response(JSON.stringify(REFLECTION), { headers });
      // QueryController is not anonymous: no credential is a 403, as Signum answers it.
      if (req.headers.get("authorization") === null) {
        return new Response(JSON.stringify({ exceptionType: "Signum.Entities.Authorization.UnauthorizedAccessException", exceptionMessage: "Not authorized" }), { status: 403, headers });
      }
      if (path === "/api/query/description/Order") return new Response(JSON.stringify(DESCRIPTION), { headers });
      if (path === "/api/query/executeQuery/Order") {
        return new Response(JSON.stringify({ columns: ["Name", "State"], rows: [], totalElements: 0 }), { headers });
      }
      return new Response(JSON.stringify({ exceptionMessage: `unexpected ${path}` }), { status: 500, headers });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-dynamic-help-"));
  seen = [];
});

interface Result { code: ExitCode; out: string; err: string }
async function cli(argv: string[], env: Record<string, string> = {}): Promise<Result> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: false,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_CALLER_CONTEXT: "interactive", SIGNUM_URL: url, ...env } as NodeJS.ProcessEnv,
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
const withLogin = { SIGNUM_TOKEN: "t" };

describe("query <key> --help describes that query (AC-61.1)", () => {
  it("prints the static help, then its columns, filter tokens and ordering", async () => {
    const r = await cli(["query", "Order", "--help"], withLogin);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Run a dynamic query"); // the static portion comes first
    const app = r.out.slice(r.out.indexOf("ORDER IN THIS APPLICATION"));
    const section = (title: string) => app.slice(app.indexOf(title)).split("\n\n")[0] as string;
    // The default columns are the web client's: no Entity, no injected pseudo-tokens.
    expect(section("COLUMNS")).toMatch(/Name\s+string/);
    expect(section("COLUMNS")).not.toContain("Entity");
    expect(section("COLUMNS")).not.toContain("Count");
    // A filter may name the entity; an aggregate only with --group; a time series never here.
    expect(section("FILTER TOKENS")).toMatch(/Entity\s+Order/);
    expect(section("FILTER TOKENS")).toMatch(/Count\s+number, with --group only/);
    expect(section("FILTER TOKENS")).not.toContain("TimeSeries");
    expect(section("ORDERING")).toContain("The query sets none");
    expect(seen).toEqual(["/api/reflection/types", "/api/query/description/Order"]);
  });

  it("says the same as `help query <key>`, and as JSON names both halves", async () => {
    const viaHelp = await cli(["help", "query", "Order"], withLogin);
    expect(viaHelp.out).toContain("ORDER IN THIS APPLICATION");
    const json = JSON.parse((await cli(["query", "Order", "--help", "--json"], withLogin)).out) as {
      command: { name: string }; application: { columns: Array<{ token: string }>; filterTokens: Array<{ token: string; groupOnly: boolean }> };
    };
    expect(json.command.name).toBe("query");
    expect(json.application.columns.map((c) => c.token)).toEqual(["Name", "State"]);
    expect(json.application.filterTokens.find((t) => t.token === "Count")?.groupOnly).toBe(true);
  });
});

describe("dynamic help works offline from the cache (AC-61.3)", () => {
  it("once the query has run, its help needs no network, and says the copy is cached", async () => {
    await cli(["query", "Order", "--top", "1"], withLogin); // describes the query, so the description is kept
    seen = [];
    const r = await cli(["query", "Order", "--help", "--offline"], withLogin);
    expect(r.out).toContain("ORDER IN THIS APPLICATION  (metadata cached");
    expect(r.out).toContain("columns cached");
    expect(r.out).toMatch(/Name\s+string/);
    expect(seen).toEqual([]);
  });

  it("is listed by `cache show` and removed by `cache clear`", async () => {
    await cli(["query", "Order", "--help"], withLogin);
    expect((await cli(["cache", "show", "-o", "table"], withLogin)).out).toContain("1 query description");
    await cli(["cache", "clear"], withLogin);
    const r = await cli(["query", "Order", "--help", "--offline"], withLogin);
    expect(r.err).toContain("could not describe query Order");
  });
});

describe("without the application, help degrades rather than fails (AC-61.5)", () => {
  it("no application named: the static help, one note naming --url and -i, exit 0", async () => {
    const r = await cli(["query", "Order", "--help"], { SIGNUM_URL: "" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.out).toContain("Run a dynamic query");
    expect(r.err).toContain("could not describe query Order for this application: no target application specified");
    expect(r.err).toContain("--url");
  });

  it("no login and nothing cached: still exit 0, saying the description needs one", async () => {
    const r = await cli(["query", "Order", "--help"], {});
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("could not describe query Order");
    expect(r.out).not.toContain("IN THIS APPLICATION");
  });

  it("an unknown query is a note with the near match, not an error", async () => {
    const r = await cli(["query", "Ordr", "--help"], withLogin);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("could not describe query Ordr");
    expect(r.err).toContain("Order");
  });

  it("`query --help` with no key reads no configuration, as before (AC-60.2)", async () => {
    const r = await cli(["query", "--help"], { SIGNUM_URL: "", SIGNUM_INSTANCE: "nowhere" });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).not.toContain("could not describe"); // an unknown instance was not even looked up
    expect(r.err).not.toContain("nowhere");
    expect(seen).toEqual([]);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
