/**
 * Assisted token capture (AC-12.9, ADR 0008 Option 4): a one-shot loopback listener the browser can
 * hand the token to, so nobody copies a long secret by hand.
 *
 * `auth login` prints a one-line console snippet that POSTs `sessionStorage.getItem("authToken")` to
 * the listener. It runs in any tab on the application's origin where the user is signed in: Signum's
 * `SessionSharing` fills a new tab's `sessionStorage` from an open one (`Services.ts:420-458`).
 *
 * What makes it safe to leave open while the user signs in:
 *   - bound to 127.0.0.1 only, on a port the OS picks;
 *   - the path carries a random nonce, printed only on the user's terminal, so no web page and no
 *     other local user can guess where to send a token of their choosing;
 *   - the request must come from the application's own origin — the snippet run anywhere else is
 *     refused, and so is a request with no Origin at all;
 *   - the first valid token closes it, and the token is never echoed back.
 *
 * Chrome's Private Network Access sends a preflight before an HTTPS page may reach loopback; the
 * listener answers it with `Access-Control-Allow-Private-Network`. A browser that still refuses, or
 * a listener that cannot bind, costs nothing: pasting at the prompt is always offered beside it
 * (AC-12.1), and this is an optimisation that must never become a dependency.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export interface TokenListener {
  /** The browser-console line that sends the token. */
  snippet: string;
  /** Resolves with the first token that arrives the right way. */
  token: Promise<string>;
  close(): void;
}

/** A token is a few KiB; anything far larger is not one. */
const MAX_BODY = 64 * 1024;

/**
 * Start the listener for a target application, or undefined when it cannot bind (the paste path
 * then stands alone).
 */
export function listenForToken(targetUrl: string): TokenListener | undefined {
  let origin: string;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    return undefined;
  }
  const nonce = randomBytes(16).toString("hex");
  let deliver: (token: string) => void = () => {};
  const token = new Promise<string>((resolve) => { deliver = resolve; });

  const cors = (extra: Record<string, string> = {}): Record<string, string> => ({
    "access-control-allow-origin": origin,
    vary: "Origin",
    "cache-control": "no-store",
    ...extra,
  });
  const nonceMatches = (path: string): boolean => {
    const given = Buffer.from(path.replace(/^\//, ""));
    const wanted = Buffer.from(nonce);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (!nonceMatches(path)) return new Response("not found", { status: 404 });
        if (req.headers.get("origin") !== origin) {
          return new Response(`signum accepts the token from ${origin} only`, { status: 403 });
        }
        if (req.method === "OPTIONS") {
          // The preflight Private Network Access sends before an HTTPS page may reach loopback.
          return new Response(null, {
            status: 204,
            headers: cors({
              "access-control-allow-methods": "POST",
              "access-control-allow-headers": "content-type",
              "access-control-allow-private-network": "true",
            }),
          });
        }
        if (req.method !== "POST") return new Response("POST the token", { status: 405, headers: cors() });
        const body = await req.text();
        const value = body.trim();
        if (value === "" || value === "null" || body.length > MAX_BODY) {
          // `sessionStorage.getItem` gives null in a tab that is not signed in.
          return new Response("no token in this tab: sign in first, then run the line again", { status: 400, headers: cors() });
        }
        deliver(value);
        return new Response("signum received the token; return to your terminal", { headers: cors() });
      },
    });
  } catch {
    return undefined;
  }

  const address = `http://127.0.0.1:${server.port}/${nonce}`;
  return {
    snippet: `fetch("${address}",{method:"POST",body:sessionStorage.getItem("authToken")}).then(r=>r.text()).then(console.log)`,
    token,
    close: () => { void server.stop(true); },
  };
}
