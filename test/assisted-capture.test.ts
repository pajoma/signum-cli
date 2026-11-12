/**
 * Assisted token capture — AC-12.9, ADR 0008 Option 4: `auth login` at a terminal also listens on
 * loopback for the token, which a one-line console snippet sends from the signed-in browser.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { CliError, ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { listenForToken } from "../src/core/capture.ts";

const TOKEN = "eyJ-a-long-browser-token-0123456789";

let server: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const headers = { "content-type": "application/json" };
      if (new URL(req.url).pathname === "/api/auth/currentUser" && req.headers.get("authorization") === `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ userName: "anna" }), { headers });
      }
      return new Response(JSON.stringify({ exceptionType: "AuthenticationException", exceptionMessage: "no" }), { status: 403, headers });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-capture-")); });

/** The snippet's address, read off what `auth login` printed. */
const addressIn = (text: string): string => (/fetch\("([^"]+)"/.exec(text) as RegExpExecArray)[1] as string;

/**
 * `auth login` at a terminal whose prompt waits until withdrawn — or answers `paste` after a moment —
 * while `browser` plays the signed-in tab, given the address the CLI printed.
 */
async function login(browser: (address: string) => Promise<void>, paste?: string): Promise<{ code: ExitCode; err: string; withdrawn: boolean }> {
  let err = "";
  let withdrawn = false;
  let printed: (address: string) => void = () => {};
  const shown = new Promise<string>((resolve) => { printed = resolve; });
  const io: Io = {
    out: () => {},
    err: (s) => { err += s; if (s.includes("fetch(\"")) printed(addressIn(s)); },
    stdoutIsTty: true,
    stdinIsTty: true,
    env: { SIGNUM_CONFIG_DIR: dir, SIGNUM_CALLER_CONTEXT: "interactive" } as NodeJS.ProcessEnv,
    readStdin: async () => "",
    prompt: (_q, opts) => new Promise<string>((resolve) => {
      opts?.signal?.addEventListener("abort", () => { withdrawn = true; resolve(""); });
      if (paste !== undefined) setTimeout(() => resolve(paste), 50);
    }),
  };
  const running = run(["auth", "login", "--url", url], io);
  void shown.then(browser);
  try {
    return { code: await running, err, withdrawn };
  } catch (e) {
    err += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    if (e instanceof CliError && e.hint !== undefined) err += e.hint + "\n";
    return { code: exitCodeOf(e), err, withdrawn };
  }
}

const stored = (): string => readFileSync(join(dir, "credential.json"), "utf8");

describe("auth login takes the token from the browser (AC-12.9)", () => {
  it("prints a snippet, takes the token it sends, validates it, and withdraws the prompt", async () => {
    let answer = "";
    const r = await login(async (address) => {
      const res = await fetch(address, { method: "POST", body: TOKEN, headers: { origin: url } });
      answer = await res.text();
    });
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain('sessionStorage.getItem("authToken")');
    expect(r.err).toContain("Received the token from the browser.");
    expect(r.err).not.toContain(TOKEN);
    expect(r.withdrawn).toBe(true);
    expect(answer).toContain("return to your terminal");
    expect(stored()).toContain(TOKEN);
  });

  it("the paste still works beside it, and the listener closes either way", async () => {
    let address = "";
    const r = await login(async (a) => { address = a; }, TOKEN);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.err).toContain(`Received ${TOKEN.length} characters.`);
    expect(stored()).toContain(TOKEN);
    await expect(fetch(address, { method: "POST", body: TOKEN, headers: { origin: url } })).rejects.toThrow();
  });

  it("a token that fails validation fails the login, as a pasted one would (AC-12.3)", async () => {
    const r = await login(async (address) => {
      await fetch(address, { method: "POST", body: "not-the-token", headers: { origin: url } });
    });
    expect(r.code).not.toBe(ExitCode.Ok);
    expect(r.err).toContain("the server rejected this token");
    expect(() => stored()).toThrow(); // nothing was stored
  });
});

describe("the listener takes a token only the right way", () => {
  it("refuses another origin, no origin, a wrong path, and a tab that is not signed in", async () => {
    const listener = listenForToken(url);
    if (listener === undefined) throw new Error("could not bind");
    const address = addressIn(listener.snippet);
    let received: string | undefined;
    void listener.token.then((t) => { received = t; });
    try {
      expect((await fetch(address, { method: "POST", body: TOKEN, headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(address, { method: "POST", body: TOKEN })).status).toBe(403);
      expect((await fetch(address.replace(/[0-9a-f]{4}$/, "0000"), { method: "POST", body: TOKEN, headers: { origin: url } })).status).toBe(404);
      expect((await fetch(address, { method: "POST", body: "null", headers: { origin: url } })).status).toBe(400);
      expect(received).toBeUndefined();
      // Private Network Access: the preflight an HTTPS page sends before it may reach loopback.
      const preflight = await fetch(address, {
        method: "OPTIONS",
        headers: { origin: url, "access-control-request-method": "POST", "access-control-request-private-network": "true" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
      expect(preflight.headers.get("access-control-allow-origin")).toBe(url);
      const ok = await fetch(address, { method: "POST", body: TOKEN, headers: { origin: url } });
      expect(ok.headers.get("access-control-allow-origin")).toBe(url);
      expect(await ok.text()).not.toContain(TOKEN);
      expect(await listener.token).toBe(TOKEN);
    } finally {
      listener.close();
    }
  });

  it("binds loopback only", () => {
    const listener = listenForToken(url);
    expect(listener?.snippet).toMatch(/^fetch\("http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}"/);
    listener?.close();
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
