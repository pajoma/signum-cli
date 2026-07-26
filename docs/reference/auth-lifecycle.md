# Signum Framework — Authentication Lifecycle (for a headless CLI client)

Source tree: `/home/patrick.maue/git/sfcl/signum-framework` (read-only, no modifications made).
All line numbers are from that working tree at the time of analysis.
Scope note: browser/OIDC/AzureAD *feasibility* is covered by a separate investigation; this document
covers the mechanics of credentials a CLI holds (password login, bearer auth token, REST API key),
their lifecycle, and the logging/authorization side-effects a client must respect.

Placeholders are used for all secret-shaped values: `YOUR_API_KEY_HERE`, `YOUR_BEARER_TOKEN_HERE`.

---

## 0. Executive summary (the five things that bite)

1. **Auth failures are HTTP 403, never 401.** `AuthenticationException` and
   `UnauthorizedAccessException` both map to `Forbidden`
   (`Signum/API/Filters/SignumExceptionFilterAttribute.cs:131-146`), with an explicit comment that
   401 was avoided on purpose.
2. **The bearer token has no expiry.** `RefreshTokenEvery` (default 30 min) is a *rotation*
   interval, not a lifetime. An arbitrarily old token still authenticates; the server silently
   mints a replacement and puts it in the **`New_Token` response header**
   (`Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs:85-94`). A client that ignores
   that header keeps working but keeps paying a DB round-trip and never sees role changes.
3. **A malformed/tampered/undecryptable token does not produce an error.** It is swallowed and the
   request degrades to the anonymous user (or to a generic 403 "No authentication information
   found!"). See §2.7 — this is the single biggest silent-failure trap.
4. **API keys never expire and are not revoked by deactivating the user.** Only deleting the
   `RestApiKeyEntity` row revokes one. There is no scoping, no rotation, no rate limit (§3).
5. **Query strings are persisted** by `RestLogFilter` *and* by the global exception logger — and the
   exception logger also persists the **full request body** and User-Agent. So a password in a login
   body can end up in `ExceptionEntity.Form` if that request throws (§3.6).

---

## 1. Complete `api/auth/*` surface

`AuthController` is decorated `[ValidateModelFilter]` (`Extensions/Signum.Authorization/AuthController.cs:9`),
which converts model-binding/validation failures into `400 BadRequest` with an ASP.NET `ModelState`
body (`Signum/API/Filters/ValidateModelFilterAttribute.cs:8-27`).

"Auth required?" below means: does the endpoint carry `[SignumAllowAnonymous]`? If not, the
authentication pipeline must produce a user or the request 403s (see §2.6 for the exact ladder).

| Verb | Route | Request DTO | Response DTO | Auth required? | What it does |
|---|---|---|---|---|---|
| POST | `api/auth/login` | `LoginRequest` (body, `[Required]`) | `ActionResult<LoginResponse>` | **No** — `[SignumAllowAnonymous]` (`AuthController.cs:12`) | Username/password login. Delegates to `AuthLogic.Login` or `AuthLogic.Authorizer.Login` (`AuthController.cs:26-29`). On `rememberMe == true` also sets the `sfUser` ticket cookie (`AuthController.cs:62-65`). Returns a fresh token. |
| GET | `api/auth/loginFromApiKey?apiKey=…` | `string apiKey` (query, **unused in the body of the method**) | `LoginResponse` | Yes (`AuthController.cs:72`) | Exchanges an already-authenticated identity for a bearer token. The `apiKey` parameter is *never read* by the method (`AuthController.cs:73-80`) — authentication happened earlier in the filter pipeline via `X-ApiKey` **or** `?apiKey=`. `authenticationType = "api-key"`. |
| GET | `api/auth/relogin` | — | `LoginResponse` | Yes (`AuthController.cs:82`) | Re-issues a token for the current user and fires `AuthLogic.OnUserLogingIn` (`AuthController.cs:83-92`). |
| POST | `api/auth/loginFromCookie` | — (reads `sfUser` cookie) | `LoginResponse?` (**null** if no/invalid cookie) | **No** — `[SignumAllowAnonymous]` (`AuthController.cs:94`) | Ticket-cookie login (§2.9). Returns `null` (HTTP 200 with `null` body) when the cookie is absent (`AuthController.cs:97-98`). |
| GET | `api/auth/currentUser` | optional `?refreshToken=true` | `UserEntity?` | Yes (`AuthController.cs:108`) | Returns the current user, or `null` if it is the configured anonymous user (`AuthController.cs:111-112`). `?refreshToken=true` force-triggers token rotation (`AuthTokensServer.cs:88`). |
| POST | `api/auth/logout` | — | `void` | Yes (`AuthController.cs:115`) | Fires `AuthServer.UserLoggingOut` and **removes the ticket cookie only** (`AuthController.cs:116-121`). **It does not invalidate the bearer token** — there is no server-side token blacklist. |
| POST | `api/auth/ChangePassword` | `ChangePasswordRequest` (body, `[Required]`) | `ActionResult<LoginResponse>` | Yes (`AuthController.cs:123`) | Validates old password (or allows empty old password when `PasswordHash == null`), applies `UserEntity.OnValidatePassword`, saves, clears `MustChangePassword`, and returns a **new** token (`AuthController.cs:126-156`). Route casing is `ChangePassword`; ASP.NET routing is case-insensitive and the TS client calls `/api/auth/changePassword` (`AuthClient.tsx:315`). |
| POST | `api/auth/forgotPasswordEmail` | `ForgotPasswordRequest` | `ForgotPasswordResponse` | **No** — `[SignumAllowAnonymous]` (`Extensions/Signum.Authorization.ResetPassword/ResetPasswordController.cs:11`) | Sends reset mail. **Never throws**: errors are returned as `{success:false, message}` with HTTP 200 (`ResetPasswordController.cs:29-36`). |
| POST | `api/auth/resetPassword` | `ResetPasswordRequest` | `ActionResult<LoginResponse>` | **No** — `[SignumAllowAnonymous]` (`ResetPasswordController.cs:46`) | Consumes the emailed `code`, sets the new password, returns a token with `authenticationType = "resetPassword"` (`ResetPasswordController.cs:57`). |
| POST | `api/auth/requestNewLink` | `string code` (raw JSON string body) | `void` | **No** — `[SignumAllowAnonymous]` (`ResetPasswordController.cs:60`) | Re-sends a reset link for an expired code. |
| POST | `api/auth/loginWithAzureAD?adVariant=…&throwErrors=…` | `LoginWithAzureADRequest` | `LoginResponse?` | **No** — `[SignumAllowAnonymous]` (`Extensions/Signum.Authorization.AzureAD/AzureADAuthenticationController.cs:12`) | Exchanges MSAL tokens for a Signum token; `authenticationType = "azureAD"`. |
| POST | `api/auth/loginWithOpenID?throwErrors=…` | `LoginWithOpenIDRequest` | `LoginResponse?` | **No** — `[SignumAllowAnonymous]` (`Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationController.cs:12`) | Authorization-code exchange; `authenticationType = "openID"`. |
| GET | `api/auth/openIDEndpoints` | — | `OpenIDEndpointsResponse` | **No** — `[SignumAllowAnonymous]` (`OpenIDAuthenticationController.cs:23`) | Publishes `authorizationEndpoint` / `endSessionEndpoint` from OIDC discovery. Useful to a CLI as a *probe* for whether OIDC is configured. |
| POST | `api/auth/loginWindowsAuthentication?throwError=…` | — (Negotiate/NTLM) | `LoginResponse?` | **No** — `[Authorize, SignumAllowAnonymous]` (`Extensions/Signum.Authorization.WindowsAD/WindowsADController.cs:13`) | Windows integrated auth. Note: when Windows auth is enabled the framework **renames the bearer header** (§2.5). |

Adjacent but not `api/auth/*`, listed because a CLI will need them:

| Verb | Route | Response | Auth | Notes |
|---|---|---|---|---|
| GET | `api/restApiKey/generate` | `string` | Yes, no permission check | Returns a *fresh random string*, does **not** store it (`Extensions/Signum.Rest/RestApiKeyController.cs:8-12`). |
| GET | `api/restApiKey/current` | `string?` | Yes, no permission check, runs in `ExecutionMode.Global()` | Returns the caller's own stored API key, bypassing all authorization rules (`RestApiKeyController.cs:14-19`). |
| GET | `api/restLog/?id=…&url=…` | `string` | Yes, no permission attribute | Replays a logged request **using the original user's API key** against an arbitrary `url` (`Extensions/Signum.Rest/RestLogController.cs:8-21`). See §3.7. |
| GET | `api/authAdmin/*` | rule packs | Yes | Role rule administration (`Extensions/Signum.Authorization/AuthAdminController.cs:12+`). |

### 1.1 DTO definitions, verbatim

From `Extensions/Signum.Authorization/AuthController.cs:166-197` (note the file-scoped
`#pragma warning disable IDE1006` — property names are deliberately camelCase, so the wire format is
`userName`, not `UserName`):

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

Nullability: the project compiles with nullable reference types enabled elsewhere in the tree, and
these are **non-nullable declarations without `= null!`** — i.e. the C# declarations claim
`userName`/`password` are always present, but the controller re-checks them at runtime
(`AuthController.cs:15-19`) and returns `400` + `ModelState` if empty. `rememberMe` is the only
explicitly nullable member (`bool?`). Treat every one of these as "may be absent on the wire" when
deserializing — the server does.

`Extensions/Signum.Authorization.ResetPassword/ResetPasswordController.cs:39-44`:

```csharp
    public class ForgotPasswordResponse
    { 
        public bool success { get; set; }
        public string message { get; set; }
        public string? title { get; set; }
    }
```

`Extensions/Signum.Authorization.AzureAD/AzureADAuthenticationController.cs:61-65` (public **fields**,
not properties — `IncludeFields = true` is set in the serializer options, §2.1):

```csharp
public class LoginWithAzureADRequest
{
    public string idToken;
    public string accessToken; 
}
```

`Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationController.cs:39-49`:

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

**Wire-format discrepancy to watch:** the TypeScript reference client declares an extra optional
field that the C# DTO does not have (`Extensions/Signum.Authorization/AuthClient.tsx:287-292`):

```ts
    export interface LoginResponse {
      authenticationType: AuthenticationType;
      message?: string;
      token: string;
      userEntity: UserEntity;
    }
```

A CLI must not depend on `message` being present on `LoginResponse` — the framework never sets it.
The `authenticationType` values actually produced by the framework are
`"database" | "resetPassword" | "changePassword" | "api-key" | "relogin" | "cookie" | "azureAD" | "openID" | "windows"`
(union in `AuthClient.tsx:278` plus the literals at `AuthController.cs:79,91,105,155`,
`ResetPasswordController.cs:57`, `AuthLogic.cs:411`, `OpenIDAuthenticationController.cs:20`).
Note `"relogin"` and `"openID"` are **missing from the TS union** — treat the field as an open string.

### 1.2 Error shape

Any endpoint that throws returns `HttpError` as JSON
(`Signum/API/Filters/SignumExceptionFilterAttribute.cs:151-177`):

```csharp
    public string ExceptionType { get; set; }
    public string ExceptionMessage { get; set; }
    public string? ExceptionId { get; set; }
    public string? StackTrace { get; set; }
    public ModelEntity? Model; /*{ get; set; }*/
    public HttpError? InnerException; /*{ get; set; }*/
```

Serialized camelCase → `exceptionType`, `exceptionMessage`, `exceptionId`, `stackTrace`, `model`,
`innerException`. `exceptionType` is the **full CLR type name**, and it is the only reliable
discriminator: the reference client keys off it with
`e.httpError.exceptionType?.endsWith(".AuthenticationException")` (`AuthClient.tsx:177`).
`StackTrace`/`InnerException` are included when `HttpError.IncludeErrorDetails` allows it (default
`e => true`, `SignumExceptionFilterAttribute.cs:153`).

Caveat: the JSON error body is only produced when `ExpectsJsonResult` is true — roughly, when the
action's declared return type is **not** an `IActionResult`
(`SignumExceptionFilterAttribute.cs:112-121`). `api/auth/login` and `api/auth/ChangePassword` return
`ActionResult<LoginResponse>`, so an *unhandled* exception there is **not** rewritten into the JSON
error body and surfaces as a bare ASP.NET 500. (Inference, from that predicate; note that
`ActionResult<T>` does implement `IActionResult`.)

---

## 2. Bearer token lifecycle

File: `Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs`.
Config: `Extensions/Signum.Authorization/AuthToken/AuthTokenConfigration.cs` (filename is misspelled
in the repo).

### 2.1 Exact serialization

The payload type (`AuthTokensServer.cs:264-272`):

```csharp
public class AuthToken
{
    public Lite<IUserEntity> User { get; set; }
    public Dictionary<string, object?> Claims { get; set; }
    public byte[]? PasswordHash { get; set; } //To check if the password has changed
    public DateTime CreationDate { get; set; }

    public UserWithClaims ToUserWithClaims() => new UserWithClaims(this.User, this.Claims);
}
```

Pipeline (`AuthTokensServer.cs:205-228`), in order:

1. `JsonSerializer.Serialize(writer, token, EntityJsonContext.FullJsonSerializerOptions)` — System.Text.Json,
   **camelCase** property naming, `IncludeFields = true`, enums as strings, custom `Lite`/entity
   converters (`Signum/API/Json/EntityJsonContext.cs:13-28`). Property order = declaration order:
   `user`, `claims`, `passwordHash`, `creationDate`.
2. `DeflateStream(CompressionMode.Compress)` — raw **DEFLATE**, no gzip/zlib header.
3. AES encryption (§2.2).
4. `Convert.ToBase64String` — standard Base64 (**not** base64url; may contain `+`, `/`, `=`, so it
   must be URL-encoded if ever placed in a URL — and it should never be placed in a URL, §3.6).

The claims dictionary is filled by `UserWithClaims.FillClaims`; the Authorization module contributes
exactly three (`Extensions/Signum.Authorization/AuthLogic.cs:89-94`):

```csharp
        UserWithClaims.FillClaims += (userWithClaims, user) =>
        {
            userWithClaims.Claims["Role"] = ((UserEntity)user).Role;
            userWithClaims.Claims["Culture"] = ((UserEntity)user).CultureInfo?.Name;
            userWithClaims.Claims["ExternalId"] = ((UserEntity)user).ExternalId;
        };
```

So the token carries the user's **`Lite<RoleEntity>`, culture name, external id, and the raw
password hash bytes**. Other modules may append claims via the same event (inference: any extension
subscribing to `FillClaims`, e.g. isolation-style scoping in an app).

The token is opaque to the client — a CLI must treat it as a byte-identical string and must not
attempt to parse or re-encode it (Base64 padding included).

### 2.2 Crypto

`AuthTokensServer.cs:21-31, 230-261`:

- **Key derivation:** `MD5(UTF8(authTokenEncryptionKey))` → a 16-byte key → **AES-128**.
  ```csharp
        using var md5 = MD5.Create();
        CryptoKey = md5.ComputeHash(Encoding.UTF8.GetBytes(authTokenEncryptionKey.DefaultToNull() ?? throw new ArgumentNullException("AuthTokenEncryptionKey is not set")));
  ```
  The key comes from required app configuration `AuthTokenEncryptionKey`
  (`Signum/API/SignumServer.cs:228`, wired at `Extensions/Signum.Authorization/AuthLogic.cs:513`;
  the upgrade script seeds it into `appsettings.json`,
  `Signum.Upgrade/Upgrades/Upgrade_20230601_Add_AuthTokenEncryptionKeyConfiguration.cs:16`). Missing
  config → startup throws.
- **Mode/padding:** `CipherMode.CBC`, `PaddingMode.PKCS7` (`AuthTokensServer.cs:237-238`).
- **IV:** freshly generated per token by `Aes.Create()` and **prepended as the first 16 bytes** of
  the ciphertext (`AuthTokensServer.cs:241`, read back at `AuthTokensServer.cs:252-256`).
- **Integrity check: none.** There is no MAC, no AEAD, no signature. Integrity is *implicit*: a
  tampered ciphertext fails PKCS7 unpadding or produces invalid DEFLATE/JSON, which throws and is
  then converted into `AuthenticationException("Invalid token")` (`AuthTokensServer.cs:171-175`).
  This is unauthenticated CBC encryption — worth flagging to the security reviewers, but from a
  client's perspective the operational consequence is §2.7.
- Consequence for a CLI: the token is only decryptable by servers configured with the *same*
  `AuthTokenEncryptionKey`. Two environments, or one environment after a key change, cannot read each
  other's tokens.

### 2.3 Expiration and refresh — the precise rules

Configuration surface, complete (`AuthTokenConfigration.cs:1-10`):

```csharp
public class AuthTokenConfigurationEmbedded : EmbeddedEntity
{
    [Unit("mins")]
    public int RefreshTokenEvery { get; set; } = 30;

    [DateInPastValidator]
    public DateTime? RefreshAnyTokenPreviousTo { get; set; }
}
```

- `RefreshTokenEvery` — default **30 minutes**.
- `RefreshAnyTokenPreviousTo` — default **null**; a manual "rotate everything issued before X" lever.

These live in the *application's* configuration entity (the framework only takes a
`Func<AuthTokenConfigurationEmbedded>`, `AuthTokensServer.cs:17,21`; `AuthLogic.StartAllModules`
passes it through, `AuthLogic.cs:504-513`). It is DB-backed embedded config, so an admin can change
`RefreshTokenEvery` at runtime and the change takes effect on the next request (inference from the
`Func<>` indirection: it is evaluated per request at `AuthTokensServer.cs:76`).

The limit date (`AuthTokensServer.cs:64`):

```csharp
    public static DateTime GetTokenLimitDate() => Clock.Now.AddMinutes(-Configuration().RefreshTokenEvery);
```

The refresh predicate — this is the authoritative rule (`AuthTokensServer.cs:85-94`):

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

Therefore:

- **There is no hard expiry.** A token older than `RefreshTokenEvery` is *still accepted*; the server
  transparently revalidates against the DB and issues a replacement. The request succeeds.
- The replacement is returned in the response header **`New_Token`** (exact spelling, underscore,
  capital N and T — `AuthTokensServer.cs:92`). It is the raw token string, **not** prefixed with
  `Bearer`.
- `?refreshToken` **as a bare query key on any request** forces rotation — the code checks
  `ContainsKey`, so `?refreshToken` with no value is enough; the TS client sends
  `?refreshToken=true` (`AuthClient.tsx:319`).
- **If the client ignores `New_Token`:** nothing breaks immediately. The old token keeps working
  indefinitely, but *every* subsequent request re-runs `RefreshToken` → a `Database.Query<UserEntity>`
  round-trip plus a token re-serialization per request (`AuthTokensServer.cs:104-137`), and the
  client's effective identity/claims (notably **role**) stay frozen at the old token's contents
  forever (§2.4). It is a correctness and performance bug, not an outage. The reference client
  handles it by swapping the stored token and re-fetching the user (`AuthClient.tsx:165-174`):

  ```ts
      return makeCall()
        .then(r => {
          var newToken = r.headers.get("New_Token");
          if (newToken) {
            setAuthToken(newToken, getAuthenticationType());
            API.fetchCurrentUser()
              .then(cu => setCurrentUser(cu));
          }
  ```

- **Future-dated tokens are rejected**, with a 2-second skew tolerance
  (`AuthTokensServer.cs:82-83`):
  ```csharp
        if (Clock.Now.AddSeconds(2) < token.CreationDate)
            throw new AuthenticationException(LoginAuthMessage.InvalidTokenDate0.NiceToString(token.CreationDate));
  ```
  Relevant when several app servers behind a load balancer have skewed clocks: a token minted on the
  fast server can be rejected by the slow one (403).

### 2.4 What invalidates a token server-side

There is **no token blacklist and no `logout` server-side revocation** (`AuthController.cs:115-121`
only clears the cookie). Invalidation happens exclusively inside `RefreshToken`, i.e. **only once the
token is old enough (or `?refreshToken` is passed) to trigger the refresh path**. Verbatim
(`AuthTokensServer.cs:104-118`):

```csharp
    public static string RefreshToken(AuthToken oldToken, out UserWithClaims newUser)
    {
        var user = AuthLogic.Disable().Using(_ => Database.Query<UserEntity>().SingleOrDefaultEx(u => u.Id == oldToken.User.Id));

        if (user == null)
            throw new AuthenticationException(LoginAuthMessage.TheUserIsNotLongerInTheDatabase.NiceToString());

        if (user.State != UserState.Active)
            throw new AuthenticationException(LoginAuthMessage.User0IsDeactivated.NiceToString(user));

        if (user.ToString() != oldToken.User.ToString())
            throw new AuthenticationException(LoginAuthMessage.InvalidUsername.NiceToString());

        if (!(user.PasswordHash.EmptyIfNull()).SequenceEqual((oldToken.PasswordHash.EmptyIfNull()).EmptyIfNull()))
            throw new AuthenticationException(LoginAuthMessage.InvalidPassword.NiceToString());
```

So, on the refresh path, a token dies if: the user row was deleted; `State != Active`; the user's
`ToString()` (i.e. **UserName**) changed; or the **PasswordHash changed** (password change, reset, or
admin-set password). All four surface as `AuthenticationException` → **403**.

Independently of the refresh path, one check runs on **every** request
(`AuthTokensServer.cs:78-80`):

```csharp
        var userDisabled = AuthLogic.RecentlyUsersDisabled.Value.Contains(token!.User);
        if (userDisabled)
            throw new AuthenticationException(LoginAuthMessage.User0IsDeactivated.NiceToString(token!.User));
```

`RecentlyUsersDisabled` is a `GlobalLazy` over
(`Extensions/Signum.Authorization/AuthLogic.cs:97-98`):

```csharp
        RecentlyUsersDisabled = sb.GlobalLazy(() => Database.Query<UserEntity>().Where(u => u.DisabledOn != null && AuthTokenServer.GetTokenLimitDate() < u.DisabledOn).Select(a => a.ToLite()).ToHashSet(),
         new InvalidateWith(null));
```

i.e. users disabled *within the last `RefreshTokenEvery` minutes* — the window during which a still-
"fresh" token would otherwise skip the DB revalidation. Note `new InvalidateWith(null)` means
**no automatic invalidation** (`Signum/Engine/GlobalLazy.cs:8-11,13-27` — `Types` becomes empty, and
`SchemaBuilder.AttachInvalidations` then attaches nothing,
`Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:1246-1275`). It is reset explicitly by the
deactivate/reactivate operations (`Extensions/Signum.Authorization/UserGraph.cs:35,50,64`:
`AuthLogic.RecentlyUsersDisabled.Reset()`), which is an **in-process** reset — on a multi-server
deployment the other servers keep the stale set until their own cache invalidation fires (inference,
based on `InvalidateWith(null)` + in-process `ResetLazy.Reset()`; a distributed cache-invalidation
extension such as `Signum.Caching` could change this).

**Role and permission changes do NOT invalidate a token.** The role used for every authorization
decision comes out of the token's claims, not the DB (`Extensions/Signum.Authorization/RoleEntity.cs:25-35`):

```csharp
    public static Lite<RoleEntity> Current
    {
        get
        {
            var userHolder = UserHolder.Current;
            if (userHolder == null)
                throw new AuthenticationException(LoginAuthMessage.NotUserLogged.NiceToString());

            return (Lite<RoleEntity>)userHolder.GetClaim("Role")!;
        }
    }
```

So moving a user to a different role takes effect only after the next token rotation — up to
`RefreshTokenEvery` (default 30 min) later, or immediately if the client sends `?refreshToken`.
(Changing the *rules attached to a role* is different: the rule caches are DB-backed and invalidate
on save, `Extensions/Signum.Authorization/Rules/AuthCache.cs` + `AuthLogic.OnRulesChanged`
→ `ReflectionServer.InvalidateCache` at `AuthServer.cs:53`, so rule edits are effective immediately.)

**Deployment / key rotation:** because the key is `MD5(AuthTokenEncryptionKey)` from static config,
changing that config value (or deploying to an environment with a different one) makes every existing
token undecryptable → §2.7 silent degradation, *not* a clean 403 with a useful message. A CLI can
detect a deployment via the `X-App-Version` / `X-App-BuildTime` response headers that every action
emits (`Signum/API/Filters/VersionFilterAttribute.cs:26-27`).

There is also a hook `AuthTokenServer.AuthenticateHeader` (`AuthTokensServer.cs:19`, default
`_ => true`) that an app can use to reject headers wholesale — apps may add their own predicate, so
a CLI should not assume the framework default.

### 2.5 Header name

`AuthTokensServer.cs:57-62`:

```csharp
    public static string AuthHeader = "Authorization";

    public static void PrepareForWindowsAuthentication()
    {
        AuthHeader = "Signum_Authorization";
    }
```

Scheme prefix is `Bearer ` with a single space; the server extracts with
`authHeader.After("Bearer ")` (`AuthTokensServer.cs:144`) — so the prefix is **case-sensitive** and
mandatory. `After` returns the remainder after the first occurrence; if `"Bearer "` is absent the
extraction fails and the token is treated as invalid (§2.7).

If the target app calls `PrepareForWindowsAuthentication()`, the CLI must send
`Signum_Authorization: Bearer …` instead. A CLI should make the header name configurable, and can
probe: send the token in `Authorization` and, if the response behaves as anonymous, retry with
`Signum_Authorization`. (Inference — there is no endpoint that advertises which header is in use.)

### 2.6 The authenticator ladder (order matters)

`SignumAuthenticationFilter` walks a list and takes the **first non-null** result
(`Signum/API/Filters/SignumFilters.cs:43-55`). Registration order:

1. `ApiKeyAuthenticator` — **inserted at index 0** (`Extensions/Signum.Rest/RestApiKeyServer.cs:19`:
   `SignumAuthenticationFilter.Authenticators.Insert(0, ApiKeyAuthenticator);`) — so **an API key
   wins over a bearer token** if both are present.
2. `TokenAuthenticator`
3. `AnonymousUserAuthenticator`
4. `AllowAnonymousAuthenticator`
5. `InvalidAuthenticator`

(all four registered in `AuthTokensServer.cs:27-30`.)

Consequences:

- `AnonymousUserAuthenticator` is checked **before** `AllowAnonymousAuthenticator`
  (`AuthTokensServer.cs:39-45`). If the app configures an anonymous user
  (`AuthLogic.Start(sb, systemUserName, anonymousUserName)`, `AuthLogic.cs:77-83`), then *any*
  unauthenticated request — including one carrying a broken token — is silently executed **as the
  anonymous user**, and will typically fail later with authorization-shaped errors rather than
  auth-shaped ones.
- If no anonymous user is configured and the endpoint is not `[SignumAllowAnonymous]`,
  `InvalidAuthenticator` throws (`AuthTokensServer.cs:34-37`):
  ```csharp
        throw new AuthenticationException("No authentication information found!");
  ```
  → **403** with `exceptionType = "System.Security.Authentication.AuthenticationException"`.

### 2.7 Expired vs. malformed vs. tampered — exact outcomes

| Condition | Code path | Result |
|---|---|---|
| Valid, fresh (< `RefreshTokenEvery` old) | `AuthTokensServer.cs:96-100` | 200, no `New_Token` header |
| Valid but stale, user still OK | `AuthTokensServer.cs:90-94` | **200** + `New_Token` header. Not an error. |
| Stale + user deleted / deactivated / renamed / password changed | `AuthTokensServer.cs:106-118` | **403**, `AuthenticationException`, message from `LoginAuthMessage` (localized) |
| User disabled within the refresh window | `AuthTokensServer.cs:78-80` | **403**, `AuthenticationException` |
| `CreationDate` more than 2 s in the future | `AuthTokensServer.cs:82-83` | **403**, `AuthenticationException` |
| **Malformed** Base64 / bad padding / not DEFLATE / bad JSON | `DeserializeToken` throws `AuthenticationException("Invalid token")` (`AuthTokensServer.cs:153-176`), which `DeserializeAuthHeaderToken` **catches and returns null** (`AuthTokensServer.cs:140-151`) | `TokenAuthenticator` returns null → ladder falls through → **anonymous user, or 403 "No authentication information found!"**. The specific "Invalid token" message is **never surfaced**. |
| **Tampered** ciphertext | same as malformed (no MAC; failure manifests as unpad/inflate/JSON error) | same silent fallthrough |
| Wrong `AuthTokenEncryptionKey` (redeploy/key change/wrong environment) | same | same silent fallthrough |
| Missing `Bearer ` prefix, or wrong header name | `authHeader.After("Bearer ")` yields nothing usable → decode fails | same silent fallthrough |
| Token whose `User` lite is null after deserialization | `AuthTokensServer.cs:72-73` | returns null → same fallthrough |

**This is the critical trap for a CLI:** a corrupted/stale-key credential does not produce
"unauthenticated"; it produces "acting as somebody else (anonymous), or a generic 403 whose message
does not mention tokens". A CLI must therefore verify identity explicitly after loading a stored
token — call `GET api/auth/currentUser` and assert a non-null user — rather than assuming a 200 means
its token was accepted.

### 2.8 Binding

The token is bound to **nothing** except its own contents:

- No IP binding, no User-Agent binding, no session/nonce, no `jti`, no audience/issuer
  (`AuthToken` has exactly the four members in §2.1).
- No server-side session state at all — verification is pure decrypt + compare (`AuthTokensServer.cs:66-102`).
- Effectively bound to: the encryption key, the user id, the username, and the password hash.

It is therefore a **fully portable bearer credential**: exfiltrating it is equivalent to exfiltrating
the password for as long as the password is unchanged. It must be stored with the same care as a
password (§5).

### 2.9 The `rememberMe` ticket cookie (adjacent, mostly not for a CLI)

`POST api/auth/login` with `rememberMe: true` calls `UserTicketServer.OnSaveCookie`
(`AuthController.cs:62-65`), which sets cookie **`sfUser`**
(`Extensions/Signum.Authorization/UserTicket/UserTicketServer.cs:10-11`) with value
`"{userId}|{guid}"` (`UserTicket/UserTicket.cs:18-21`), `Expires = now + 60 days`
(`UserTicketLogic.ExpirationInterval = TimeSpan.FromDays(60)`, `UserTicketLogic.cs:5`).
Max **4** tickets per user (`UserTicketLogic.cs:6`); the ticket is **rotated on every use**
(`UserTicketServer.cs:25-33` → `UserTicketLogic.UpdateTicket`, `UserTicketLogic.cs:78-100`); the
"device" recorded is the caller's IP (`UserTicketServer.cs:25`, `:63`); an unknown ticket throws
`UnauthorizedAccessException("User attempted to log-in with an invalid ticket")`
(`UserTicketLogic.cs:92-95`) → 403. All tickets are deleted when the password changes
(`UserTicketLogic.cs:36-47`) and on deactivation (`UserTicketLogic.cs:29`,
`UserGraph.cs:51`).

For a CLI this is a *worse* credential than the token (cookie jar, IP-recorded, rotates on every
call, capped at 4 concurrent) with the single advantage of a documented 60-day life. Recommendation:
do not use it; prefer API key (long-lived, §3) or token + re-login.

---

## 3. API key lifecycle

### 3.1 Entity and generation

`Extensions/Signum.Rest/RestApiKeyEntity.cs:1-25` — the whole entity:

```csharp
[EntityKind(EntityKind.Main, EntityData.Master)]
public class RestApiKeyEntity : Entity
{   
    public Lite<UserEntity> User { get; set; }

    [StringLengthValidator(Min = 20, Max = 100)]
    [UniqueIndex]
    public string ApiKey { get; set; }
}

[AutoInit]
public static class RestApiKeyOperation
{
    public static ExecuteSymbol<RestApiKeyEntity> Save;
    public static DeleteSymbol<RestApiKeyEntity> Delete;
}
```

Two fields. **No expiry column, no name/description, no scope, no created/last-used timestamp, no
revoked flag.** Length is validated 20–100 chars, uniqueness enforced by index.

Generation (`Extensions/Signum.Rest/RestApiKeyLogic.cs:41-46`):

```csharp
    private static string DefaultGenerateRestApiKey()
    {
        byte[] tokenData = new byte[32];
        RandomNumberGenerator.Create().GetBytes(tokenData);
        return WebEncoders.Base64UrlEncode(tokenData);
    }
```

256 bits of CSPRNG entropy, **base64url** (URL-safe, no padding) → 43 chars. Overridable via
`RestApiKeyLogic.GenerateRestApiKey` (`RestApiKeyLogic.cs:13`).

**Storage: plaintext in the database column.** There is no hashing — the key is stored as given and
compared by dictionary lookup, and `GET api/restApiKey/current` reads it back out
(`RestApiKeyController.cs:14-19`). Anyone with read access to `RestApiKeyEntity` (or to that
endpoint, for their own key) sees the live secret.

### 3.2 Lookup and cache invalidation

`RestApiKeyLogic.cs:9-39`:

```csharp
    public readonly static string ApiKeyQueryParameter = "apiKey";
    public readonly static string ApiKeyHeader = "X-ApiKey";

    public static ResetLazy<FrozenDictionary<string, RestApiKeyEntity>> RestApiKeyCache = null!;
```

```csharp
        RestApiKeyCache = sb.GlobalLazy(() =>
        {
            return Database.Query<RestApiKeyEntity>().ToFrozenDictionaryEx(rak => rak.ApiKey);
        }, new InvalidateWith(typeof(RestApiKeyEntity)));
```

- **All keys are held in memory**, keyed by the plaintext key, in a `FrozenDictionary`.
- The cache **is** invalidated on change: `InvalidateWith(typeof(RestApiKeyEntity))` attaches to that
  table's save/delete events and resets the lazy on `Transaction.PostRealCommit`
  (`Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:1246-1275`), plus on any *dependent* table
  (`:1268-1274`). This is an **in-process** reset; cross-server invalidation depends on the app also
  running a distributed cache-invalidation mechanism (inference — nothing in `RestApiKeyLogic`
  broadcasts). Practical effect: revoking a key may not take effect on other app servers until their
  caches reset or the process recycles.

Authentication itself (`Extensions/Signum.Rest/RestApiKeyServer.cs:23-44`):

```csharp
    public static SignumAuthenticationResult? ApiKeyAuthenticator(HttpContext httpCtx)
    {
        httpCtx.Request.Query.TryGetValue(RestApiKeyLogic.ApiKeyQueryParameter, out var val);
        httpCtx.Request.Headers.TryGetValue(RestApiKeyLogic.ApiKeyHeader, out var headerKeys);

        var keys = val.Distinct().Union(headerKeys.Distinct()).NotNull().ToList()!;

        if (keys.Count == 1)
        {
            using (AuthLogic.Disable())
            {
                var user = RestApiKeyLogic.RestApiKeyCache.Value.GetOrThrow(keys.Single(), $"Could not authenticate with the API Key {keys.Single()}.").User.RetrieveAndRemember();
                return new SignumAuthenticationResult { UserWithClaims = new UserWithClaims(user) };
            }
        }
        else if (keys.Count() > 1)
        {
            throw new AuthenticationException("Request contains multiple API Keys. Please use a single API Key per request for authentication.");
        }

        return null;
    }
```

Notes a client must respect:

- Accepted **either** as header `X-ApiKey: YOUR_API_KEY_HERE` **or** as query parameter
  `?apiKey=YOUR_API_KEY_HERE`. Prefer the header (§3.6).
- Sending **two different** keys — including "same key in header and query" if the values differ, or
  a duplicated query param — throws `AuthenticationException` → **403**. (Sending the *identical*
  value in both places is fine: `.Distinct().Union(...)` collapses it to one.)
- An **unknown** key raises `KeyNotFoundException` via `GetOrThrow`
  (`Signum.Utilities/Extensions/DictionaryExtensions.cs:103-109`), which is **not** in
  `GetStatus`'s list → **HTTP 500 InternalServerError**, and the error message
  **echoes the submitted key back to the caller** and into the exception log. So: *invalid API key =
  500, not 403.* A CLI's error mapping must special-case this.
- **No user state check.** Unlike the token path, `ApiKeyAuthenticator` never calls
  `AuthLogic.CheckUserActive` and never consults `RecentlyUsersDisabled`. Deactivating a user does
  **not** disable their API key. Only deleting the `RestApiKeyEntity` does.
- `.User.RetrieveAndRemember()` caches the resolved `UserEntity` **onto the `Lite` stored inside the
  cached dictionary** (`Signum/Engine/Database.cs:84-93`), so the user snapshot (including `Role`
  and `State`) is reused for the lifetime of the API-key cache. A role change for an API-key user is
  therefore also stale until the `RestApiKeyEntity` cache is reset. (Inference from
  `RetrieveAndRemember` semantics + the cache holding the same `Lite` instances.)

### 3.3 Provisioning: what an admin needs, and can a user self-serve?

Registration (`RestApiKeyLogic.cs:20-29`) uses the standard fluent `WithSave` / `WithDelete`, so
creating a key requires:

1. `TypeAllowed` **Write** on `RestApiKeyEntity` for the caller's role (`TypeAuthLogic`), and
2. the `RestApiKeyOperation.Save` operation allowed for that role on that type
   (`OperationAuthLogic`), and
3. write access to the `RestApiKeyEntity.User` property (`PropertyAuthLogic`) — which is what makes
   "issue a key for *another* user" possible or not.

Deleting (revoking) requires Write + `RestApiKeyOperation.Delete`.

There is **no dedicated `PermissionSymbol`** for API keys anywhere in `Signum.Rest` — grep of the
module shows only `RestApiKeyOperation.Save/Delete` and `RestApiKeyMessage.GenerateApiKey`
(`RestApiKeyEntity.cs:15-25`). So the gate is *entirely* the ordinary type/operation authorization
model, configured per role in `api/authAdmin/*`. There is no framework-level "admin only" rule:
**whether a user can self-provision depends purely on whether their role has Write +
`RestApiKeyOperation.Save` on `RestApiKeyEntity`.** In a default Signum app that is an admin-only
setup by convention, not by code.

The two controller endpoints have **no permission checks at all**
(`Extensions/Signum.Rest/RestApiKeyController.cs`, whole file):

```csharp
public class RestApiKeyController : ControllerBase
{
    [HttpGet("api/restApiKey/generate")]
    public string GenerateRestApiKey()
    {
        return RestApiKeyLogic.GenerateRestApiKey();
    }

    [HttpGet("api/restApiKey/current")]
    public string? GetAPIKey()
    {
        using (ExecutionMode.Global())
            return Database.Query<RestApiKeyEntity>().Where(a => a.User.Is(UserEntity.Current)).Select(a => a.ApiKey).SingleOrDefault();
    }
}
```

- `generate` is a pure random-string generator — it does **not** persist anything, so calling it
  grants nothing. Persisting still needs the Save operation.
- `current` runs inside `ExecutionMode.Global()`, which **bypasses the authorization rules**
  (`TypeAuthLogic`/`QueryAuthLogic` short-circuit on `ExecutionMode.InGlobal`, e.g.
  `Rules/QueryAuthLogic.cs:75-79`, `Rules/OperationAuthLogic.cs:145-146`,
  `Rules/PermissionAuthLogic.cs:59-60`). So **any authenticated user can read their own API key**
  regardless of whether their role has read access to `RestApiKeyEntity`. Useful for a CLI
  (`signum login` → fetch own key), and worth flagging to security review.
- `SingleOrDefault()` means: if a user somehow has **two** keys, `api/restApiKey/current` **throws**
  (an `InvalidOperationException`-family error → 500). Effectively one key per user via this path.

### 3.4 Expiry, rotation, revocation, scoping, rate limiting

- **Expiry:** none. No date column, no check.
- **Rotation:** not modelled. Rotation = save a new key value (or a new row) and delete the old.
  Because `api/restApiKey/current` uses `SingleOrDefault`, overlapping old+new keys for one user
  breaks that endpoint — so zero-downtime rotation needs care (create second row → switch clients →
  delete first row, during which `current` is broken). (Inference from `SingleOrDefault`.)
- **Revocation:** delete the row (`RestApiKeyOperation.Delete`). Effect is subject to the cache
  invalidation caveat in §3.2. Deactivating the user does **not** revoke (§3.2).
- **Scoping:** none beyond "this key = this user". No per-endpoint, per-type or read-only scoping,
  and no way to make a key weaker than its user.
- **Rate limiting / throttling:** none anywhere in the framework — a grep for
  `ratelimit|rate limit|throttle` across all `.cs` files returns zero hits.

### 3.5 What does a key resolve to?

`new UserWithClaims(user)` from the row's `User` lite (`RestApiKeyServer.cs:34-35`) — i.e. **the full
user identity**, with `Claims["Role"]` filled from that user's role (`AuthLogic.cs:89-94`).
Every type/property/query/operation/permission rule of that role applies, unchanged. An API key is
therefore exactly as powerful as the user's password, with the differences that it (a) never expires,
(b) survives password changes, (c) survives user deactivation, and (d) is stored in plaintext.

A key can also be traded for a bearer token: `GET api/auth/loginFromApiKey` returns a
`LoginResponse` with a fresh token (`AuthController.cs:72-80`). Handy if a CLI wants to avoid putting
the long-lived secret on every request — but the token then goes stale w.r.t. role changes (§2.4).

### 3.6 What is persisted per request — `RestLogFilter` / `RestLogLogic`

`RestLogFilter` is an `ActionFilterAttribute` (`Extensions/Signum.Rest/RestLogFilter.cs:9-21`) with
`AllowReplay`, `IgnoreRequestBody`, `IgnoreResponseBody` switches. It is **opt-in per action** — a
grep shows no `[RestLogFilter]` usage anywhere in the framework, so it only applies to endpoints the
*application* decorates (typically its public REST surface). It is **not** applied to `api/auth/*`
by the framework.

Where applied, the persisted fields are exactly (`RestLogFilter.cs:36-57` and
`Extensions/Signum.Rest/RestLog.cs:6-72`):

```csharp
            var queryParams = context.HttpContext.Request.Query
                 .Select(a => new QueryStringValueEmbedded { Key = a.Key, Value = a.Value.ToString() })
                 .ToMList();

            var restLog = new RestLogEntity
            {
                AllowReplay = this.AllowReplay,
                HttpMethod = request.Method.ToString(),
                Url = request.Path.ToString(),
                QueryString = queryParams,
                User = UserHolder.Current?.User,
                Controller = context.Controller.GetType().FullName!,
                ControllerName = context.Controller.GetType().Name,
                Action = ((ControllerActionDescriptor)context.ActionDescriptor).ActionName,
                MachineName = System.Environment.MachineName,
                ApplicationName = AppDomain.CurrentDomain.FriendlyName,
                StartDate = Clock.Now,
                UserHostAddress = connection.RemoteIpAddress!.ToString(),
                UserHostName = request.Host.Value,
                Referrer = request.Headers["Referrer"].ToString(),
                RequestBody = { Text = IgnoreRequestBody ? null : await GetRequestBody(context.HttpContext.Request) },
            };
```

plus, on the way out: `EndDate`, `ResponseBody.Text` (full response body, unless
`IgnoreResponseBody`), `Exception` lite (`RestLogFilter.cs:106-138`).

Answering the specific questions:

- **URL:** `request.Path` only — no scheme/host/query in `Url`.
- **Query string: YES**, every key/value pair, each as a `QueryStringValueEmbedded` with
  `DbType(Size = MaxValue)` (`RestLog.cs:74-81`), `[PreserveOrder]`. Values are **not** redacted or
  filtered. So `?apiKey=YOUR_API_KEY_HERE` lands in the DB verbatim, readable by anyone with read
  access to `RestLogEntity`.
- **Request body: YES, by default.** `RequestBody` is a `BigStringEmbedded` populated unless the
  action sets `IgnoreRequestBody = true` (`RestLogFilter.cs:20,56`, `RestLog.cs:25-26`). This means
  password-in-body is *also* a logging risk on any application endpoint that opts into
  `RestLogFilter` — it is only safe for `api/auth/login` because the framework does not decorate
  that action.
- **Response body: YES, by default** (`RestLogFilter.cs:115-124`) — so a logged
  `api/auth/login`-shaped endpoint would persist the issued **token** as well.
- **Headers: NO** — with one exception: `Referrer` is captured (`RestLogFilter.cs:55`, note the
  non-standard double-r spelling; the real HTTP header is `Referer`, so this will usually be empty).
  `X-ApiKey` and `Authorization` are **not** persisted by `RestLogFilter`.

**The bigger logging exposure is the global exception filter**, which applies to *every* action
(`Signum/API/SignumServer.cs:60`). On any logged exception it persists
(`Signum/API/Filters/SignumExceptionFilterAttribute.cs:82-96`):

```csharp
                e.UserAgent = Try(300, () => req.Headers["User-Agent"].FirstOrDefault());
                e.RequestUrl = Try(int.MaxValue, () => req.GetDisplayUrl());
                e.UrlReferer = Try(int.MaxValue, () => req.Headers["Referer"].ToString());
                e.UserHostAddress = Try(100, () => connFeature.RemoteIpAddress?.ToString());
                ...
                e.QueryString = new BigStringEmbedded(Try(int.MaxValue, () => req.QueryString.ToString()));
                e.Form = new BigStringEmbedded(Try(int.MaxValue, () => Encoding.UTF8.GetString(body)));
```

with matching columns on `ExceptionEntity` (`Signum/Basics/Exception.cs:86,89,113,116`). So on **any**
failing request, on **any** endpoint:

- the **full URL including query string** is stored twice (`RequestUrl`, `QueryString`) → an API key
  passed as `?apiKey=` is persisted;
- the **entire request body** is stored in `Form` → a failing `POST api/auth/login` persists
  `{"userName":"…","password":"…"}` in cleartext;
- `User-Agent` is stored (so don't put anything sensitive in a custom UA);
- `Authorization` / `X-ApiKey` headers are **not** stored.

Note the login controller catches its own auth failures and returns `400` instead of throwing
(`AuthController.cs:31-54`), so *ordinary* wrong-password attempts do not hit this path; an
*unexpected* failure (DB error, validation aggregate from `ValidateModelFilterAttribute.cs:22-23`,
failure inside `AddUserSession`/`CreateToken`) does. Treat "password may be persisted on error" as
a real risk, not a theoretical one.

**Rule for the CLI: never put a credential in a URL.** Header-only, always.

### 3.7 Replay endpoint — a note for security review

`GET api/restLog/?id=…&url=…` (`Extensions/Signum.Rest/RestLogController.cs:8-21`) loads a
`RestLogEntity`, looks up **the API key of the user who made the original request**, and re-sends the
logged request body to the **caller-supplied `url`** with `X-ApiKey` attached
(`RestLogLogic.cs:53-82`). There is no permission attribute on the controller (only the implicit
`Database.Retrieve<RestLogEntity>` type check) and no allow-list on `url`. Anyone who can read one
`RestLogEntity` with `AllowReplay = true` can exfiltrate that user's API key to an arbitrary host.
Flagging per the org's security-review obligation; a CLI should never expose this endpoint.

---

## 4. Authorization model a CLI must respect (context)

Five independent rule caches keyed on `RoleEntity.Current` (which comes from the token claim, §2.4).
Each has the same escape hatch: `if (!AuthLogic.IsEnabled || ExecutionMode.InGlobal) return <allow>`.

**Type / row level — silent.** `TypeAuthLogic` installs a query filter per entity type
(`Extensions/Signum.Authorization/Rules/TypeAuthLogic.cs:105`:
`schema.EntityEvents<T>().FilterQuery += new FilterQueryEventHandler<T>(TypeAuthLogic_FilterQuery<T>);`)
and a retrieve hook (`TypeAuthLogic.cs:26`, `:215`). Rows the role may not read are **silently
omitted** from query results — no error, no count adjustment, no indication. Direct retrieval of a
forbidden entity *does* throw `UnauthorizedAccessException`
(`Rules/TypeAuthLogic.Conditions.cs:197,207,216`) → **403**. So a CLI can never distinguish
"no such record" from "not allowed to see it" in a list, and must not treat an empty result as
authoritative.

**Query (name) level — throws.** `Extensions/Signum.Authorization/Rules/QueryAuthLogic.cs:24,45-49`
hooks `QueryLogic.Queries.AllowQuery`, and the container asserts
(`Signum/DynamicQuery/DynamicQueryContainer.cs:205-208`):

```csharp
    public void AssertQueryAllowed(object queryName, bool fullScreen)
    {
        if (!QueryAllowed(queryName, fullScreen))
            throw new UnauthorizedAccessException("Access to query {0} not allowed {1}".FormatWith(queryName, QueryAllowed(queryName, false) ? " for full screen" : ""));
```

→ **403** with a message distinguishing "not allowed at all" from "not allowed *for full screen*"
(`QueryAllowed.EmbeddedOnly`). So: **querying a forbidden query name throws, it does not return
empty.** Note the tri-state: `Allow` / `EmbeddedOnly` / `None`
(`AuthServer.cs:149-155`); `EmbeddedOnly` means the query works only in non-fullScreen contexts.

**Property level — mixed.** `PropertyAuthLogic` hooks the JSON converter: unreadable properties are
**omitted / hidden** from serialization and unwritable ones are rejected with an explicit message
(`AuthServer.cs:228-268`) — `"Not Allowed to Read " + …` / `"Not Allowed to Write " + …`, and
`PropertyMetadata.Hidden` / `ReadOnly` in metadata. So reads degrade silently, writes fail loudly.

**Operation level — vanishes.** `Signum/Operations/OperationLogic.cs:445-469`:

```csharp
                var result = (from o in TypeOperations(entityType)
                              let eo = o as IEntityOperation
                              where eo != null && (eo.CanBeNew || !entity.IsNew) && OperationAllowed(o.OperationSymbol, entityType, true, entity)
                              select KeyValuePair.Create(eo.OperationSymbol, eo.CanExecute(entity))).ToDictionary();
```

The authorization check is in the `where` clause. Therefore, in `EntityPackTS.canExecute`
(`Signum/API/SignumServer.cs:123-126,188-198`, a `Dictionary<string, string?>`):

- an operation the role may not execute is **absent from the dictionary entirely** — no key, no
  reason;
- an operation the role *may* execute but whose business rules currently block it is **present with a
  non-null string reason**;
- an executable operation is **present with `null`**.

So `canExecute` conflates "not permitted" with "operation does not exist on this type", and a CLI
**cannot** distinguish them. `canExecute` is a usable capability list for "what can I do right now",
but not a diagnosis of *why not*. Attempting a forbidden operation anyway throws
`UnauthorizedAccessException` → 403.

**Permission level — boolean + vanishing metadata.**
`Rules/PermissionAuthLogic.cs:41-47,55-63`: `IsAuthorized` returns bool; the assert path yields
`"Permission '{0}' is denied"`. And in the reflection metadata, denied `PermissionSymbol` fields are
**dropped** (`AuthServer.cs:286-301`, `return null`).

**Metadata as a capability list.** `api/reflection/types` is filtered by role: types with
`MaxUI() == None` disappear, `queryDefined` is cleared for `QueryAllowed.None`, disallowed operations
and permission symbols return `null` (i.e. are omitted), and `typeAllowed` / `minTypeAllowed` /
`maxTypeAllowed` / `queryAllowed` / `propertyAllowed` extensions are injected
(`AuthServer.cs:55-301`). The metadata cache is invalidated on rule changes
(`AuthServer.cs:53`: `AuthLogic.OnRulesChanged += ReflectionServer.InvalidateCache;`).

Net verdict for a CLI: **metadata is a good positive capability list** (if a type/query/operation is
present, the role has *some* access) but a **poor negative one** — absence conflates "no permission",
"not registered", and "namespace not visible" (`AuthServer.cs:98-108, 369-393`). And it is computed
for the role *in the current token*, so it goes stale exactly like the role does (§2.4). Never cache
metadata across a `New_Token` rotation without re-fetching.

---

## 5. What a CLI must implement — checklist

**Headers (exact strings).**

- [ ] `Authorization: Bearer YOUR_BEARER_TOKEN_HERE` — one space, case-sensitive `Bearer`
      (`AuthTokensServer.cs:144`). Make the header name configurable: it becomes
      `Signum_Authorization` if the server calls `PrepareForWindowsAuthentication()`
      (`AuthTokensServer.cs:57-62`).
- [ ] `X-ApiKey: YOUR_API_KEY_HERE` for key auth (`RestApiKeyLogic.cs:10`). Never
      `?apiKey=` (§3.6). Never send two different keys in one request (403,
      `RestApiKeyServer.cs:38-41`).
- [ ] Never send an API key **and** a bearer token together: the API key wins
      (`RestApiKeyServer.cs:19` inserts at index 0), which silently changes which
      invalidation/staleness rules apply.
- [ ] `Content-Type: application/json` for all POSTs; property names are **camelCase**
      (`EntityJsonContext.cs:15`).

**Token storage.**

- [ ] Treat the token as password-equivalent: it embeds the password hash and is portable — no IP,
      UA, or session binding (§2.8). Store with 0600 file perms or an OS keychain; never in shell
      history, env vars visible to `ps`, or logs.
- [ ] Store it byte-exact (standard Base64, includes `+ / =`). Do not trim, re-encode, or
      URL-encode-in-place.
- [ ] Store the `authenticationType` alongside it (the reference client does,
      `AuthClient.tsx:196-200`) — it tells you which re-login flow to retry.
- [ ] Consider **not** persisting tokens at all for interactive use and instead persisting only an
      API key; but note an API key is *more* dangerous (never expires, survives password change and
      deactivation, §3.2).

**Rotation handling (mandatory — omitting it is a silent failure).**

- [ ] After **every** response, read header `New_Token`; if non-empty, atomically replace the stored
      token (`AuthTokensServer.cs:92`). It is the bare token, no `Bearer` prefix.
- [ ] Do this for **all** responses, including error responses and streamed/file responses — the
      header is set during authentication, before the action runs.
- [ ] Long-running CLI processes: a token in flight on parallel requests can produce several
      `New_Token` values; last-write-wins is fine (all are independently valid), but writes to the
      token file must be serialized/atomic.
- [ ] After adopting a new token, re-fetch identity and re-fetch metadata if you cache it — the role
      claim may have changed (§2.4, `AuthClient.tsx:167-172`).
- [ ] To force a refresh (e.g. after an admin says "I changed your role"), append `?refreshToken=true`
      to any GET — a bare `?refreshToken` also works (`AuthTokensServer.cs:88`).

**Error / status mapping.**

| Status | Meaning here | Client action |
|---|---|---|
| **403** + `exceptionType` ends with `.AuthenticationException` | token rejected: user deleted/deactivated/renamed, password changed, future-dated, or no auth info found | discard stored token, re-authenticate, retry once |
| **403** + `exceptionType` ends with `.UnauthorizedAccessException` | authorization: type/query/operation/entity not allowed | do **not** retry; surface as permission error |
| **500** with message `Could not authenticate with the API Key …` | **invalid API key** (`KeyNotFoundException`, `RestApiKeyServer.cs:34`) | treat as an auth failure, not a server fault; do not retry |
| **403** `Request contains multiple API Keys…` | client sent conflicting keys | client bug |
| **400** with an ASP.NET `ModelState` body (`{"field":["msg"]}`) | login/change-password validation, wrong username/password | surface field errors; do not retry |
| **200** with `null` body on `loginFromCookie` | no/invalid ticket cookie | fall through to next auth method |
| **200** with `success:false` on `forgotPasswordEmail` | error reported in-band (`ResetPasswordController.cs:29-36`) | inspect `success`, not the status code |
| 404 / 400 | `EntityNotFoundException` / `IntegrityCheckException` (`SignumExceptionFilterAttribute.cs:139-143`) | domain errors |
| 500 otherwise | anything else, incl. non-mapped exception types | retry only if idempotent |

- [ ] **Never map 401.** The framework deliberately never emits it
      (`SignumExceptionFilterAttribute.cs:136-137`: `// Unauthorized produces Login Password dialog in Mixed mode`).
      A CLI that only refreshes credentials on 401 will loop forever on 403.
- [ ] Discriminate on `exceptionType` (full CLR name), not on message text — messages are localized
      via `NiceToString()` and vary with the server's culture.
- [ ] Handle the case where no JSON error body is produced (actions returning `ActionResult<T>`,
      §1.2) — parse defensively.

**Detecting the silent-degradation cases (§2.7) — the most important item.**

- [ ] After loading a stored token at startup, call `GET api/auth/currentUser` and **assert a
      non-null user with the expected `userName`**. A wrong/rotated `AuthTokenEncryptionKey`, a
      truncated stored token, or a missing `Bearer ` prefix all produce "success as anonymous", not
      an error.
- [ ] Treat `currentUser == null` as "not authenticated" (the endpoint returns null for the
      configured anonymous user, `AuthController.cs:111-112`).
- [ ] If a request unexpectedly behaves as anonymous (403 `UnauthorizedAccessException` on something
      that should work, or empty result sets), re-validate the token rather than retrying.
- [ ] Log `X-App-Version` / `X-App-BuildTime` (`VersionFilterAttribute.cs:26-27`) with auth failures:
      a version change plus mass token rejection means the key or deployment changed.

**Retry safety.**

- [ ] Safe to retry after 403-auth once, *after* re-authenticating. Do not retry blind — a 403 from
      `UnauthorizedAccessException` will never succeed.
- [ ] `POST api/auth/login` is not idempotent in one respect: **failed** attempts increment
      `LoginFailedCounter` and, once `AuthLogic.MaxFailedLoginAttempts` is reached, **deactivate the
      user** (`AuthLogic.cs:434-455`). Never auto-retry a login on a 400 — a retry loop can lock the
      account out permanently (recovery needs `UserOperation.Reactivate`).
- [ ] A successful login resets the counter (`AuthLogic.cs:457-464`).
- [ ] `logout` does not invalidate the token server-side (`AuthController.cs:115-121`) — the client
      must delete its local copy; that is the *only* thing that stops it being usable.
- [ ] Clock skew: keep the client clock irrelevant (never generate or validate `CreationDate`
      locally) but be aware multi-server skew > 2 s can cause spurious 403s
      (`AuthTokensServer.cs:82-83`).

**Things that must never appear in a URL or a custom User-Agent.**

- [ ] API keys, tokens, passwords, or any secret — query strings are persisted by `RestLogFilter`
      (`RestLogFilter.cs:36-38`, `RestLog.cs:74-81`) and by the global exception logger
      (`SignumExceptionFilterAttribute.cs:92`); the request **body** and `User-Agent` are persisted
      on any exception (`:86,93`).
- [ ] Corollary for password login: a `POST api/auth/login` that fails *unexpectedly* can persist the
      cleartext password in `ExceptionEntity.Form`. Prefer API-key or token auth for automation, and
      prefer `loginFromApiKey` over repeated password logins.

**Nice-to-have robustness.**

- [ ] Probe `GET api/auth/openIDEndpoints` (anonymous) to detect an OIDC-configured server before
      offering password login (`OpenIDAuthenticationController.cs:23`).
- [ ] Do not rely on `LoginResponse.message` (not emitted by the server, §1.1).
- [ ] Treat `authenticationType` as an open string (`"relogin"` and `"openID"` are absent from the
      published TS union).
- [ ] If caching reflection metadata as a capability list, key the cache on the token's role and
      invalidate on `New_Token` (§4).

---

## 6. Gaps and corrections to prior assumptions

- **`TokensAreValidWhen` does not exist** in this tree. A recursive grep for `TokensAreValidWhen`
  and for `ValidWhen` across the whole `signum-framework` checkout returns zero hits, and zero hits
  in the `signum-cli` repo. The concept it refers to is implemented here as the combination of
  `AuthTokenConfigurationEmbedded.RefreshAnyTokenPreviousTo` (`AuthTokenConfigration.cs:9`, a
  "rotate everything issued before X" timestamp) and the `RefreshToken` predicate chain
  (`AuthTokensServer.cs:106-118`). It is likely a name from an older Signum version or from
  design notes; the requirements doc should be corrected to name the real members.
- "The query string is stored" — **confirmed and broader than expected**: query string *plus request
  body* (`RestLogFilter.cs:56`) *plus response body* (`:122`) for `RestLogFilter`-decorated actions,
  and query string + full URL + body + User-Agent for **every** action that throws
  (`SignumExceptionFilterAttribute.cs:82-96`). Headers other than `Referrer`/`Referer`/`User-Agent`
  are not logged.
- "Tokens expire after 30 minutes" would be **wrong**: 30 minutes is the rotation interval; tokens
  do not expire (§2.3).
- "403 means insufficient permissions" is **insufficient**: 403 covers both authentication failure
  and authorization failure and they must be separated by `exceptionType` (§5).

## 7. Inventory of files read

- `Extensions/Signum.Authorization/AuthController.cs`
- `Extensions/Signum.Authorization/AuthServer.cs`
- `Extensions/Signum.Authorization/AuthLogic.cs`
- `Extensions/Signum.Authorization/AuthClient.tsx` (reference client behaviour)
- `Extensions/Signum.Authorization/RoleEntity.cs`, `UserEntity.cs`, `UserGraph.cs`
- `Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs`, `AuthToken/AuthTokenConfigration.cs`
- `Extensions/Signum.Authorization/UserTicket/UserTicketServer.cs`, `UserTicket/UserTicketLogic.cs`, `UserTicket/UserTicket.cs`
- `Extensions/Signum.Authorization/Rules/{QueryAuthLogic,OperationAuthLogic,PermissionAuthLogic,TypeAuthLogic,TypeAuthLogic.Conditions}.cs`
- `Extensions/Signum.Authorization.ResetPassword/ResetPasswordController.cs`
- `Extensions/Signum.Authorization.AzureAD/AzureADAuthenticationController.cs`
- `Extensions/Signum.Authorization.OpenID/OpenIDAuthenticationController.cs`
- `Extensions/Signum.Authorization.WindowsAD/WindowsADController.cs`
- `Extensions/Signum.Rest/{RestApiKeyEntity,RestApiKeyLogic,RestApiKeyController,RestApiKeyServer,RestLog,RestLogFilter,RestLogLogic,RestLogController}.cs`
- `Signum/API/SignumServer.cs`
- `Signum/API/Filters/{SignumFilters,SignumExceptionFilterAttribute,ValidateModelFilterAttribute,VersionFilterAttribute,SignumAllowAnonymousAttribute}.cs`
- `Signum/API/Json/EntityJsonContext.cs`
- `Signum/Security/IUserEntity.cs`
- `Signum/Operations/OperationLogic.cs`
- `Signum/DynamicQuery/DynamicQueryContainer.cs`
- `Signum/Engine/GlobalLazy.cs`, `Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs`, `Signum/Engine/Database.cs`
- `Signum/Basics/Exception.cs`
- `Signum.Utilities/Extensions/DictionaryExtensions.cs`
