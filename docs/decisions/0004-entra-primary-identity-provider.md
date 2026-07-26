# ADR 0004 — Entra as the primary identity provider

**Status:** ACCEPTED — see *Decision 3*, added after the constraint below.
**Date:** 2026-07-25
**Owner input:** the target application uses **Entra**. Testing happens later.
**Owner constraint (2026-07-25):** *"I don't have control over the Signum config."*
**Target app profile:** [`docs/target-application.md`](../target-application.md)

> ### The constraint changes the answer
>
> No server-side change is available — which **eliminates Option B**, the otherwise-recommended
> `ExtraValidAudiences` approach, since it needs a line in the app's startup. Options A and C
> both need changes to the **Entra app registration**, which may or may not be reachable
> depending on who administers the tenant.
>
> So the CLI must have a path that requires **nothing** on the server and **nothing** in Entra.
> There is one, and it becomes the primary bootstrap: **Decision 3**.

Supersedes the priority ordering in [ADR 0002](0002-mcp-vs-http.md)'s neighbourhood and promotes
[STORY-10](../stories/auth.md) from v2 to v1.

## Context

Entra being the target reorders the auth work. Previously the ranking was API key → password →
browser → Entra-as-a-bonus. Now Entra is the path real users will take, and the others become
fallbacks for other deployments.

Signum offers **two** ways to sit behind Entra, and which one the target app uses changes the CLI
design:

| Module | Endpoint | Server's OAuth role |
|---|---|---|
| `Signum.Authorization.AzureAD` | `POST api/auth/loginWithAzureAD` — takes a **raw `idToken`** | validator only; the *client* is whoever obtained the token |
| `Signum.Authorization.OpenID` | `POST api/auth/loginWithOpenID` — takes `{Code, RedirectUri}` | **confidential client**; holds `client_secret`, exchanges the code itself |

The `AzureAD` module is the better fit for a CLI, because it is a genuine **token exchange**: the
CLI acquires a token by any means it likes and hands it over. Verified at
`AzureAuthenticationServer.cs:81-106` — the token is validated against the tenant's JWKS with:

```csharp
var issuer = config.Type == AzureADType.AzureAD ? $"https://login.microsoftonline.com/{config!.DirectoryID}/v2.0" : c.Issuer;

TokenValidationParameters validationParameters = new TokenValidationParameters
{
    ValidAudience = config!.ApplicationID.ToString(),
    ValidAudiences = ExtraValidAudiences?.Invoke(),
    ValidIssuer = issuer,
    ValidateAudience = true,
    ValidateIssuer = true,
```

Request DTO (`AzureADAuthenticationController.cs:61-65`):

```csharp
public class LoginWithAzureADRequest
{
    public string idToken;
    public string accessToken;
}
```

`AzureADType` is `AzureAD | B2C | ExternalID` (`AzureADConfigurationEmbedded.cs:132-139`) —
workforce Entra, Azure AD B2C, and Entra External ID each have a different issuer and discovery
endpoint, so the CLI must not hardcode `login.microsoftonline.com`.

## Decision 1 — hand-roll the device code flow; do not take MSAL

**Accepted.**

The OAuth 2.0 device authorization grant against Entra is two plain HTTP calls: `POST
/oauth2/v2.0/devicecode`, then poll `POST /oauth2/v2.0/token` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code`, handling `authorization_pending`,
`slow_down`, `expired_token`, and `authorization_declined`. Roughly a hundred lines of
`HttpClient` and `JsonNode`.

Why not `Microsoft.Identity.Client` (MSAL.NET):

- It is a heavyweight dependency whose NativeAOT/trim-compatibility we **cannot verify from here**
  (no SDK, no network) and which is not, to our knowledge, officially AOT-supported. Taking it
  would put REQ-071 and [ADR 0003](0003-self-contained-distribution.md) at risk on the strength of
  an assumption.
- Hand-rolling makes the question moot. The saving MSAL offers — token cache, broker integration,
  interactive flows — is small when we only need one grant type and already have our own
  credential store (STORY-04).

This also means Entra support costs the binary nothing in size or dependency risk. **Still valid under [ADR 0005](0005-rust-implementation.md)** — MSAL was never an option in Rust either, and the grant remains two HTTP calls plus polling, now `ureq` + `serde_json` rather than `HttpClient` + `JsonNode`.

> Reversal trigger: if we later need interactive/broker/WAM flows or certificate-based client
> auth, re-evaluate. A `--web` loopback flow (STORY-01) is likewise plain HTTP and needs no MSAL.

## Decision 2 — audience strategy: **OPEN**

This is the blocker, and it is a tenant-configuration question, not a coding one.

Signum validates `aud == ApplicationID`, the web app's own registration. An `id_token`'s `aud` is
**the client that requested it**. So the CLI cannot simply register itself and hand over its own
token — the audience would not match. Three ways out:

### Option A — CLI reuses the web app's `client_id` as a public client

- **Needs:** *Allow public client flows* enabled on the existing web app registration.
- **App code change:** none.
- **Against:** makes one registration both a confidential web client and a public device-code
  client. Broadly discouraged, and it widens what that registration can do.

### Option B — dedicated CLI registration + `ExtraValidAudiences` — *recommended*

- **Needs:** a new public-client app registration for the CLI, and the target app setting
  `AzureAuthenticationServer.ExtraValidAudiences` to include its client id.
- **App code change:** one line in startup. **No framework change** — this static hook exists
  precisely for this (`AzureAuthenticationServer.cs:78,93`).
- **For:** clean separation. The CLI can be revoked, scoped, and audited independently of the web
  app; consent is requested separately; the web registration stays confidential-only.

### Option C — CLI requests an access token for the app's exposed API

- **Needs:** the web app registration to expose an API scope (e.g.
  `api://{ApplicationID}/user_impersonation`); the CLI requests that scope, so `aud` becomes
  `ApplicationID` naturally.
- **For:** the most orthodox OAuth shape — CLI is a client, the Signum app is a resource.
- **Against:** the token obtained is an **access** token, and Signum reads the `idToken` field.
  Whether passing it there validates cleanly is **untested** and depends on Entra's token format
  for that resource. Do not adopt without testing.

**Option B is unavailable** — it needs a line in the app's startup, and we have no control over the
Signum configuration. **Option A or C** require Entra app-registration changes; both remain
possible *only* if the tenant administrator will make them. Neither can be assumed.

## Decision 3 — bootstrap by browser token handoff; upgrade to an API key

**Accepted.** This is the path that requires nothing from anyone.

The browser client keeps the Signum bearer token in `sessionStorage` under the literal key
`authToken` (`Extensions/Signum.Authorization/AuthClient.tsx:189,198`). A user who can log into the
web app — by any means, including full Entra SSO with MFA and Conditional Access — already holds a
valid token. They can hand it to the CLI.

```
signum auth login --with-token        # reads the token from stdin
```

Why this works where everything else stalls:

- **Zero server change.** No `ExtraValidAudiences`, no module requirement, no new endpoint.
- **Zero Entra change.** No app registration, no public-client flag, no redirect URI, no consent.
  Entra never sees the CLI at all — the *browser* did the authentication.
- **Conditional Access and MFA are satisfied**, because a real interactive browser sign-in
  performed them.
- **It is the same opaque token** every other path yields, so STORY-04's storage and `New_Token`
  rotation apply unchanged. Tokens never expire, so a handed-over token keeps working and keeps
  rotating.

Then **upgrade automatically**: once authenticated, the CLI calls `GET api/restApiKey/current`,
which runs in `ExecutionMode.Global()` with no permission check beyond authentication and returns
the caller's own key (`RestApiKeyController.cs:15-20`). If the user already has an API key, the CLI
stores that instead — a durable credential that needs no browser round-trip ever again.

Limits, honestly stated:

- `api/restApiKey/current` returns an **existing** key or `null`; it does not create one.
  `api/restApiKey/generate` only returns a random string and **does not persist it**
  (`RestApiKeyController.cs:8-12`), so minting a key still requires write permission on
  `RestApiKeyEntity` via `RestApiKeyOperation.Save` — role configuration, not code. The CLI can
  offer to try, and report clearly when the user's role does not allow it.
- Both endpoints require `Signum.Rest` to be installed. If it is absent, the handed-over token
  remains the credential, and re-handoff is needed if it is ever lost.
- Copying a token out of devtools is inelegant, and it is a **bearer credential in the clipboard**.
  The CLI must read it from stdin rather than an argument (shell history), and STORY-11's redaction
  rules apply.

## Decision 4 — token handoff is the *only* viable mechanism

**Owner constraint (2026-07-25):** *"no Signum Rest."*

That removes API keys entirely — no `X-ApiKey`, and `api/restApiKey/current` / `generate` are absent,
so the auto-upgrade in Decision 3 becomes a no-op against this app. It also makes
`api/auth/loginFromApiKey` useless: without `Signum.Rest` the API-key authenticator is never
inserted into the chain, so that endpoint has nothing to authenticate with.

Investigating whether username/password survives as a fallback closed that door too:

- `AzureADAuthorizer.Login()` delegates straight to `AuthLogic.Login(userName, password, …)` — it is
  the **ordinary local password check**, not a resource-owner grant against Entra
  (`AzureADAuthorizer.cs:15-18`). Signum never validates a password against Entra.
- Users auto-created from Entra get **`PasswordHash = null`** (`AzureADAuthorizer.cs:43`).
- `AuthLogic.RetrieveUser` throws `IncorrectPasswordException` when `user.PasswordHash == null`
  (`AuthLogic.cs:434,453`).

So an Entra-provisioned user **cannot** authenticate with a password, ever. Worse, attempting it is
actively harmful: failures count toward `MaxFailedLoginAttempts` and can **deactivate the account**.
The CLI must therefore never try password login as an automatic fallback.

### Final ranking for the target application

| Rank | Mechanism | Status for this app |
|---|---|---|
| 1 | **Browser token handoff** (`--with-token`) | ✅ **the only reachable mechanism** |
| — | API key (any variant) | ❌ `Signum.Rest` not installed |
| — | Username/password | ❌ `PasswordHash` is null for Entra users; attempting it risks lockout |
| — | Entra device code (STORY-10) | ⛔ blocked on an Entra app-registration change |
| — | OpenID loopback (STORY-01) | ⛔ blocked on tenant **and** module |
| — | `Signum.Agent` MCP surface | ❌ not installed either — no alternative authenticated surface |

**Consequence:** STORY-12 is not merely the primary path, it is the *sole* path. The CLI's
authentication design therefore has a single point of failure, and the work must go into making that
one flow genuinely good — low-friction capture, durable storage, honest diagnostics, and a graceful
re-handoff when a token stops working. That is a change of emphasis, not just of priority.

The other mechanisms stay fully specified. They cover other Signum deployments — the CLI is meant to
work against any app (REQ-075) — and they become reachable here if the access situation changes.
Nothing about Decision 1 (hand-rolled grant, no MSAL) is affected.

## Consequences

- **STORY-12 (token handoff) is the primary v1 path**; REQ-008 is added for it.
- STORY-10 (Entra device code) stays specified but drops to **v2**, gated on a tenant change we
  cannot currently make. It is not abandoned — Decision 1 stands and it is ready to build the moment
  rank 5 unblocks.
- STORY-01 (`--web` loopback via the OpenID module) stays v1 but is the path for **non-Entra or
  OpenID-module** deployments. It is not the Entra path.
- The CLI must be configurable per profile with: tenant id, client id, scopes, and `AzureADType`,
  because none of it is discoverable — the framework ships no device-code client and exposes these
  only to the browser.
- Both `idToken` and `accessToken` are sent; `accessToken` feeds the Graph-backed user context
  (`AzureClaimsAutoCreateUserContext`), so a Graph scope may be required for auto-user-creation to
  work. **Untested.**
- Entra returns the same opaque Signum bearer token as every other path, so STORY-04's storage and
  `New_Token` rotation rules apply unchanged.

## Open questions

Blocking the STORY-10 acceptance criteria:

1. **Which Signum module does the target app use — `AzureAD` or `OpenID`?** Determines whether the
   CLI does a token exchange (Decision 1) or a loopback code flow.
2. **Which audience option (A/B/C)** can the tenant administrator accommodate?
3. **`AzureADType`**: workforce `AzureAD`, `B2C`, or `ExternalID`?
4. Is *Allow public client flows* / device code permitted by tenant policy at all? Some tenants
   block the device code grant by Conditional Access.
5. Does auto-user-creation require a Graph `accessToken`, and if so which scope?
