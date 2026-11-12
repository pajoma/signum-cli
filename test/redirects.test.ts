/**
 * Redirects are not followed (REQ-074): `fetch` keeps every header but `Authorization` on a
 * cross-origin hop, so a profile's own token header (AC-05.1) would otherwise travel with it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";

const TOKEN = "secret-redirect-token";

/** What reached the other origin, header by header. */
let elsewhere: Array<Record<string, string | null>> = [];
let other: ReturnType<typeof Bun.serve>;
let target: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  other = Bun.serve({
    port: 0,
    fetch(req) {
      elsewhere.push({ authorization: req.headers.get("authorization"), signum: req.headers.get("signum_authorization") });
      return Response.json({ userName: "attacker" });
    },
  });
  target = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/reflection/types") return Response.json({ Order: { kind: "Entity", entityKind: "Main", members: {}, operations: {} } });
      // A proxy bouncing the request to another origin.
      return new Response(null, { status: 302, headers: { location: `http://localhost:${other.port}${path}` } });
    },
  });
  url = `http://127.0.0.1:${target.port}`;
});
afterAll(() => { other.stop(true); target.stop(true); });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signum-redirect-"));
  elsewhere = [];
});

async function cli(argv: string[], env: Record<string, string>): Promise<{ code: ExitCode; out: string; err: string }> {
  let out = "", err = "";
  const io: Io = {
    out: (s) => { out += s; }, err: (s) => { err += s; },
    stdoutIsTty: false, stdinIsTty: true, readStdin: async () => "",
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_URL: url, SIGNUM_TOKEN: TOKEN, SIGNUM_CALLER_CONTEXT: "interactive", ...env } as NodeJS.ProcessEnv,
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), out, err };
  }
}

describe("a redirect is refused, never followed", () => {
  it("with the token in its own header, nothing reaches the other origin", async () => {
    const r = await cli(["get", "Order;42", "--json"], { SIGNUM_AUTH_HEADER: "Signum_Authorization" });
    expect(r.code).toBe(ExitCode.Transport);
    expect(r.err).toContain(`answered 302, redirecting to http://localhost:${other.port}/api/entity/Order/42`);
    expect(r.err).toContain("the credential was not sent there");
    expect(r.err).not.toContain(TOKEN);
    expect(elsewhere).toEqual([]);
  });

  it("with Authorization too: the address moved is reported, not silently followed", async () => {
    const r = await cli(["get", "Order;42", "--json"], {});
    expect(r.code).toBe(ExitCode.Transport);
    expect(elsewhere).toEqual([]);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
