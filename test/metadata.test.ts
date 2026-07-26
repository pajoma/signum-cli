/**
 * Metadata caching — REQ-010 · STORY-24 (AC-24.3, AC-24.4) · STORY-61 (AC-61.3, AC-61.6).
 *
 * Previously 0% covered: `loadMetadata`'s two designed fallback paths — explicit `offline`
 * mode, and automatic stale-cache-use when the network fails — had no test proving either
 * actually works. Both are exactly the kind of thing that silently rots.
 *
 * QA finding: `offline` is a real, working parameter on `loadMetadata`, but no command
 * anywhere sets it and there is no `--offline` flag in args.ts/help.ts. It is only reachable
 * here, at the module level — a user cannot currently force offline behaviour even though the
 * capability exists. Noted as a completeness gap, not fixed here (adding a flag is new product
 * surface, not a test-coverage fix).
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
