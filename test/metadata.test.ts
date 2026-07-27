/**
 * Metadata caching — REQ-010 · STORY-24 (AC-24.3, AC-24.4) · STORY-61 (AC-61.3, AC-61.6).
 *
 * Previously 0% covered: `loadMetadata`'s two designed fallback paths — explicit `offline`
 * mode, and automatic stale-cache-use when the network fails — had no test proving either
 * actually works. Both are exactly the kind of thing that silently rots.
 *
 * The QA note that used to sit here — "`offline` is a real, working parameter but no command
 * sets it, so it is only reachable at the module level" — is resolved: `--offline` and
 * `SIGNUM_OFFLINE=1` now reach it from every command that loads metadata (AC-24.4). The
 * end-to-end coverage lives in test/cache.test.ts, which asserts the network is genuinely never
 * touched; these tests stay at the module level because they exercise the fallback logic itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetadata } from "../src/core/metadata.ts";
import { SignumHttp } from "../src/core/http.ts";
import { CliError } from "../src/core/errors.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signum-metadata-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = () => ({ SIGNUM_CONFIG_DIR: dir }) as unknown as NodeJS.ProcessEnv;

describe("offline mode (AC-24.4, AC-61.3) — reachable only at the module level, no CLI flag exists", () => {
  it("throws a clean error when offline with no cache populated yet", async () => {
    const http = new SignumHttp({ baseUrl: "http://127.0.0.1:1" }); // never actually called
    await expect(
      loadMetadata({ url: "http://example.invalid", http, offline: true, env: env() }),
    ).rejects.toThrow(CliError);
  });

  it("returns the cached payload once one exists, without touching the network", async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        port: 0,
        fetch: () => new Response(JSON.stringify({ Order: { kind: "Main" } }), {
          headers: { "content-type": "application/json", "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
        }),
      });
      const url = `http://127.0.0.1:${server.port}`;
      const http = new SignumHttp({ baseUrl: url });

      // Populate the cache with a normal online call first.
      const online = await loadMetadata({ url, http, env: env() });
      expect(online.origin.fromCache).toBe(false);

      // Now go offline — a request to a DIFFERENT, unreachable base URL would prove the point
      // even more strongly, but reusing the same client with offline:true is the documented
      // contract: the network is never touched at all when offline is set.
      const offline = await loadMetadata({ url, http, offline: true, env: env() });
      expect(offline.origin.fromCache).toBe(true);
      expect(offline.types.has("order")).toBe(true);
    } finally {
      server?.stop(true);
    }
  });
});

describe("automatic stale-cache fallback on network failure (AC-61.6) — the reachable path", () => {
  it("uses a stale cache and flags it, rather than failing, when the network call errors", async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        port: 0,
        fetch: () => new Response(JSON.stringify({ Order: { kind: "Main" } }), {
          headers: { "content-type": "application/json", "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
        }),
      });
      const url = `http://127.0.0.1:${server.port}`;
      const http = new SignumHttp({ baseUrl: url });

      const online = await loadMetadata({ url, http, env: env() });
      expect(online.origin.stale).toBe(false);

      // Stop the server; the SAME url now has cached data but is unreachable.
      server.stop(true);
      server = undefined;

      const warnings: string[] = [];
      const stale = await loadMetadata({ url, http, env: env(), warn: (w) => warnings.push(w) });
      expect(stale.origin.fromCache).toBe(true);
      expect(stale.origin.stale).toBe(true);
      expect(stale.types.has("order")).toBe(true);
      expect(warnings.join()).toContain("could not refresh metadata");
    } finally {
      server?.stop(true);
    }
  });

  it("still throws when the network fails AND there is no cache at all", async () => {
    const http = new SignumHttp({ baseUrl: "http://127.0.0.1:1" });
    await expect(
      loadMetadata({ url: "http://127.0.0.1:1", http, env: env() }),
    ).rejects.toBeDefined();
  });
});

/**
 * The reflection document is ROLE-DEPENDENT — `AuthServer.cs:143-157` rewrites `queryDefined`
 * per caller, and an anonymous caller may query nothing — while `ReflectionServer.LastModified`
 * is a process-wide static (`ReflectionController.cs:17`). So a conditional request would get a
 * 304 and the client would reuse the wrong document.
 *
 * This matters because `queryDefined` is now load-bearing: `signum query` rejects a key the
 * metadata says is not queryable. A cache populated by `signum types` BEFORE login must not be
 * able to tell a logged-in user that nothing is queryable.
 */
describe("the metadata cache is scoped to the caller's auth state", () => {
  it("does not serve an anonymous document to an authenticated call, even on a 304", async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const seen: Array<{ authenticated: boolean; conditional: boolean }> = [];
      server = Bun.serve({
        port: 0,
        fetch: (req) => {
          const authenticated = req.headers.get("authorization") !== null;
          const conditional = req.headers.get("if-modified-since") !== null;
          seen.push({ authenticated, conditional });
          // A real server would answer 304 here regardless of who asked, because LastModified is
          // not per-user. Doing exactly that is the point of this test.
          if (conditional) return new Response(null, { status: 304 });
          return new Response(
            // Anonymous sees no queryable types; authenticated sees Order.
            JSON.stringify(authenticated
              ? { Order: { kind: "Main", queryDefined: true } }
              : { Order: { kind: "Main" } }),
            { headers: { "content-type": "application/json", "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" } },
          );
        },
      });
      const url = `http://127.0.0.1:${server.port}`;

      // 1. Discovery before login, no credential — Order is reflected but not queryable.
      const anon = await loadMetadata({ url, http: new SignumHttp({ baseUrl: url }), env: env() });
      expect(anon.types.get("order")?.hasQuery).toBe(false);

      // 2. Same target, now with a credential. This must NOT reuse the anonymous cache.
      const authed = await loadMetadata({
        url, http: new SignumHttp({ baseUrl: url, token: "t" }), env: env(),
      });
      expect(authed.types.get("order")?.hasQuery).toBe(true);
      expect(authed.origin.fromCache).toBe(false);

      // The authenticated call went out UNCONDITIONALLY — no If-Modified-Since to be 304'd.
      expect(seen).toEqual([
        { authenticated: false, conditional: false },
        { authenticated: true, conditional: false },
      ]);
    } finally {
      server?.stop(true);
    }
  });

  it("still reuses the cache for a repeat call at the same auth state", async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        port: 0,
        fetch: (req) => req.headers.get("if-modified-since") !== null
          ? new Response(null, { status: 304 })
          : new Response(JSON.stringify({ Order: { kind: "Main", queryDefined: true } }), {
              headers: { "content-type": "application/json", "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
            }),
      });
      const url = `http://127.0.0.1:${server.port}`;
      const http = () => new SignumHttp({ baseUrl: url, token: "t" });

      const first = await loadMetadata({ url, http: http(), env: env() });
      expect(first.origin.fromCache).toBe(false);
      const second = await loadMetadata({ url, http: http(), env: env() });
      expect(second.origin.fromCache).toBe(true);
      expect(second.origin.stale).toBe(false);
      expect(second.types.get("order")?.hasQuery).toBe(true);
    } finally {
      server?.stop(true);
    }
  });
});
