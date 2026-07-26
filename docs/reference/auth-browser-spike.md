# Feasibility spike: browser-based / federated auth for `signum-cli`

Target: `/home/patrick.maue/git/sfcl/signum-framework` (read-only inspection, no modifications made).
Question: can a headless CLI do a `gh auth login --web`-style browser login against a Signum app?

Legend: **[READ]** = directly quoted/verified in source. **[INFER]** = deduction, not stated in code.
**[TEST]** = can only be settled against a live app / live IdP.

---

## 0. Headline answer

**Yes — a `gh`-style loopback browser login is possible today with NO framework changes**, via the
OpenID module. The enabling fact is that `POST api/auth/loginWithOpenID` takes an
**authorization code plus a client-supplied `redirectUri`**, and the framework performs **no
whitelist validation of that redirect URI at all** — it forwards it verbatim to the IdP's token
endpoint. The only gate on `http://localhost:<port>/…` is the **IdP's** own redirect-URI
registration, which is deployment config, not framework code.

Caveats: the CLI must learn `client_id` out-of-band (one tiny upstream change fixes that), and the
app must have the OpenID module enabled.

---

## 1. `Extensions/Signum.Authorization.OpenID/`

### 1.1 Files present

Server-side C#: `OpenIDAuthenticationController.cs`, `OpenIDAuthenticationServer.cs`,
`OpenIDLogic.cs`, `OpenIDConfigurationEmbedded.cs`, `Authorizer/OpenIDAuthorizer.cs`,
`Authorizer/OpenIDClaimsAutoCreateUserContext.cs`.
Client-side TSX: `OpenIDClient.tsx`, `OpenIDAuthenticator.tsx`, `OpenIDCallback.tsx`,
`OpenIDAdminClient.tsx`, `OpenIDConfiguration.tsx`.

Module is actively maintained — last commit touching it `7179aa12a6` (2026-06-10). **[READ]**

### 1.2 Which flows are implemented server-side

Exactly one: **OAuth2 authorization code grant, confidential client, no PKCE.** **[READ]**

`Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationServer.cs:88-106`:

```csharp
static async Task<OpenIDTokenResponse> ExchangeCodeForTokens(string code, string redirectUri, OpenIDConfigurationEmbedded config)
{
    var discoveryDoc = await GetDiscoveryDocument(config);

    var body = new FormUrlEncodedContent(
    [
        new KeyValuePair<string, string>("grant_type", "authorization_code"),
        new KeyValuePair<string, string>("code", code),
        new KeyValuePair<string, string>("redirect_uri", redirectUri),
        new KeyValuePair<string, string>("client_id", config.ClientId!),
        new KeyValuePair<string, string>("client_secret", config.ClientSecret!),
    ]);

    var response = await GetHttpClient(config).PostAsync(discoveryDoc.TokenEndpoint, body);
    response.EnsureSuccessStatusCode();
    ...
}
```

Explicitly **absent** (verified by repo-wide grep for `code_challenge`, `code_verifier`, `PKCE`,
`device_code`, `device_authorization`, `client_credentials`, `AcquireTokenWithDeviceCode`,
`InteractiveBrowserCredential` across `*.cs`, `*.ts`, `*.tsx`, `*.csproj` — **zero hits** outside
two unrelated `Negotiate` matches): **[READ]**

- No PKCE (`code_challenge` / `code_verifier` never appear).
- No implicit flow.
- No device authorization grant.
- No client credentials grant.
- No refresh-token grant (`OpenIDTokenResponse.RefreshToken` is deserialized at
  `OpenIDAuthenticationServer.cs:159-160` but **never read** anywhere — dead field).
- No resource-owner password grant against the IdP.

### 1.3 Routes

`Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationController.cs`:

| Verb | Route | Auth | Request | Response |
|---|---|---|---|---|
| POST | `api/auth/loginWithOpenID?throwErrors=<bool>` | `[SignumAllowAnonymous]` (:12) | `LoginWithOpenIDRequest` | `LoginResponse?` |
| GET | `api/auth/openIDEndpoints` | `[SignumAllowAnonymous]` (:23) | — | `OpenIDEndpointsResponse` |

DTOs, quoted verbatim (`OpenIDAuthenticationController.cs:39-49`):

```csharp
public class OpenIDEndpointsResponse
{
    public string AuthorizationEndpoint { get; set; } = null!;
    public string? EndSessionEndpoint { get; set; }
}

public class LoginWithOpenIDRequest
{
    public string Code { get; set; }
    public string RedirectUri { get; set; }
}
```

Note what `OpenIDEndpointsResponse` does **not** contain: `ClientId`, `Scopes`, `TokenEndpoint`,
`Issuer`. That is the one real friction point for a CLI (see §6.2). **[READ]**

### 1.4 Redirect-URI handling — the critical finding

`RedirectUri` travels: HTTP body → `LoginWithOpenIDRequest.RedirectUri`
(`OpenIDAuthenticationController.cs:48`) → `OpenIDAuthenticationServer.LoginOpenIDAuthentication`
(:13-15) → `ExchangeCodeForTokens(request.Code, request.RedirectUri, config)`
(`OpenIDAuthenticationServer.cs:38`) → `redirect_uri` form field posted to the IdP
(`OpenIDAuthenticationServer.cs:96`).

**There is no whitelist, no allow-list, no regex, no origin check, no `Uri` parsing, no
`config.RedirectUris` field anywhere on that path.** **[READ]** — I read every line of
`OpenIDAuthenticationController.cs` (49 lines), `OpenIDAuthenticationServer.cs` (161 lines) and
`OpenIDConfigurationEmbedded.cs` (67 lines); `OpenIDConfigurationEmbedded` has fields
`Enabled, Authority, ClientId, ClientSecret, RoleClaimPath, Scopes, AvoidSSLVerify` plus the
inherited `BaseADConfigurationEmbedded` fields — **no redirect-URI field exists to validate
against.**

So `http://localhost:<port>/callback` **is accepted by Signum unconditionally**. The redirect URI
is validated only by the IdP, twice: once on the `/authorize` request and once on the token
exchange (where OAuth2 requires it to match the authorization request). **[INFER — standard
OAuth2/RFC 6749 §4.1.3 behaviour, not stated in Signum code]**

Practical consequence: the loopback pattern works **iff the IdP client registration permits it**.
For Keycloak that means adding a Valid Redirect URI. Whether a **port wildcard** (random port, as
`gh` uses) is honoured depends on the IdP's matching rules and is **[TEST]** — see §7. The safe,
portable design is a **fixed loopback port** registered explicitly, e.g.
`http://127.0.0.1:47825/callback`.

The browser client itself uses a fixed non-loopback path (`OpenIDAuthenticator.tsx:37-39`):

```typescript
export function getRedirectUri(): string {
  return window.location.origin + AppContext.toAbsoluteUrl("/openid-callback");
}
```

…which confirms the redirect URI is purely a client-chosen string as far as the server cares.

### 1.5 Which library

**Not** `Microsoft.AspNetCore.Authentication.OpenIdConnect`. `Signum.Authorization.OpenID.csproj`
has **zero** OIDC NuGet package references (`:15-19` — only `Signum.Analyzer`,
`Signum.MSBuildTask`, `Signum.TSGenerator`) and pulls the shared framework via
`<FrameworkReference Include="Microsoft.AspNetCore.App" />` (`:11-13`). **[READ]**

What it actually uses (`OpenIDAuthenticationServer.cs:1-10`):
- `Microsoft.IdentityModel.Protocols.ConfigurationManager<OpenIdConnectConfiguration>` +
  `OpenIdConnectConfigurationRetriever` for discovery (`:108-120`) — metadata retrieval only, no
  middleware, no auth handler, no cookie/challenge plumbing.
- `System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler` for id_token validation (`:122-142`).
- A raw `HttpClient` for the token exchange (`:16-25`; note `AvoidSSLVerify` swaps in a
  `DangerousAcceptAnyServerCertificateValidator` client at `:17-20`).

This is **hand-rolled OIDC**, entirely inside a plain `ControllerBase` action. That is precisely
why it is CLI-friendly: there is no ASP.NET auth middleware pipeline, no challenge/redirect
scheme, no cookie the CLI would have to emulate. **[INFER — but strongly supported]**

Discovery URL construction (`OpenIDConfigurationEmbedded.cs:42`):
`$"{Authority!.TrimEnd('/')}/.well-known/openid-configuration"`.
Default scopes (`:44-45`): `["openid", "profile", "email"]` when `Scopes` is unset.

id_token validation (`OpenIDAuthenticationServer.cs:128-136`): `ValidAudience = config.ClientId`,
`ValidIssuer = discoveryDoc.Issuer`, `ValidateLifetime = true`, keys from discovery. **[READ]**

### 1.6 How the app mints its own token, and can a non-browser client capture it

Yes — trivially. `OpenIDAuthenticationController.cs:13-21`:

```csharp
public async Task<LoginResponse?> LoginWithOpenID([FromBody, Required] LoginWithOpenIDRequest request, [FromQuery] bool throwErrors = true)
{
    if (!await OpenIDAuthenticationServer.LoginOpenIDAuthentication(ControllerContext, request, throwErrors))
        return null;

    var user = UserEntity.Current.Retrieve();
    var token = AuthTokenServer.CreateToken(user);
    return new LoginResponse { userEntity = user, token = token, authenticationType = "openID" };
}
```

`LoginResponse` (`Extensions/Signum.Authorization/AuthController.cs:174-179`):

```csharp
public class LoginResponse
{
    public string authenticationType { get; set; }
    public string token { get; set; }
    public UserEntity userEntity { get; set; }
}
```

The credential is **the same opaque Signum bearer token minted by `POST api/auth/login`** —
`AuthTokenServer.CreateToken` (`AuthToken/AuthTokensServer.cs:181-203`): AES-CBC-encrypted,
Deflate-compressed JSON `AuthToken { User, Claims, PasswordHash, CreationDate }`, base64'd
(`:205-228`). It is returned **in the JSON response body**, not in a cookie, not in a redirect
fragment, not in a `Set-Cookie`. A `curl` can capture it. **[READ]**

Session handoff inside `LoginOpenIDAuthentication` (`OpenIDAuthenticationServer.cs:27-86`):
`ExchangeCodeForTokens` (:38) → `ValidateToken(tokenResponse.IdToken!, config)` (:39) →
`OpenIDClaimsAutoCreateUserContext` (:40) → user lookup by `ExternalId == sub` (:42), then by
`UserName`, then by `Email`/local-part if `AllowMatchUsersBySimpleUserName` (:46-49) →
`AutoCreateUsers` / `AutoUpdateUsers` branches (:52-68) → `AuthServer.OnUserPreLogin` +
`AuthServer.AddUserSession` (:73-74) → back in the controller, `UserEntity.Current.Retrieve()` and
`CreateToken`. Whole thing runs `using (AuthLogic.Disable())` (:29). **[READ]**

Nothing in this path inspects the User-Agent, Origin, Referer, or requires a cookie jar. **[READ]**

### 1.7 Is there an endpoint that exchanges an external IdP token for a Signum bearer token?

**In the OpenID module: no** — it takes a *code*, not a token; the code→token exchange happens
server-side because the server holds the `client_secret`.

**In the AzureAD module: yes** — see §2.2. That is a genuine token-exchange endpoint.

---

## 2. `Extensions/Signum.Authorization.AzureAD/`

### 2.1 Routes

`Extensions/Signum.Authorization.AzureAD/AzureADAuthenticationController.cs`:

| Verb | Route | Auth | Request | Response |
|---|---|---|---|---|
| POST | `api/auth/loginWithAzureAD?adVariant=<s>&throwErrors=<bool>` | `[SignumAllowAnonymous]` (:12) | `LoginWithAzureADRequest` | `LoginResponse?` |
| GET | `api/cachedAzureUserPhoto/{size}/{oID}` | authenticated (:27) | — | `string?` |
| GET | `api/azureUserPhoto/{size}/{oID}` | `[SignumAllowAnonymous]` (:40) | — | `ActionResult` (jpeg) |

`LoginWithAzureADRequest` (`AzureADAuthenticationController.cs:61-65`) — note these are **fields**,
not properties (matters for JSON binding; `SignumServer.cs:43` sets `jso.IncludeFields = true`):

```csharp
public class LoginWithAzureADRequest
{
    public string idToken;
    public string accessToken; 
}
```

### 2.2 The token-exchange path — headless-capable

`AzureADAuthenticationController.cs:12-23` accepts a **raw, externally-obtained Azure AD
`id_token`** and returns a Signum bearer token. Validation
(`AzureAuthenticationServer.cs:81-107`):

```csharp
TokenValidationParameters validationParameters = new TokenValidationParameters
{
    ValidAudience = config!.ApplicationID.ToString(),
    ValidAudiences = ExtraValidAudiences?.Invoke(),
    ValidIssuer = issuer,
    ValidateAudience = true,
    ValidateIssuer = true,
    IssuerSigningKeys = c.SigningKeys,
    ValidateLifetime = true,
};
```

with `issuer` = `$"https://login.microsoftonline.com/{config.DirectoryID}/v2.0"` for
`AzureADType.AzureAD`, else the discovery-document issuer (`:88`). **[READ]**

**This is exploitable by a CLI.** Any client that can obtain an id_token with
`aud == ApplicationID` and `iss == https://login.microsoftonline.com/{DirectoryID}/v2.0` can POST
it and receive a Signum token. A CLI can obtain such a token via **MSAL device code flow** against
the *same* `client_id`, provided the Azure app registration has "Allow public client flows"
enabled. **[INFER — the Signum code does nothing to prevent it, but Signum ships no device-code
client; the CLI would use MSAL/`msal-node`/`msal` .NET itself. Whether the app registration
permits public-client flows is [TEST].]**

`accessToken` is the second field; it feeds Graph calls for delegated group lookup
(`Authorizer/AzureADAuthorizer.cs:62-64`: `config.UseDelegatedPermission` → 
`AzureADLogic.CurrentADGroupsInternal(ac.AccessToken)`). If `UseDelegatedPermission` is false, group
resolution uses the app credential path instead, so a device-code CLI **[INFER]** could likely pass
an empty/omitted `accessToken`.

### 2.3 Is MSAL used, and where

Only **client-side, in the browser**: `@azure/msal-browser` in `AzureADAuthenticator.tsx:2`, used
as `msal.PublicClientApplication` (`:64-86`) with `loginPopup` (`:119`) and `acquireTokenSilent`
(`:231`, `:296`) / `acquireTokenPopup` (`:302`). **Browser-only, popup-based.** **[READ]**

**No `AcquireTokenWithDeviceCode`, no `DeviceCodeCredential`, no
`InteractiveBrowserCredential` anywhere in the repo** (repo-wide grep, zero hits). **[READ]**
There is no MSAL .NET (`Microsoft.Identity.Client`) reference in
`Signum.Authorization.AzureAD.csproj` at all — server-side Azure work goes through
`Azure.Identity` 1.21.0 and `Microsoft.Graph` 6.2.0 (`:18`, `:22`). **[READ]**

### 2.4 `TokenCredentialOverride.cs` and `BaseADConfigurationEmbedded.cs`

`Extensions/Signum.Authorization/BaseAD/TokenCredentialOverride.cs` is 8 lines — a pure indirection
hook so the base `Signum.Authorization` assembly can override credentials without referencing
`Azure.Identity`:

```csharp
public static class TokenCredentialOverride
{
    public static Func<string, IDisposable?>? OverrideProvider { get; set; } // = SignumTokenCredentials.OverrideAuthenticationProvider;
    public static IDisposable? Override(string accessToken) => OverrideProvider?.Invoke(accessToken);
}
```

The real implementation is `Extensions/Signum.Authorization.AzureAD/SignumTokenCredentials.cs`.
Credential types supported: **exactly two** — **[READ]**

1. `ClientSecretCredential(tenantId: DirectoryID, clientId: ApplicationID, clientSecret: ClientSecret)`
   (`SignumTokenCredentials.cs:29-32`) — client-credentials, **server-side only, requires the app
   secret**.
2. `AccessTokenCredential` (`:41-58`) — a trivial `TokenCredential` wrapper that just returns a
   pre-supplied bearer string, installed via `OverrideAuthenticationProvider(string accessToken)`
   (`:37-38`) into an `AsyncThreadVariable` (`:9`).

**Neither is usable from a CLI.** Both are *server-side outbound* credentials for calling Microsoft
Graph (photos, groups, user search), not inbound authentication of a client to Signum. `#1` needs
the tenant client secret. `#2` is an in-process thread-local override. **[READ]**

`BaseADConfigurationEmbedded.cs` (all 14 lines of it, `:3-14`) is user-provisioning policy only —
`AllowMatchUsersBySimpleUserName`, `AutoCreateUsers`, `AutoUpdateUsers`,
`MList<RoleMappingEmbedded> RoleMapping`, `Lite<RoleEntity>? DefaultRole`. **No CLI-relevant
knobs, and again: no redirect-URI list.** **[READ]**

### 2.5 On-behalf-of / token exchange

**No OBO flow** (`grep` for `on_behalf_of` / `urn:ietf:params:oauth:grant-type:jwt-bearer`: no
hits). The `loginWithAzureAD` endpoint is a **one-way trust-the-id_token exchange** (§2.2), which is
functionally what a CLI needs — but it is *not* RFC 8693 token exchange, and the artifact returned
is a Signum token, not an Azure token. **[READ]**

`AzureADAuthenticationServer.ExtraValidAudiences` (`AzureAuthenticationServer.cs:78`) is a public
`Func<IEnumerable<string>>?` hook — an app *could* widen accepted audiences to include a dedicated
CLI app-registration client id. That is an app-level extension point requiring no framework
change. **[READ]**

---

## 3. `Extensions/Signum.Authorization.WindowsAD/`

### 3.1 Windows-integrated auth — browser/Windows-only

`WindowsADController.cs:13-24`:

```csharp
[HttpPost("api/auth/loginWindowsAuthentication"), Authorize, SignumAllowAnonymous]
public LoginResponse? LoginWindowsAuthentication(bool throwError)
```

Note the `[Authorize]` — ASP.NET must have *already* authenticated the caller before the action
runs. `WindowsADServer.LoginWindowsAuthentication` then hard-requires a `WindowsPrincipal`
(`WindowsADServer.cs:28-30`):

```csharp
if (!(ac.HttpContext.User is WindowsPrincipal wp))
    return throwErrors ? throw new InvalidOperationException($"User is not a WindowsPrincipal ({ac.HttpContext.User.GetType().Name})") : false;
```

and reads the SID via `((WindowsIdentity)wp.Identity).User!.Value` (`:57`). Setup instructions in
`WindowsADAuthenticator.tsx:14` point at IIS Windows Authentication.

**Would a Linux CLI work?** In principle a SPNEGO/GSSAPI client (`curl --negotiate`, Python
`requests-kerberos`, `gssapi`) can produce a `Negotiate` header that IIS/Kestrel-Negotiate accepts,
which would materialise a `WindowsPrincipal` server-side. **[INFER — the framework code is
agnostic; it only checks the resulting principal type. Nothing in this repo registers
`AddNegotiate()` (repo-wide grep: no hits), so the hosting layer must supply it — [TEST].]**
Practical blockers: needs a Kerberos keytab/TGT for the CLI's principal, needs the server on
Windows/IIS or Kestrel+Negotiate, and needs the app to be domain-joined. Not a general answer for
`signum-cli`.

**Critical CLI detail if WindowsAD is in play**: the client-side registration sets
`AuthClient.Options.AuthHeader = "Signum_Authorization"` (`WindowsADAuthenticator.tsx:22`) and the
server counterpart is `AuthTokenServer.PrepareForWindowsAuthentication()`
(`AuthToken/AuthTokensServer.cs:59-62`) which flips the static `AuthHeader` from `"Authorization"`
to `"Signum_Authorization"`. So **on a WindowsAD deployment the CLI must send its bearer token in
`Signum_Authorization`, not `Authorization`** — otherwise IIS eats the header. **[READ]** No
in-repo caller of `PrepareForWindowsAuthentication` exists; it's opt-in per app. **[READ]**

### 3.2 Headless LDAP bind — yes, and it's the sleeper finding

`Authorizer/WindowsADAuthorizer.cs:33-91`, `LoginWithWindowsADRegistry`:

```csharp
if (config != null && config.LoginWithActiveDirectoryRegistry)
{
    using (PrincipalContext pc = new PrincipalContext(ContextType.Domain, config.DomainName, userName, password))
    {
        if (pc.ValidateCredentials(userName, password, ContextOptions.Negotiate))
        { ... }
```

This is reached from `ICustomAuthorizer.Login` (`WindowsADAuthorizer.cs:17-31`), i.e. from the
**plain `POST api/auth/login` username+password endpoint** (`AuthController.cs:26-29`). So on a
WindowsAD-configured app with `LoginWithActiveDirectoryRegistry = true`, a CLI can send **domain
credentials to the ordinary login endpoint** and get a bearer token — fully headless, no browser,
no Kerberos. **[READ]** Order of attempts: local DB first (`:20-21`, comment "Database is faster
than Active Directory"), then AD registry (`:23-28`), then local DB again (`:30`).

Caveat: `System.DirectoryServices.AccountManagement` is Windows-only (the file opens with
`#pragma warning disable CA1416 // Validate platform compatibility`, `:5`), so the **server** must
run on Windows. The CLI side is platform-agnostic. **[READ]**

---

## 4. `AuthController.cs` and `ICustomAuthorizer.cs`

### 4.1 Every route on `AuthController`

`Extensions/Signum.Authorization/AuthController.cs` — class decorated `[ValidateModelFilter]` (:9):

| # | Verb | Route | Anon? | Request DTO | Response |
|---|---|---|---|---|---|
| 1 | POST | `api/auth/login` (:12) | `[SignumAllowAnonymous]` | `LoginRequest` (body, `[Required]`) | `ActionResult<LoginResponse>` |
| 2 | GET | `api/auth/loginFromApiKey?apiKey=<s>` (:72) | **no** | `string apiKey` (query, unused in body) | `LoginResponse` |
| 3 | GET | `api/auth/relogin` (:82) | **no** | — | `LoginResponse` |
| 4 | POST | `api/auth/loginFromCookie` (:94) | `[SignumAllowAnonymous]` | — (reads `sfUser` cookie) | `LoginResponse?` |
| 5 | GET | `api/auth/currentUser` (:108) | **no** | — | `UserEntity?` |
| 6 | POST | `api/auth/logout` (:115) | **no** | — | `void` |
| 7 | POST | `api/auth/ChangePassword` (:123) | **no** | `ChangePasswordRequest` (body, `[Required]`) | `ActionResult<LoginResponse>` |

DTOs verbatim (`AuthController.cs:166-197`):

```csharp
#pragma warning disable IDE1006 // Naming Styles
public class LoginRequest
{
    public string userName { get; set; }
    public string password { get; set; }
    public bool? rememberMe { get; set; }
}

public class LoginResponse
{
    public string authenticationType { get; set; }
    public string token { get; set; }
    public UserEntity userEntity { get; set; }
}

public class ChangePasswordRequest
{
    public string oldPassword { get; set; }
    public string newPassword { get; set; }
}

public class ResetPasswordRequest
{
    public string code { get; set; }
    public string newPassword { get; set; }
}

public class ForgotPasswordRequest
{
    public string eMail { get; set; }
}
#pragma warning restore IDE1006 // Naming Styles
```

(`ResetPasswordRequest` / `ForgotPasswordRequest` are declared here but consumed by
`Extensions/Signum.Authorization.ResetPassword/ResetPasswordController.cs`.)

Route #2, `loginFromApiKey`, is worth flagging: it is **not** anonymous, so the caller must already
be authenticated — in practice by the API-key authenticator (§5). Its `apiKey` parameter is
**never read in the method body** (`:72-80`); it exists only so the key lands in the query string
where `RestApiKeyServer.ApiKeyAuthenticator` picks it up
(`Extensions/Signum.Rest/RestApiKeyServer.cs:25`). Its effect is: **exchange a long-lived API key
for a short-lived refreshing bearer token.** **[READ + INFER on intent]**

Route #3, `relogin`, similarly re-mints a fresh token for an already-authenticated caller (:82-92)
and is the cleanest "extend my session" call for a CLI. **[READ]**

Full inventory of `api/auth/*` across the whole repo (grep, all modules):
`login`, `loginFromApiKey`, `relogin`, `loginFromCookie`, `currentUser`, `logout`, `ChangePassword`
(AuthController); `loginWithAzureAD` (AzureAD); `loginWithOpenID`, `openIDEndpoints` (OpenID);
`loginWindowsAuthentication` (WindowsAD); `forgotPasswordEmail`, `resetPassword`, `requestNewLink`
(ResetPassword). **[READ]**

### 4.2 `ICustomAuthorizer` — the extension seam

`Extensions/Signum.Authorization/ICustomAuthorizer.cs:7-10`, in full:

```csharp
public interface ICustomAuthorizer
{
    UserEntity Login(string userName, string password, out string authenticationType);
}
```

That is the *entire* seam: **one method, username + password in, `UserEntity` out.** It is invoked
from exactly one place (`AuthController.cs:26-29`):

```csharp
if (AuthLogic.Authorizer == null)
    user = AuthLogic.Login(data.userName, data.password, out authenticationType);
else
    user = AuthLogic.Authorizer.Login(data.userName, data.password, out authenticationType);
```

All three IdP modules implement it, and **all three delegate straight back to password auth** —
`OpenIDAuthorizer.Login` → `AuthLogic.Login` (`Authorizer/OpenIDAuthorizer.cs:16-19`);
`AzureADAuthorizer.Login` → `AuthLogic.Login` (`Authorizer/AzureADAuthorizer.cs:15-18`);
`WindowsADAuthorizer.Login` → DB, then AD bind, then DB (`Authorizer/WindowsADAuthorizer.cs:17-31`).
`AuthLogic.Authorizer` is a single-slot static, so **only one authorizer can be installed at a
time.** **[READ]**

**Could an app plug in a CLI-friendly authorizer?** Only by abusing the shape. The signature admits
no redirect URI, no code, no device code, no return channel for a pending authorization, and no way
to signal "poll me again later". You would have to smuggle a CLI credential through the
`password` string (e.g. `userName="__cli__", password="<device-code>"`), which is a hack, not a
seam. **Verdict: `ICustomAuthorizer` is NOT a viable seam for browser/device flows.** A real
CLI flow needs a *new controller action*, which is exactly how all three IdP modules already do it
(each ships its own `*AuthenticationController`, bypassing `ICustomAuthorizer` entirely for its
federated path). **[INFER, well-supported]**

Sibling interfaces in the same file: `IDirectoryInviter` (`:12-17`, user search/import from AD,
unrelated to login) and `IAutoCreateUserContext` (`:19-27`, the claims→user projection).

### 4.3 "Authorize this device/app" or consent endpoint

**None.** No device-authorization endpoint, no user-code entry page, no consent screen, no
"pending authorization" entity, nothing resembling `gh`'s device flow. **[READ — grep for
`device_code`/`device_authorization`/`user_code`: zero hits; full route inventory in §4.1 shows no
such route.]**

The closest *pattern* in the codebase is the password-reset code:
`ResetPasswordRequestEntity.Code` (`Extensions/Signum.Authorization.ResetPassword/ResetPasswordRequest.cs:9`),
generated as `Random.Shared.NextString(32)`
(`ResetPasswordRequestLogic.cs:200`), emailed as
`$"{config.UrlLeft}/auth/resetPassword?code={request.Code}"` (`:29`), and redeemed by
`POST api/auth/resetPassword` with `{ code, newPassword }`. It is a **short-lived, single-use,
DB-backed code exchanged at an anonymous endpoint** — i.e. structurally *exactly* the shape a
"CLI authorization code" would take. Useful precedent for §6.2. **[READ]**

---

## 5. The authenticator chain

Registration sites (repo-wide grep for `Authenticators.Add|Insert` — only two files):

- `Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs:27-30` (in `Start`, called from
  `AuthServer.Start` → `AuthTokensServer.Start`, `AuthServer.cs:26`) — `.Add` ×4.
- `Extensions/Signum.Rest/RestApiKeyServer.cs:19` — `.Insert(0, …)`, i.e. **jumps the queue**.

The chain lives on `SignumAuthenticationFilter.Authenticators`
(`Signum/API/Filters/SignumFilters.cs:43`), a `List<Func<FilterContext, SignumAuthenticationResult?>>`,
and is evaluated **first-non-null-wins** (`SignumFilters.cs:45-55`):

```csharp
private static SignumAuthenticationResult? Authenticate(ResourceExecutingContext actionContext)
{
    foreach (var item in Authenticators)
    {
        var result = item(actionContext);
        if (result != null)
            return result;
    }
    return null;
}
```

The filter is registered globally as `new SignumAuthenticationFilter()` in
`Signum/API/SignumServer.cs:68` (`AddSignumGlobalFilters`, 10th of 11 filters), and on success
stashes `UserWithClaims` into `HttpContext.Items["Signum_User_Holder"]` and opens a
`UserHolder.UserSession` for the request (`SignumFilters.cs:57-67`).

**Effective order and what each inspects:** **[READ]**

| Order | Authenticator | Source file:line | Inspects |
|---|---|---|---|
| 0 | `ApiKeyAuthenticator` | `Signum.Rest/RestApiKeyServer.cs:19,23-44` | **query** `?apiKey=` **and header** `X-ApiKey` (`RestApiKeyLogic.cs:9-10`); unions both, throws `AuthenticationException` if >1 distinct key (`:38-41`); resolves via `RestApiKeyCache` |
| 1 | `TokenAuthenticator` | `AuthTokensServer.cs:27,66-102` | **header** named by static `AuthHeader` (default `"Authorization"`, `:57`; `"Signum_Authorization"` after `PrepareForWindowsAuthentication()`, `:59-62`), value after `"Bearer "` (`:144`); also **query** `?refreshToken` to force refresh (`:88`) |
| 2 | `AnonymousUserAuthenticator` | `AuthTokensServer.cs:28,39-45` | nothing — returns `AuthLogic.AnonymousUser` if the app configured one |
| 3 | `AllowAnonymousAuthenticator` | `AuthTokensServer.cs:29,48-55` | the **action/controller metadata** for `[SignumAllowAnonymous]` |
| 4 | `InvalidAuthenticator` | `AuthTokensServer.cs:30,34-37` | nothing — unconditionally `throw new AuthenticationException("No authentication information found!")` |

Note the ordering quirk: **`AnonymousUserAuthenticator` precedes `AllowAnonymousAuthenticator`**,
so on an app with an anonymous user configured, `[SignumAllowAnonymous]` actions execute *as* that
anonymous user rather than with a null principal. **[READ]** No cookie authenticator is in the
chain — the `sfUser` cookie is only read by the explicit `POST api/auth/loginFromCookie` action
(`UserTicket/UserTicketServer.cs:14-47`), never ambiently. **[READ]**

**So the complete set of credential shapes the server accepts on an arbitrary request is:**
`X-ApiKey` header, `?apiKey=` query, `Authorization: Bearer <signum-token>` (or
`Signum_Authorization: Bearer …`). That's it. Everything else (OIDC code, Azure id_token, Windows
principal, reset code, `sfUser` cookie) is only accepted at its own dedicated anonymous endpoint,
and every one of those endpoints hands back the *same* bearer token. **[READ]**

### 5.1 Token lifecycle — operationally important for the CLI

`TokenAuthenticator` (`AuthTokensServer.cs:85-94`) transparently rotates the token:

```csharp
bool requiresRefresh =  
    token.CreationDate < AuthTokenServer.GetTokenLimitDate() ||
    conf.RefreshAnyTokenPreviousTo.HasValue && token.CreationDate < conf.RefreshAnyTokenPreviousTo ||
    ctx.HttpContext.Request.Query.ContainsKey("refreshToken");

if (requiresRefresh)
{
    ctx.HttpContext.Response.Headers["New_Token"] = RefreshToken(token, out var newUserWithClaims);
    return new SignumAuthenticationResult { UserWithClaims = newUserWithClaims };
}
```

`RefreshTokenEvery` defaults to **30 minutes** (`AuthToken/AuthTokenConfigration.cs:6-7`). The
refreshed token comes back in a **`New_Token` response header** — the web client reads exactly this
(`AuthClient.tsx:167`: `var newToken = r.headers.get("New_Token");`).

**The CLI must read `New_Token` off every response and persist it**, or it will start paying a
refresh round-trip on every call and, more importantly, its stored token stays pinned to an old
`CreationDate`. Refresh fails (throws `AuthenticationException`) if the user was deleted, is not
`Active`, was renamed, or **changed password** (`RefreshToken`, `:104-137`, esp. `:117-118`
comparing `PasswordHash`). There is no hard expiry — a token refreshes indefinitely while the user
is unchanged. **[READ]**

`AuthTokenServer.AuthenticateHeader` (`:19`, `Func<string,bool>` defaulting to `_ => true`) is an
app-level veto hook on the raw header — an app could use it to reject CLI tokens; none in-repo
does. **[READ]**

---

## 6. Verdict

### 6.1 Is a `gh`-style browser login possible today with NO framework changes?

**YES — via the OpenID module**, with one deployment prerequisite and one packaging wrinkle.

Prerequisites:
- (a) The app runs `Signum.Authorization.OpenID` with `OpenIDConfigurationEmbedded.Enabled = true`
  (`OpenIDConfigurationEmbedded.cs:9`) and `OpenIDAuthorizer` installed as `AuthLogic.Authorizer`
  (asserted by the cast at `OpenIDAuthenticationController.cs:26`).
- (b) The IdP client registration includes the CLI's loopback redirect URI. **[TEST]**
- (c) The CLI knows `client_id` and the scope list — **not exposed by any API today** (see §6.2).
  Workarounds without framework changes: put them in CLI config / `signum-cli auth login
  --client-id …`, or scrape `window.__openIDConfig` out of the app's `Index.cshtml`-rendered HTML
  (`OpenIDAuthenticator.tsx:13,170`) — fragile, **[INFER]** that it's even present, since it is an
  app-template line, not framework code.

Exact HTTP sequence:

```
1. CLI binds a loopback listener, e.g. http://127.0.0.1:47825/callback
   (fixed port; register it in the IdP once)

2. GET  {app}/api/auth/openIDEndpoints
   → 200 { "authorizationEndpoint": "...", "endSessionEndpoint": "..." }
   [OpenIDAuthenticationController.cs:23-36 — SignumAllowAnonymous, no credential needed]

3. CLI generates state (and nonce), opens the system browser at:
   GET {authorizationEndpoint}
       ?response_type=code
       &client_id={clientId}
       &redirect_uri=http%3A%2F%2F127.0.0.1%3A47825%2Fcallback
       &scope=openid+profile+email          # or config.Scopes
       &state={random}
   [mirrors OpenIDAuthenticator.tsx:52-63 exactly, differing only in redirect_uri]

4. User authenticates at the IdP in their real browser (SSO, MFA, passkeys — all work,
   the CLI never sees credentials).

5. IdP 302s the browser to
   http://127.0.0.1:47825/callback?code=...&state=...
   CLI's listener captures code, verifies state, serves a "you can close this tab" page.
   [state is verified client-side only; cf. OpenIDCallback.tsx:24-38 — the server never
    checks state]

6. POST {app}/api/auth/loginWithOpenID?throwErrors=true
   Content-Type: application/json
   { "code": "<code>", "redirectUri": "http://127.0.0.1:47825/callback" }
   → 200 { "authenticationType": "openID", "token": "<base64 Signum token>",
            "userEntity": { ... } }
   [OpenIDAuthenticationController.cs:12-21. Server does code→token exchange with its own
    client_secret (OpenIDAuthenticationServer.cs:88-106), validates the id_token
    (:122-142), resolves/creates the local user (:42-68), mints the bearer token (:19).]

7. CLI persists response.token. Subsequent calls:
   Authorization: Bearer <token>
   …and on EVERY response, if header New_Token is present, overwrite the stored token.
   [AuthTokensServer.cs:66-102]
```

Why this works and is not an accident of misconfiguration: the framework treats `redirectUri` as
**opaque client input with no validation** (§1.4), and the confidential-client secret stays
server-side, so the CLI needs no secret of its own. The CLI is, from the server's perspective,
indistinguishable from the SPA.

Residual risk, honestly stated: step 5/6 depend on the IdP accepting a loopback redirect URI for a
**confidential** client. Some IdPs restrict loopback redirects to public clients. **[TEST]**

### 6.2 Smallest, most idiomatic upstream change

Not one change but a ranked list — the first is nearly free.

**(1) Expose `ClientId` and `Scopes` on `openIDEndpoints`** — *2 lines.* File:
`Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationController.cs`. Add
`public string ClientId { get; set; }` and `public string[] Scopes { get; set; }` to
`OpenIDEndpointsResponse` (:39-43) and populate them from `config` in `GetOpenIDEndpoints` (:31-35)
— `config.ClientId!` and `config.GetScopes()` (`OpenIDConfigurationEmbedded.cs:44-45`) already
exist, and `ToOpenIDConfigTS()` (:47-52) already publishes exactly these three values to the
browser, so **no new information is disclosed** — it merely moves data that is already in every
page's HTML into the already-anonymous API. This alone makes the CLI **fully self-configuring** and
removes prerequisite (c) from §6.1. **Recommended as the single upstream ask.**

**(2) Add PKCE support** — *~15 lines.* Same two OpenID files: accept an optional
`CodeVerifier` on `LoginWithOpenIDRequest` (`OpenIDAuthenticationController.cs:45-49`) and append
`code_verifier` to the form body in `ExchangeCodeForTokens`
(`OpenIDAuthenticationServer.cs:92-99`). Needed if the IdP requires PKCE for the client, which many
now do by default (Keycloak's `pkce.code.challenge.method=S256`). Without it, a PKCE-enforcing
client **breaks the flow in §6.1 at step 6** — this is the most likely single cause of failure and
should be checked early. **[TEST]**

**(3) A device-code endpoint** — larger, but the best UX for headless/SSH/container use. Idiomatic
placement: a new `Extensions/Signum.Authorization.OpenID/OpenIDDeviceCodeController.cs` alongside
the existing controller, calling the IdP's `device_authorization_endpoint` (already available on
the discovery document returned by `GetDiscoveryDocument`,
`OpenIDAuthenticationServer.cs:108-120`) and polling the token endpoint with
`grant_type=urn:ietf:params:oauth:grant-type:device_code`. Two anonymous actions
(`api/auth/openIDDeviceStart`, `api/auth/openIDDevicePoll`), reusing the existing
`ValidateToken` + user-resolution + `AuthTokenServer.CreateToken` tail verbatim. Requires the IdP
to support the device grant. **Do not** try to route this through `ICustomAuthorizer` (§4.2).

**(4) A native "CLI authorization code"** (no IdP involvement) — a new entity + two endpoints
modelled *directly* on `ResetPasswordRequestEntity`
(`Extensions/Signum.Authorization.ResetPassword/ResetPasswordRequest.cs:9`,
`ResetPasswordRequestLogic.cs:200`): CLI POSTs anonymously to get a `user_code` + `device_code`,
user opens `{app}/auth/authorizeDevice?code=…` in their browser and approves while logged in, CLI
polls and receives a bearer token. This is IdP-agnostic — it works on password-auth, AzureAD,
WindowsAD and OpenID apps alike, which no other option does. Correspondingly the largest change
(entity + schema + logic + controller + an approval page).

**(5) Loopback-redirect allowance** — explicitly **not needed**. There is nothing to relax: no
whitelist exists (§1.4).

### 6.3 Which IdP module offers a headless path

| Module | Browser-based (loopback) | Device code | Client credentials | ROPC / password | LDAP bind |
|---|---|---|---|---|---|
| **OpenID** | **YES** — §6.1, zero framework changes | no (§1.2) | no | no | n/a |
| **AzureAD** | Yes-ish — but the id_token endpoint is more direct | **YES, via external MSAL** — §2.2/§2.3 | server-only, needs app secret (§2.4) | no | n/a |
| **WindowsAD** | no — needs a `WindowsPrincipal` (§3.1) | no | no | n/a | **YES** — `POST api/auth/login` with domain creds (§3.2) |

- **OpenID: browser-based, headless-capable, and the best answer.** Interactive but scriptable.
- **AzureAD: the only true token-exchange path.** `POST api/auth/loginWithAzureAD` with an
  id_token the CLI obtained itself (MSAL device code, `aud == ApplicationID`,
  `iss == login.microsoftonline.com/{DirectoryID}/v2.0`). Signum ships **no** device-code client,
  so the CLI must bring its own MSAL — but no framework change is needed. Gated on the Azure app
  registration allowing public-client flows. **[TEST]**
- **WindowsAD: browser-only for the integrated path, but has a genuine headless LDAP bind** — and
  it needs no new endpoint at all, just `POST api/auth/login`. Requires a Windows server and
  `LoginWithActiveDirectoryRegistry = true`.

### 6.4 What should the CLI do in the meantime — ranked

1. **`X-ApiKey` (or `?apiKey=`) → `GET api/auth/loginFromApiKey` → bearer token.** Zero server
   changes, works on every deployment with `Signum.Rest`, no interaction, ideal for CI. Trade the
   long-lived key for a rotating token immediately so the key isn't on every request
   (`RestApiKeyServer.cs:23-44`, `AuthController.cs:72-80`). **Make this the default `signum-cli
   auth login --with-token` path.**
2. **`POST api/auth/login` (username/password) → bearer token.** Universal fallback. On a
   WindowsAD app this transparently becomes a domain LDAP bind (§3.2). Store only the token, never
   the password.
3. **OpenID loopback browser flow (§6.1)** — implement it now behind
   `signum-cli auth login --web`, with `--client-id`/`--scope`/`--port` flags to cover the missing
   discovery fields until change (1) lands. This is the one that matches the `gh` UX.
4. **AzureAD MSAL device code → `POST api/auth/loginWithAzureAD`** — implement if/when a target
   deployment is Entra-backed. Best headless UX of all (no browser on the CLI host), but only
   applies to AzureAD apps and depends on the app registration.
5. **Windows integrated / SPNEGO** — do not invest. Narrow, Windows-server-only, needs Kerberos
   plumbing on the CLI host.

Design constants regardless of mechanism, all from §5:
- Every path yields the **same** opaque bearer token — build one credential store, one
  `Authorization: Bearer` code path, and treat login mechanisms as pluggable front-ends.
- **Always honour the `New_Token` response header** (`AuthTokensServer.cs:92`) and re-persist.
- Support configuring the header name as `Signum_Authorization` for WindowsAD deployments
  (`AuthTokensServer.cs:57-62`).
- `GET api/auth/relogin` (`AuthController.cs:82-92`) is the explicit "give me a fresh token" call;
  `?refreshToken` on any request forces rotation (`AuthTokensServer.cs:88`).
- Treat `AuthenticationException` → re-login; token refresh legitimately fails after a password
  change or deactivation (`AuthTokensServer.cs:104-137`).

---

## 7. What can only be settled against a live app

Named tests, in priority order:

1. **PKCE enforcement.** Run §6.1 end-to-end. If step 6 returns 500 with an IdP
   `invalid_grant`/`code_verifier` complaint, the client requires PKCE → upstream change (2) is
   mandatory, not optional. *Fastest check:* `GET {authority}/.well-known/openid-configuration` and
   inspect `code_challenge_methods_supported`; then check the client's
   `pkce.code.challenge.method` in Keycloak.
2. **Loopback redirect acceptance for a confidential client.** Register
   `http://127.0.0.1:47825/callback` on the existing client and complete steps 3-6. Then separately
   test whether a **port wildcard** works, which decides fixed-port vs. random-port design.
3. **Is OpenID even enabled on the target app?** `GET {app}/api/auth/openIDEndpoints` — 200 with an
   `authorizationEndpoint` means yes; a 500 `"OpenID is not configured"`
   (`OpenIDAuthenticationController.cs:28`) means the module is present but off; a 404 means the
   module isn't loaded at all.
4. **Is `client_id` recoverable without change (1)?** `curl {app}/` and grep for
   `__openIDConfig` — confirms whether the scraping fallback is viable.
5. **AzureAD only:** does the app registration allow public client flows (device code)? Attempt an
   MSAL device-code acquisition for `client_id = ApplicationID` against
   `https://login.microsoftonline.com/{DirectoryID}`, then POST the resulting `idToken` to
   `api/auth/loginWithAzureAD`. Also check whether omitting `accessToken` is tolerated (depends on
   `UseDelegatedPermission`, `AzureADAuthorizer.cs:62-64`).
6. **`New_Token` rotation.** Authenticate, wait past `RefreshTokenEvery` (default 30 min,
   `AuthTokenConfigration.cs:6-7`) or just append `?refreshToken`, and confirm a `New_Token`
   response header appears — validates the CLI's persistence logic.
7. **Header name.** Confirm `Authorization` (not `Signum_Authorization`) is in force, i.e. that the
   app does not call `PrepareForWindowsAuthentication()`.

## 8. Admitted gaps in this analysis

- I read all server-side C# in the three IdP modules, `AuthController.cs`, `ICustomAuthorizer.cs`,
  `AuthTokensServer.cs`, `UserTicketServer.cs`, `RestApiKey{Logic,Server}.cs`, `SignumServer.cs`
  and `SignumFilters.cs` in full. I did **not** read `AuthLogic.cs`, `AzureADLogic.cs`,
  `WindowsADLogic.cs`, `MicrosftGraphQuery.cs` or the `Rules/` tree — these govern
  user/role/permission resolution *after* authentication and cannot change the credential shapes in
  §5, but if a claim ends up wrong post-login the answer is likely in `AuthLogic.cs`.
- I did **not** inspect a Signum *application* template (`Index.cshtml`, `Starter.cs`,
  `MainPublic.tsx`), so statements about `window.__openIDConfig` actually being present in a given
  deployment are **[INFER]** from the comment at `OpenIDAuthenticator.tsx:11-14`.
- Everything about IdP-side behaviour (redirect-URI matching, PKCE enforcement, device-grant
  support, public-client flags) is outside this repo and marked **[TEST]**.
- No code was executed and no live endpoint was contacted; the framework tree was not modified.
