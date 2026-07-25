# ADR 0004 — Entra as the primary identity provider

**Status:** PARTIALLY ACCEPTED — the flow is decided; the **audience strategy is OPEN** and needs
an answer from whoever administers the target app's Entra tenant.
**Date:** 2026-07-25
**Owner input:** the target application uses **Entra**. Testing happens later.

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

This also means Entra support costs the binary nothing in size or AOT risk.

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

**Recommendation: Option B**, falling back to A if a second registration is not obtainable.

## Consequences

- STORY-10 becomes **v1** and the primary documented path; REQ-005 moves v2 → v1.
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
