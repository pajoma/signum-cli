# ADR 0008 — Browser-driven token capture

**Status:** PROPOSED — one probe outstanding, see *Open question* below
**Date:** 2026-07-28
**Owner question:** *"When I run `gh auth login`, a browser window opens with the login mask and the
CLI gets the token. Is it possible from the CLI to open a browser and grep the token from there?"*

**Prompted by:** the owner testing the m1 auth flow and reporting it "far from usable".

## Short answer

**Yes — and on this application it is the only way to get a `gh`-like experience.**

Both mechanisms that would do this *properly* (OAuth loopback, Entra device code) are blocked on
changes made by someone who is not us. Driving a browser over the Chrome DevTools Protocol and
reading the token out of `sessionStorage` needs **nothing from the server and nothing from the
tenant**.

That reframes the usability complaint. The current paste-a-token-from-devtools flow is not an
implementation shortcut — it is what [ADR 0004](0004-entra-primary-identity-provider.md) was left
with once every better mechanism turned out to be blocked. What ADR 0004 did not consider is that
**the browser can be driven rather than asked.**

## Context

ADR 0004 ranked six mechanisms and concluded the browser token handoff (STORY-12) is the *sole*
reachable path, so "the work must go into making that one flow genuinely good — low-friction
capture". That work was specified (AC-12.9, assisted capture) and then **not built**: m1 shipped only
the manual stdin paste (AC-12.1). The result is the flow the owner just tested.

New evidence, 2026-07-28: `GET api/auth/openIDEndpoints` on the target application returns **404**,
not 500. A 500 would mean "OpenID is installed but not configured"; a 404 means the controller is not
registered at all, i.e. **`Signum.Authorization.OpenID` is not installed**. ADR 0004 already listed
OpenID loopback as "blocked on tenant **and** module" — this is the first empirical confirmation of
the module half, and it matters because the module is the *earlier and harder* blocker. Installing a
module in someone else's production application is a bigger ask than registering a redirect URI.

## Options

### Option 1 — OAuth loopback, the true `gh` flow ❌ dead on this app

Everything the *framework* needs is in place, and all of it is source-verified:

| Fact | Source |
|---|---|
| `api/auth/loginWithOpenID` is `[SignumAllowAnonymous]`, takes `{Code, RedirectUri}` | `OpenIDAuthenticationController.cs:12,46-49` |
| `api/auth/openIDEndpoints` is anonymous and returns the IdP `AuthorizationEndpoint` **from its discovery document** — runtime discovery, nothing hardcoded | `OpenIDAuthenticationController.cs:23-36` |
| The server forwards `redirect_uri` **verbatim** and supplies `client_id` **and** `client_secret` itself — the CLI never handles a secret | `OpenIDAuthenticationServer.cs:92-99` |
| PKCE is unimplemented server-side — **but irrelevant**: sending a `client_secret` makes this a *confidential* client, which Entra does not force PKCE on | zero repo-wide hits for `code_verifier`/`code_challenge` |

Blocked on, in order of how immovable each is:

1. **The module is not installed** (404, observed). Someone must install and configure
   `Signum.Authorization.OpenID` in the target application.
2. **Entra must register `http://127.0.0.1:<port>/callback`** as a redirect URI on that app
   registration.
3. `client_id` is not exposed by any API — the endpoints response carries only
   `AuthorizationEndpoint` and `EndSessionEndpoint` — so it must be configured client-side. Annoying,
   not blocking.

### Option 2 — Entra device code ❌ blocked

`api/auth/loginWithAzureAD` accepts a raw `idToken`, so a hand-rolled device-code grant could hand one
over. But validation is `ValidAudience = config.ApplicationID` — the *web app's* registration — and
the only way to widen it is `ExtraValidAudiences`, a `static Func<IEnumerable<string>>?` that only a
**code change in the target application** can populate
(`AzureAuthenticationServer.cs:78,92-94`). Unchanged from ADR 0004 Decision 2, which remains OPEN.

### Option 3 — CDP-driven browser ✅ **proposed**

The token lives in **exactly one place**: `sessionStorage.authToken`
(`AuthClient.tsx:189,198`). Not `localStorage`, not a cookie.

Flow:

1. CLI launches Chrome or Edge with `--user-data-dir=<temp> --remote-debugging-port=0`.
2. Reads `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version`.
3. Navigates to the application. **The user logs in normally** — a real browser doing a real flow, so
   SSO, MFA and Conditional Access are satisfied by construction, exactly as in the manual handoff.
4. CLI polls `Runtime.evaluate("sessionStorage.getItem('authToken')")` until it is non-empty.
5. Validates it via `api/auth/currentUser` (AC-12.3), stores it (AC-04.1), kills the browser and
   deletes the temp profile.

**No new dependency.** CDP is HTTP plus a WebSocket, both native to Bun — REQ-070/071 intact.

### Option 4 — assisted capture, as already specified in AC-12.9 ⚠️ keep as fallback

A loopback listener plus a one-line console snippet that POSTs the token to it. Lower risk than
Option 3 and already specified, but it keeps the devtools step — which is the specific part the owner
called unusable.

Two findings improve it over what AC-12.9 assumes:

- **`SessionSharing` broadcasts the whole `sessionStorage`, `authToken` included, through
  `localStorage`** (`Services.ts:420-458`): a tab with empty `sessionStorage` pings
  `requestSessionStorage<app>`, any existing tab replies with `JSON.stringify(sessionStorage)`, and
  the new tab fills itself. So the snippet does **not** have to run in the logged-in tab — any new tab
  on that origin self-populates.
- AC-12.9's `[TEST]` worry about Private Network Access preflight is **solvable**: we control the
  listener, so it can answer with `Access-Control-Allow-Private-Network`.

### Option 5 — read the browser profile off disk ❌ rejected

Two independent reasons, either sufficient.

**It does not work.** `sessionStorage` is not durably readable: Chrome keeps Session Storage in a
LevelDB that is locked while the browser runs and is ephemeral by design. The `SessionSharing`
broadcast above is `setItem` immediately followed by `removeItem`, so it never lands on disk either.

**It is credential theft.** Reading secrets out of another process's private storage is the technique,
not an approximation of it. Rejected on principle, independent of feasibility.

## Decision (proposed)

**Implement Option 3.** Keep Option 4 as the fallback when no supported browser is present. Keep
Options 1 and 2 fully specified — they cover other Signum deployments (REQ-075) and become reachable
here if the access situation changes.

**AC-12.1's manual stdin paste remains mandatory and always available.** Every automated capture path
is an optimisation over it and must never become a dependency — the same rule AC-12.9 already states,
and it is what keeps a headless server or an unsupported browser working.

## Risks, stated plainly

| Risk | Assessment |
|---|---|
| **Conditional Access rejects a fresh browser profile** as an unmanaged or non-compliant device | **The most likely thing to sink this.** Unknowable without trying against the real tenant. If it fires, Option 4 is the fallback and this ADR reverts to REJECTED. |
| **Cannot reuse the user's existing logged-in session.** Chrome 136+ refuses `--remote-debugging-port` on the default profile, specifically to stop cookie-theft malware | Believed accurate; **not verified** — no browser on the dev machine. Consequence: a full interactive login each time, same as `gh`. Acceptable, but confirm before building. |
| **Firefox is out initially** — CDP was removed around Firefox 129 in favour of WebDriver BiDi | Chrome and Edge first; BiDi later if needed. The owner tested in Firefox, so say so in the error message rather than failing obscurely. |
| **This is the shape of credential-stealing tooling** | Mitigations are not optional: explicitly user-initiated, temp profile deleted after use, token never logged or traced (REQ-074), and the browser window visible — never headless. A headless variant would be indistinguishable from malware and must not be built. |

## Open question — resolve before this becomes ACCEPTED

The 404 was observed in a browser against one URL. One command distinguishes "module absent" from
"wrong base URL", using an anonymous endpoint that certainly exists:

```
curl -s -o /dev/null -w '%{http_code}\n' https://<app>/api/reflection/types
curl -s -o /dev/null -w '%{http_code}\n' https://<app>/api/auth/openIDEndpoints
```

`200` then `404` confirms the module is absent and this ADR stands. If **both** 404, the base URL or
path prefix is wrong, Option 1 is not dead, and Option 1 beats Option 3 — it is a standard flow with
no malware-shaped edges — so this decision would change.

## Consequences

- A new requirement is needed for browser-driven capture; REQ-008 covers the *handoff*, not the
  *automation*. It should carry the security constraints above as acceptance criteria, not prose.
- STORY-12 gains the automated-capture criteria; AC-12.9 should be re-scoped to Option 4 as the
  explicit fallback rather than the primary optimisation.
- ADR 0004's ranking table gains the empirical 404 against the OpenID row.
- REQ-004 and STORY-01 currently lead with the Entra redirect-URI blocker; the module blocker comes
  first and is harder. Corrected alongside this ADR.
