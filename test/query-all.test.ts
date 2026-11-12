/**
 * `query --all` pages and streams — STORY-23 (AC-23.3, AC-23.4, AC-23.5).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";

const REFLECTION = {
  Order: { kind: "Entity", entityKind: "Main", niceName: "Order", queryDefined: true, members: {}, operations: {} },
};
const DESCRIPTION = {
  queryKey: "Order",
  columns: {
    Entity: { name: "Entity", fullKey: "Entity", niceName: "Entity", type: { name: "Order" } },
    Name: { name: "Name", fullKey: "Name", niceName: "Name", type: { name: "string" } },
  },
};

/** The rows the mock holds; a test may change them, or the total it reports. */
let rows: Array<{ id: number; name: string }> = [];
let reportedTotal: ((page: number) => number) | undefined;
let pages: Array<Record<string, unknown>> = [];
/** Called when the mock is asked for this page, before it answers — the moment to press Ctrl-C. */
let onPage: ((page: number) => Promise<void>) | undefined;

let server: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const headers = { "content-type": "application/json" };
      if (path === "/api/reflection/types") return new Response(JSON.stringify(REFLECTION), { headers });
      if (path.startsWith("/api/query/description/")) return new Response(JSON.stringify(DESCRIPTION), { headers });
      if (path === "/api/query/executeQuery/Order") {
        const body = (await req.json()) as { pagination: { mode: string; elementsPerPage: number; currentPage: number } };
        pages.push(body.pagination);
        const { elementsPerPage: size, currentPage: page } = body.pagination;
        await onPage?.(page);
        const slice = rows.slice((page - 1) * size, page * size);
        return new Response(JSON.stringify({
          columns: ["Name"],
          rows: slice.map((r) => ({ entity: { EntityType: "Order", id: r.id }, columns: [r.name] })),
          totalElements: reportedTotal?.(page) ?? rows.length,
        }), { headers });
      }
      return new Response(JSON.stringify({ exceptionMessage: `unexpected ${path}` }), { status: 500, headers });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-query-all-"));
  rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Customer ${i + 1}` }));
  reportedTotal = undefined;
  pages = [];
  onPage = undefined;
});

interface Result { code: ExitCode; out: string; err: string; prompts: string[] }
interface Options { context?: string; tty?: boolean; reply?: string; interrupt?: (fire: () => void) => void }

async function cli(argv: string[], o: Options = {}): Promise<Result> {
  let out = "", err = "";
  const prompts: string[] = [];
  let handler: (() => void) | undefined;
  o.interrupt?.(() => handler?.());
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: o.tty === true,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: url, SIGNUM_TOKEN: "t", SIGNUM_CALLER_CONTEXT: o.context ?? "automated" } as NodeJS.ProcessEnv,
    readStdin: async () => "",
    ...(o.tty === true ? { prompt: async (q: string) => { prompts.push(q); return o.reply ?? ""; } } : {}),
    onInterrupt: (h) => { handler = h; return () => { handler = undefined; }; },
  };
  try {
    return { code: await run(argv, io), out, err, prompts };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err, prompts };
  }
}

describe("--all pages until the rows run out (AC-23.3)", () => {
  it("asks for page after page of Paginate, never All, and writes one valid JSON array", async () => {
    const r = await cli(["query", "Order", "--all", "--page-size", "2", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(pages).toEqual([1, 2, 3].map((currentPage) => ({ mode: "Paginate", elementsPerPage: 2, currentPage })));
    const parsed = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(parsed.map((p) => p["Name"])).toEqual(rows.map((x) => x.name));
    // The same text the unpaged path prints for the same rows, byte for byte.
    expect(r.out).toBe(JSON.stringify(parsed, null, 2) + "\n");
  });

  it("stops at the total even when the last page is full, and pages 1000 rows by default", async () => {
    rows = rows.slice(0, 4);
    await cli(["query", "Order", "--all", "--page-size", "2", "--json"]);
    expect(pages.map((p) => p["currentPage"])).toEqual([1, 2]);
    pages = [];
    await cli(["query", "Order", "--all", "--json"]);
    expect(pages).toEqual([{ mode: "Paginate", elementsPerPage: 1000, currentPage: 1 }]);
  });

  it("writes csv's header once, one ndjson line per row, and one table header", async () => {
    const csv = await cli(["query", "Order", "--all", "--page-size", "2", "-o", "csv"]);
    expect(csv.out.trim().split("\n")).toEqual(["Entity,Name", ...rows.map((x) => `Order;${x.id},${x.name}`)]);
    const ndjson = await cli(["query", "Order", "--all", "--page-size", "2", "-o", "ndjson"]);
    expect(ndjson.out.trim().split("\n").map((l) => (JSON.parse(l) as { Name: string }).Name)).toEqual(rows.map((x) => x.name));
    const table = await cli(["query", "Order", "--all", "--page-size", "2", "-o", "table"]);
    expect(table.out.match(/^Entity/gm)).toHaveLength(1);
    expect(table.out).toContain("Customer 5");
  });

  it("an empty result is still an empty array, and a row count is no question", async () => {
    rows = [];
    const r = await cli(["query", "Order", "--all", "--json"]);
    expect(r.out).toBe("[]\n");
  });

  it("says when the result changed between pages, since a row may be missed or repeated", async () => {
    reportedTotal = (page) => (page === 1 ? 5 : 6);
    const r = await cli(["query", "Order", "--all", "--page-size", "2", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain("the result changed while it was paged");
  });

  it("pseudonymizes every page alike, and stores each page's handles", async () => {
    const r = await cli(["query", "Order", "--all", "--page-size", "2", "--json"], { context: "agent" });
    expect(r.code).toBe(ExitCode.Ok);
    const ids = (JSON.parse(r.out) as Array<{ Entity: string }>).map((p) => String(p.Entity));
    expect(ids.every((i) => i.startsWith(HANDLE_PREFIX))).toBe(true);
    expect(new Set(ids).size).toBe(5);
    // The one on the last page resolves, so it was stored.
    const back = await cli(["unmask", ids[4] as string], { context: "interactive", tty: true });
    expect(back.out).toContain("Order;5");
  });
});

describe("a large result is confirmed at a terminal (AC-23.4)", () => {
  it("asks a person how much is coming, and declining prints nothing", async () => {
    reportedTotal = () => 25_000;
    const r = await cli(["query", "Order", "--all", "-o", "table"], { tty: true, reply: "n", context: "interactive" });
    expect(r.prompts[0]).toContain("--all will fetch 25000 rows in 25 requests");
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.out).toBe("");
    expect(pages).toHaveLength(1);
  });

  it("goes ahead on yes, on --yes, and without a terminal", async () => {
    reportedTotal = () => 25_000;
    const yes = await cli(["query", "Order", "--all", "-o", "table"], { tty: true, reply: "y", context: "interactive" });
    expect(yes.out).toContain("Customer 1");
    const flagged = await cli(["query", "Order", "--all", "--yes", "-o", "table"], { tty: true, context: "interactive" });
    expect(flagged.prompts).toEqual([]);
    expect(flagged.code).toBe(ExitCode.Ok);
    const script = await cli(["query", "Order", "--all", "--json"]);
    expect(script.prompts).toEqual([]);
    expect(script.code).toBe(ExitCode.Ok);
  });
});

describe("Ctrl-C leaves what was written valid (AC-23.5)", () => {
  it("stops between pages and closes the array, exit 130", async () => {
    let fire: () => void = () => {};
    onPage = async (page) => {
      if (page !== 2) return;
      fire();
      await new Promise((resolve) => setTimeout(resolve, 200)); // still working when the abort lands
    };
    const r = await cli(["query", "Order", "--all", "--page-size", "2", "--json"], { interrupt: (f) => { fire = f; } });
    expect(r.code).toBe(ExitCode.Interrupted);
    expect((JSON.parse(r.out) as unknown[]).length).toBe(2);
    expect(r.err).toContain("interrupted after 2 rows");
  });
});

describe("what --all sends, and what it does not combine with", () => {
  it("--explain shows the first page and says the rest follow", async () => {
    const r = await cli(["query", "Order", "--all", "--page-size", "200", "--explain"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect((JSON.parse(r.out) as { body: { pagination: unknown } }).body.pagination)
      .toEqual({ mode: "Paginate", elementsPerPage: 200, currentPage: 1 });
    expect(r.err).toContain("once per page of 200");
    expect(pages).toEqual([]);
  });

  it("refuses --page with --all, and --page-size where nothing pages", async () => {
    const page = await cli(["query", "Order", "--all", "--page", "2"]);
    expect(page.code).toBe(ExitCode.Usage);
    expect(page.err).toContain("choose only one pagination mode");
    const lites = await cli(["query", "Order", "--lites", "--all", "--page-size", "5"]);
    expect(lites.code).toBe(ExitCode.Usage);
    expect(lites.err).toContain("--lites cannot be combined with --page-size");
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
