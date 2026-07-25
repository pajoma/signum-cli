# User Stories — Authentication

Stories for the authentication surface of `signum-cli`. Unlike
[requirements](../requirements.md), stories carry **acceptance criteria**.

Grounded in a source spike of the framework at `74bd24693d` — see
[`../reference/auth-browser-spike.md`](../reference/auth-browser-spike.md) and
[`../reference/auth-lifecycle.md`](../reference/auth-lifecycle.md). Claims that encode framework
behaviour are cited to `file:line`.

**Roles used below:** *developer* (interactive terminal), *operator* (scripted/CI), *agent*
(MCP or direct invocation by Claude Code), *administrator* (provisions access in the target app).

> **Target application uses Entra.** [STORY-10](#story-10--entra-device-code-login) is therefore the
> primary path, not an add-on — see [ADR 0004](../decisions/0004-entra-primary-identity-provider.md).
> The other stories remain required: they cover other deployments, CI, and fallbacks.

---

## What the framework actually accepts

The server accepts exactly **three** credential shapes on an arbitrary request, resolved by a
chain where the first non-null wins — `ApiKey(0) → Token → AnonymousUser → AllowAnonymous →
Invalid(throws)` (`SignumFilters.cs:43-55`, `RestApiKeyServer.cs:19`, `AuthTokensServer.cs:27-30`):

1. `X-ApiKey` header
2. `?apiKey=` query parameter — **never used by this CLI** (see AC-02.2)
3. `Authorization: Bearer <token>`

Every login path — password, API key, OpenID, AzureAD, WindowsAD — returns the **same opaque
bearer token**. That is the load-bearing simplification: **one credential store, one refresh
rule, one redaction rule**, regardless of how the user authenticated.

---

## STORY-01 — Browser login (`gh`-style)

Traces to: REQ-001, REQ-004 · Priority: **v1** · Feasibility: **confirmed possible today**

> **Scope note.** This is the path for deployments using `Signum.Authorization.OpenID`. The
> **target application uses Entra**, whose primary path is [STORY-10](#story-10--entra-device-code-login).
> If the target app fronts Entra via the *OpenID* module rather than the *AzureAD* module, this
> story becomes its path instead — that is [ADR 0004](../decisions/0004-entra-primary-identity-provider.md)
> open question 1.

**As a developer**, I want to run `signum auth login --web`, complete authentication in my normal
browser, and have the CLI end up logged in, so that I never type credentials into a terminal and
my organisation's SSO and MFA still apply.

Enabled by `POST api/auth/loginWithOpenID`, which is `[SignumAllowAnonymous]`
(`OpenIDAuthenticationController.cs:12`) and accepts `{Code, RedirectUri}`. Signum performs **no
validation of the redirect URI** — there is no such field on `OpenIDConfigurationEmbedded` — and
forwards it verbatim to the IdP token endpoint (`OpenIDAuthenticationServer.cs:96`). So a loopback
URI is accepted unconditionally; only the IdP gates it.

**Acceptance Criteria:**
- AC-01.1: The CLI binds a listener on `http://127.0.0.1:<ephemeral-port>/callback`, opens the system browser at the IdP authorization endpoint, and captures the `code` parameter.
- AC-01.2: The authorization endpoint is discovered at runtime via `GET api/auth/openIDEndpoints`; it is never hardcoded.
- AC-01.3: A `state` parameter is generated, and the callback is rejected unless it matches. The **server never checks `state`**, so this is solely the client's responsibility.
- AC-01.4: The CLI exchanges the code via `POST api/auth/loginWithOpenID {code, redirectUri}` and persists the returned bearer token per STORY-04.
- AC-01.5: The CLI never possesses or requests the OAuth `client_secret` — the server holds it, making the CLI indistinguishable from the SPA.
- AC-01.6: `client_id` and scopes are configurable via `--client-id`/`--scope`, because **no API exposes them today** (they reach the browser only via page HTML). If the 2-line upstream change lands, they are discovered automatically and the flags become optional overrides.
- AC-01.7: If the IdP requires PKCE the flow fails with an explicit, named error — **PKCE is not implemented server-side** (zero repo-wide hits for `code_verifier`/`code_challenge`), so this cannot be worked around client-side.
- AC-01.8: Binding the loopback listener, browser launch failure, and callback timeout each produce a distinct actionable error, and the CLI always offers the `--api-key` / password fallback in that message.
- AC-01.9: The authorization URL is printed so a user on a headless machine can complete it elsewhere and paste the code back.

> **Open [TEST]:** unverified against a live IdP. Two things can only be settled empirically —
> whether the deployment's IdP client permits a loopback redirect URI, and whether it enforces
> PKCE. Both are per-deployment.

---

## STORY-02 — API key login (headless, CI)

Traces to: REQ-002, REQ-006 · Priority: **v1**

**As an operator**, I want to authenticate with a long-lived API key supplied via an environment
variable, so that scheduled jobs and CI pipelines run with no interactive step.

**Acceptance Criteria:**
- AC-02.1: The key is read from `SIGNUM_API_KEY` (preferred) or a stored profile, and sent **only** as the `X-ApiKey` header.
- AC-02.2: The CLI **never** places the key in a URL. `RestLogFilter.cs:36-38` persists query strings into `RestLogEntity.QueryString`, and the global exception filter persists the full URL on any throw — a key in a URL is written to the customer's database in plaintext. This holds even though the server supports `?apiKey=`.
- AC-02.3: On startup the CLI immediately trades the key for a rotating bearer token via `GET api/auth/loginFromApiKey`, so the long-lived secret appears on exactly one request per invocation.
- AC-02.4: An **unknown** API key produces HTTP 500 with a `KeyNotFoundException` **whose message echoes the key**. The CLI must map this to a clean "invalid API key" error and must **never** print or log the response body verbatim, or it leaks the credential into the terminal and CI logs.
- AC-02.5: Sending both an API key and a bearer token is prevented client-side; the key would silently win (chain index 0) and mask a token problem.
- AC-02.6: If the target app lacks `Signum.Rest`, the failure is reported as "API keys not available on this server" with a pointer to the password and `--web` paths — not as a generic 403.

> **Administrator note, surfaced in `--help`:** an API key resolves to the **full user identity**
> with all that user's permissions. It has **no expiry, rotation, revocation, or scoping**, is
> stored in plaintext server-side, and — critically — **deactivating the user does not revoke the
> key** (`ApiKeyAuthenticator` never checks `State`). Provisioning is governed only by ordinary
> type/operation auth on `RestApiKeyEntity`, with **no dedicated permission**. Treat these keys as
> high-value, long-lived secrets.

---

## STORY-03 — Username and password login

Traces to: REQ-003 · Priority: **v1**

**As a developer** working against an app with no `Signum.Rest` and no OpenID, I want to log in
with my username and password, so that the CLI works against every Signum application.

**Acceptance Criteria:**
- AC-03.1: `signum auth login` prompts for the password without echo when stdin is a TTY, and never accepts it as a command-line argument (shell history, process list).
- AC-03.2: Non-interactively the password comes from an environment variable or stdin; if neither is present and there is no TTY, the CLI **fails** rather than hanging on a prompt.
- AC-03.3: `POST api/auth/login {userName, password, rememberMe:false}` → token persisted per STORY-04. A 400 response surfaces the server's `ModelState` messages.
- AC-03.4: **A failed login is never automatically retried.** The server deactivates accounts after `MaxFailedLoginAttempts`, so a retry loop can lock the user out. Retry requires a new explicit invocation.
- AC-03.5: The password is never written to disk, logs, or trace output — only the resulting token is persisted.
- AC-03.6: On a WindowsAD-backed app this same endpoint performs a domain LDAP bind (`WindowsADAuthorizer.cs:33-91`); no separate command is needed, and no client change is required.

> **Upstream hazard, documented for the user:** the framework's global exception filter persists
> the **entire request body** on any throw. A login that raises server-side can therefore persist
> the password in cleartext in the application's log tables. This is a framework issue, not a CLI
> one, but it is a reason to prefer STORY-01 or STORY-02 where available, and it belongs in the
> `auth login` help text.

---

## STORY-04 — Stay logged in between invocations

Traces to: REQ-001, REQ-003, REQ-006 · Priority: **v1**

**As a developer**, I want each invocation to reuse my existing session, so that a CLI that runs
as a fresh process every time does not make me re-authenticate constantly.

The token is JSON → DEFLATE → **AES-128-CBC/PKCS7 with the key derived as MD5 of the app secret,
IV prepended, no MAC**. It is opaque and unauthenticated. Treat it strictly as a bearer blob.

**Acceptance Criteria:**
- AC-04.1: The token is persisted per profile with owner-only permissions (`0600`), or in an OS keychain where available.
- AC-04.2: The CLI **never parses the token**. It contains no readable expiry, and there is no integrity check to rely on.
- AC-04.3: **Tokens never expire.** `RefreshTokenEvery` (default 30 min) is a *rotation* interval: past it the server revalidates against the database and returns a replacement in the **`New_Token` response header** (`AuthTokensServer.cs:85-94`).
- AC-04.4: Every response is inspected for `New_Token`; when present the stored token is replaced **atomically**, so concurrent invocations cannot corrupt the store.
- AC-04.5: Ignoring `New_Token` does **not** break authentication — but it costs a database hit on every request and **freezes the user's role permanently**, because `RoleEntity.Current` reads the role from the token claim (`RoleEntity.cs:33`). A role change only takes effect after a rotation.
- AC-04.6: After loading a stored token the CLI verifies it with `GET api/auth/currentUser` before relying on it. Malformed, tampered, or wrong-key tokens are **swallowed server-side and degrade silently to anonymous** rather than producing a distinct error.
- AC-04.7: The header name is configurable and is `Signum_Authorization` on Windows-auth apps (`AuthTokensServer.cs:57-62`); the CLI supports overriding it per profile.
- AC-04.8: Rotation is triggerable on demand (`?refreshToken`) so a user can pick up a role change without re-authenticating.

---

## STORY-05 — Multiple environments

Traces to: REQ-001 · Priority: **v1**

**As an operator** responsible for dev, test and production instances, I want named profiles, so
that I can target the right app deliberately and never fire a write at production by accident.

**Acceptance Criteria:**
- AC-05.1: Named profiles each store a base URL, auth mechanism, credential reference, and optional header-name override.
- AC-05.2: Resolution order is `--url`/`--profile` flag → environment variable → configured default profile → explicit error. Never a silent fallback.
- AC-05.3: The CLI runs with **no config file present**, fully driven by flags and environment variables.
- AC-05.4: `signum auth status` lists every profile, marks the active one, and shows each one's auth state without exposing secrets.
- AC-05.5: A profile can be marked *protected*; mutating commands against it require `--yes` even when stdout is not a TTY.
- AC-05.6: The active profile and target URL appear in the confirmation prompt for every write.

---

## STORY-06 — Know who I am

Traces to: REQ-007 · Priority: **v1**

**As a developer** whose command just failed, I want one command that tells me whether I am
authenticated, as whom, against what, so that I can tell a credential problem from a permission
problem or a wrong target.

**Acceptance Criteria:**
- AC-06.1: `signum auth status` reports reachability, resolved URL, auth mechanism, authenticated user, and role.
- AC-06.2: It distinguishes *not configured*, *configured but credential rejected*, *authenticated as anonymous*, and *authenticated as a user*. The third case is real and silent — see AC-04.6.
- AC-06.3: It never prints a token or key, not even truncated.
- AC-06.4: Exit code is non-zero when not usefully authenticated, so scripts can gate on it.
- AC-06.5: `--json` emits a stable machine-readable shape for agents.

---

## STORY-07 — Log out

Traces to: REQ-001, REQ-006 · Priority: **v1**

**As a developer** on a shared machine, I want `signum auth logout` to remove my stored
credentials, so that I do not leave a usable session behind.

**Acceptance Criteria:**
- AC-07.1: Locally stored token and key material for the profile are deleted.
- AC-07.2: The CLI states plainly that this is **local only**. `POST api/auth/logout` clears a cookie and performs **no token revocation** — an already-issued bearer token remains valid server-side.
- AC-07.3: `--all` clears every profile.
- AC-07.4: For a leaked key, help text directs the administrator to delete the `RestApiKeyEntity` — the only actual revocation mechanism.

---

## STORY-08 — Understand a denial

Traces to: REQ-052, REQ-007 · Priority: **v1**

**As an agent or operator**, I want authentication and authorization failures clearly
distinguished, so that I retry when retrying can help and stop when it cannot.

**Acceptance Criteria:**
- AC-08.1: The CLI **never** branches on 401 — it is never returned. Both auth and authz failures are 403 (`SignumExceptionFilterAttribute.cs:131-146`).
- AC-08.2: 403s are discriminated on `exceptionType`: `…AuthenticationException` → credential problem, re-authentication may help; `…UnauthorizedAccessException` → permission problem, do not retry.
- AC-08.3: The two map to **different exit codes** (REQ-051).
- AC-08.4: A permission denial names the missing capability where the server provides it.
- AC-08.5: `canExecute` is treated as a **positive capability list only** — forbidden operations *vanish* from it with no reason given (`OperationLogic.cs:456`), so absence must never be reported as "operation does not exist".
- AC-08.6: An unauthorized *query* throws 403, whereas unauthorized *rows* are silently filtered. The CLI must not describe a filtered result as complete.

---

## STORY-09 — Non-interactive by construction

Traces to: REQ-050, REQ-054, REQ-074 · Priority: **v1**

**As a CI pipeline or agent**, I want authentication to work with no TTY, no browser and no
prompt, so that I never hang waiting for input that cannot arrive.

**Acceptance Criteria:**
- AC-09.1: With no TTY, the CLI **never** prompts — it fails with a message naming the environment variable that would have satisfied it.
- AC-09.2: Every credential can be supplied by environment variable.
- AC-09.3: No auth path requires a browser unless `--web` is passed explicitly.
- AC-09.4: Auth failures are reported on stderr in a stable form; stdout stays reserved for data.
- AC-09.5: A missing or malformed credential is a usage-class failure, distinct from a rejected one.

---

## STORY-10 — Entra device code login

Traces to: REQ-005 · Priority: **v1 — this is the primary path for the target application**

**As a developer or operator** at an organisation on Entra, I want to authenticate with a device
code, so that I log in with corporate SSO and MFA from any machine — including headless and remote
ones — without a browser on that machine and without ever handling a password.

Feasible because `POST api/auth/loginWithAzureAD` is `[SignumAllowAnonymous]` and accepts a **raw
`idToken`**, validating it against the tenant's JWKS with `ValidAudience = config.ApplicationID`
and, for workforce Entra, `ValidIssuer = https://login.microsoftonline.com/{DirectoryID}/v2.0`
(`AzureAuthenticationServer.cs:81-106`). A genuine token exchange: the CLI acquires a token by any
means and hands it over.

Per [ADR 0004](../decisions/0004-entra-primary-identity-provider.md), the device code grant is
**hand-rolled over plain HTTP — no MSAL** — so Entra support costs nothing in binary size or
NativeAOT risk.

**Acceptance Criteria:**
- AC-10.1: The CLI performs the OAuth 2.0 device authorization grant directly against Entra: `POST /oauth2/v2.0/devicecode`, then polls `POST /oauth2/v2.0/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- AC-10.2: The user code and verification URL are printed prominently; the CLI polls at the server-supplied `interval` and honours `slow_down` by increasing it.
- AC-10.3: `authorization_pending`, `slow_down`, `expired_token`, and `authorization_declined` are each handled distinctly — `expired_token` and `authorization_declined` terminate rather than loop.
- AC-10.4: The resulting `idToken` is posted to `api/auth/loginWithAzureAD`, and the returned Signum bearer token is persisted per STORY-04. Every Entra login funnels into the same credential store as every other path.
- AC-10.5: No MSAL or other identity SDK is taken as a dependency. The implementation is `HttpClient` + `JsonNode` only, so it stays AOT-clean (REQ-071).
- AC-10.6: Tenant id, client id, scopes, and `AzureADType` are configurable per profile. **None of it is discoverable** — the framework ships no device-code client and exposes these values only to the browser.
- AC-10.7: The issuer is derived from `AzureADType` (`AzureAD` | `B2C` | `ExternalID` — `AzureADConfigurationEmbedded.cs:132-139`). `login.microsoftonline.com` is **never hardcoded**; B2C and Entra External ID have different authorities.
- AC-10.8: An `aud` or `iss` rejection is reported as a **configuration mismatch naming the failing claim and the expected value**, never as a generic auth failure. This is the single most likely first-run failure — see the audience note below.
- AC-10.9: `accessToken` is sent alongside `idToken`, since it feeds the Graph-backed user context (`AzureClaimsAutoCreateUserContext`). If auto-user-creation needs a Graph scope, that scope is configurable. **[TEST]**
- AC-10.10: If the tenant blocks the device code grant by Conditional Access, the error names that as the likely cause and points at the `--web` and API-key alternatives.
- AC-10.11: The device code and the resulting tokens are never written to logs or trace output (STORY-11).

> **The audience trap.** Signum validates `aud == ApplicationID` — the *web app's* registration —
> and an `id_token`'s `aud` is whichever client requested it. So a CLI with its own registration
> gets a token Signum rejects, unless the target app opts in via
> `AzureAuthenticationServer.ExtraValidAudiences` (`:78,93`), a static hook that exists for exactly
> this and needs **no framework change**. ADR 0004 lays out the three options; **which one applies
> is still open** and is a tenant-configuration question. Until it is answered, AC-10.8 is what
> makes the failure diagnosable instead of baffling.

---

## STORY-11 — Credentials never leak

Traces to: REQ-006, REQ-053, REQ-074 · Priority: **v1**

**As an administrator**, I want confidence that the CLI cannot leak a credential, so that I can
approve its use against production.

**Acceptance Criteria:**
- AC-11.1: Secrets never appear in stdout, stderr, `--explain` output, `-v`/`--trace` output, or crash output. Redaction is **unit-tested**, not merely intended.
- AC-11.2: `--explain` and `--trace` show `X-ApiKey: <redacted>` and `Authorization: Bearer <redacted>`.
- AC-11.3: No secret is ever placed in a URL, for any reason (AC-02.2).
- AC-11.4: Server responses are **never** echoed verbatim, because at least one error path returns the submitted API key in its message (AC-02.4).
- AC-11.5: Credential files are created `0600`; a wrong-permissions file is a warning.
- AC-11.6: Passwords are never accepted as command-line arguments.
- AC-11.7: A redaction test runs in CI and fails the build on regression.

---

## Traceability

| Story | Requirements | Priority |
|---|---|---|
| STORY-01 Browser login | REQ-001, REQ-004 | v1 |
| STORY-02 API key login | REQ-002, REQ-006 | v1 |
| STORY-03 Password login | REQ-003 | v1 |
| STORY-04 Session persistence | REQ-001, REQ-003, REQ-006 | v1 |
| STORY-05 Multiple environments | REQ-001 | v1 |
| STORY-06 Identity check | REQ-007 | v1 |
| STORY-07 Log out | REQ-001, REQ-006 | v1 |
| STORY-08 Understand a denial | REQ-007, REQ-052 | v1 |
| STORY-09 Non-interactive | REQ-050, REQ-054, REQ-074 | v1 |
| STORY-10 Entra device code | REQ-005 | **v1** — primary path for the target app |
| STORY-11 No credential leakage | REQ-006, REQ-053, REQ-074 | v1 |

## Deliberately not covered

- **WindowsAD integrated auth (Negotiate/Kerberos).** Hard-requires a `WindowsPrincipal`
  (`WindowsADServer.cs:28-30`) and is Windows-server only. The LDAP bind path in AC-03.6 covers
  the realistic need; SPNEGO is not worth the investment.
- **`loginFromCookie` / `UserTicket`.** A browser `sfUser` cookie mechanism, not meaningful for a
  CLI.
- **Password reset and change.** `forgotPasswordEmail`, `resetPassword`, `requestNewLink`,
  `ChangePassword` exist, but account management is the web UI's job.
