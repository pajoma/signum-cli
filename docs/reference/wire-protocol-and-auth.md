# Signum Framework — Authentication & Wire Protocol for a Headless CLI Client

Analysed repo (read-only): `/home/patrick.maue/git/sfcl/signum-framework`
All paths below are relative to that root. Every claim carries a `file:line`.
Where I infer rather than read, it is marked **[INFERENCE]**.

---

## 0. Global facts that shape every request

| Fact | Evidence |
|---|---|
| Everything is under `/api/...`; routes are declared per-action with absolute `[HttpGet("api/…")]` / `[HttpPost("api/…")]` attributes, **not** via a controller-level `[Route]` prefix. | e.g. `Signum/API/Controllers/EntityController.cs:10`, `Signum/API/Controllers/OperationController.cs:17` |
| Authentication is a **global MVC resource filter**, `SignumAuthenticationFilter`, registered in `AddSignumGlobalFilters`. It applies to *every* action of *every* controller. | `Signum/API/SignumServer.cs:57-73` (line 68 = `options.Filters.Add(new SignumAuthenticationFilter());`) |
| The filter runs a **chain of pluggable authenticators**; the first non-null wins. | `Signum/API/Filters/SignumFilters.cs:43-55` |
| On success it stores `UserWithClaims` in `HttpContext.Items["Signum_User_Holder"]` and opens a `UserHolder.UserSession(...)` scope for the request, which is what makes `UserEntity.Current` work. | `Signum/API/Filters/SignumFilters.cs:41`, `:57-67`; `Signum/Security/IUserEntity.cs:59-65` |
| Every response carries `X-App-Version` and `X-App-BuildTime` headers. Useful for a CLI to detect server upgrades / cache invalidation. | `Signum/API/Filters/VersionFilterAttribute.cs:25-26` |
| MVC `JsonOptions` are only extended with converters; **no naming policy is set by Signum**, so ASP.NET Core's web defaults apply → plain DTO properties are **camelCase** on the wire and case-insensitive on read. Entity/Lite JSON is written by *custom converters* that emit literal names (`Type`, `id`, `ticks`, `EntityType`…) and are therefore **not** camelCased. | `Signum/API/SignumServer.cs:33-55` (no `PropertyNamingPolicy`); contrast `Signum/API/Json/EntityJsonContext.cs:15` where the *internal* token-serialization options do set camelCase. **[INFERENCE]** on the ASP.NET default, but confirmed by the TypeScript client, which sends camelCase for DTOs — e.g. `Signum/React/Operations.tsx:387` sends `{ lites, operationKeys }` for the C# DTO `StateCanExecuteRequest { OperationKeys, Lites }` (`Signum/API/Controllers/OperationController.cs:355-359`). |
| `WriteIndented = true` on the server's serializer — responses are pretty-printed. | `Signum/API/SignumServer.cs:44` |
| Type names on the wire are **clean type names**: the C# class name with a trailing `Entity` / `Embedded` / `Model` / `Symbol` suffix removed. | `Signum/Entities/Reflection/Reflector.cs:86-98`; `Signum/API/ReflectionServer.cs:405-411` |

---

## 1. Authentication paths for a non-browser client

### 1.1 The authenticator chain (who validates what, in which order)

```csharp
// Signum/API/Filters/SignumFilters.cs:39-68
public class SignumAuthenticationFilter : SignumDisposableResourceFilter
{
    public const string Signum_User_Holder_Key = "Signum_User_Holder";

    public static readonly IList<Func<FilterContext, SignumAuthenticationResult?>> Authenticators = new List<...>();

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

    public override IDisposable? GetResource(ResourceExecutingContext context)
    {
        var result = Authenticate(context);
        if (result == null) return null;
        context.HttpContext.Items[Signum_User_Holder_Key] = result.UserWithClaims;
        return UserHolder.UserSession(result.UserWithClaims!);
    }
}
```

Registration order in a typical app:

1. **`ApiKeyAuthenticator`** — `Authenticators.Insert(0, ApiKeyAuthenticator)` — `Extensions/Signum.Rest/RestApiKeyServer.cs:19`. Inserted at index **0**, so it always wins when an API key is present, regardless of module start order.
2. **`TokenAuthenticator`** (Bearer) — `Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs:27`
3. **`AnonymousUserAuthenticator`** — `:28` (only if `AuthLogic.AnonymousUser != null`)
4. **`AllowAnonymousAuthenticator`** — `:29` (only for actions/controllers marked `[SignumAllowAnonymous]`)
5. **`InvalidAuthenticator`** — `:30` — unconditionally `throw new AuthenticationException("No authentication information found!")` (`:34-37`)

So an **unauthenticated request to any non-`[SignumAllowAnonymous]` endpoint gets `403 Forbidden`** (see §1.6 for the mapping) with body `{"exceptionType":"System.Security.Authentication.AuthenticationException","exceptionMessage":"No authentication information found!"}`.

`[SignumAllowAnonymous]` endpoints relevant to a CLI: `api/auth/login` (`Extensions/Signum.Authorization/AuthController.cs:12`), `api/auth/loginFromCookie` (`:94`), `api/reflection/types` (`Signum/API/Controllers/ReflectionController.cs:14`), `api/registerClientError` (`:69`).

### 1.2 API key — representation, generation, storage

```csharp
// Extensions/Signum.Rest/RestApiKeyEntity.cs:5-20
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

- **Not hashed.** The key is stored as a plain `string` column with a unique index and is loaded wholesale into an in-memory cache keyed **by the plaintext key**:
  ```csharp
  // Extensions/Signum.Rest/RestApiKeyLogic.cs:31-34
  RestApiKeyCache = sb.GlobalLazy(() =>
  {
      return Database.Query<RestApiKeyEntity>().ToFrozenDictionaryEx(rak => rak.ApiKey);
  }, new InvalidateWith(typeof(RestApiKeyEntity)));
  ```
  Consequence for a CLI: the key is a **bearer secret in the clearest sense** — it is recoverable from the DB and from `api/restApiKey/current`. Treat it exactly like a password; never log it. Note also that the failure message **echoes the submitted key back** (`RestApiKeyServer.cs:34`: `$"Could not authenticate with the API Key {keys.Single()}."`), i.e. a bad key ends up in the server exception log and in the HTTP error body — a CLI must not print that body verbatim into shared logs.

- **Generation** — 32 cryptographically random bytes, Base64Url-encoded (43 chars, URL-safe):
  ```csharp
  // Extensions/Signum.Rest/RestApiKeyLogic.cs:41-46
  private static string DefaultGenerateRestApiKey()
  {
      byte[] tokenData = new byte[32];
      RandomNumberGenerator.Create().GetBytes(tokenData);
      return WebEncoders.Base64UrlEncode(tokenData);
  }
  ```
  Overridable via `RestApiKeyLogic.GenerateRestApiKey` (`:13`).

- **Server-side helper endpoints** (both require an already-authenticated caller — they are not `[SignumAllowAnonymous]`):
  ```csharp
  // Extensions/Signum.Rest/RestApiKeyController.cs:8-19
  [HttpGet("api/restApiKey/generate")]  public string  GenerateRestApiKey()   // returns a fresh candidate key, does NOT persist it
  [HttpGet("api/restApiKey/current")]   public string? GetAPIKey()            // the caller's own stored key, or null
  ```

### 1.3 **How the key is transmitted** (the literal constants)

```csharp
// Extensions/Signum.Rest/RestApiKeyLogic.cs:9-10
public readonly static string ApiKeyQueryParameter = "apiKey";
public readonly static string ApiKeyHeader = "X-ApiKey";
```

Both are accepted, and the validator unions them:

```csharp
// Extensions/Signum.Rest/RestApiKeyServer.cs:23-44
public static SignumAuthenticationResult? ApiKeyAuthenticator(HttpContext httpCtx)
{
    httpCtx.Request.Query.TryGetValue(RestApiKeyLogic.ApiKeyQueryParameter, out var val);
    httpCtx.Request.Headers.TryGetValue(RestApiKeyLogic.ApiKeyHeader, out var headerKeys);

    var keys = val.Distinct().Union(headerKeys.Distinct()).NotNull().ToList()!;

    if (keys.Count == 1)
    {
        using (AuthLogic.Disable())
        {
            var user = RestApiKeyLogic.RestApiKeyCache.Value
                .GetOrThrow(keys.Single(), $"Could not authenticate with the API Key {keys.Single()}.")
                .User.RetrieveAndRemember();
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

Client rules that fall out of this:
- Header name is exactly **`X-ApiKey`** (HTTP header matching is case-insensitive, so `x-apikey` is fine).
- Query parameter name is exactly **`apiKey`** (query keys **are** case-sensitive in ASP.NET Core → must be `apiKey`).
- **Never send both.** `Union` de-duplicates identical values, so header + query with the *same* value is tolerated, but two *different* values → `AuthenticationException` → 403. A CLI should send the header only.
- Absent key → returns `null` → chain falls through to Bearer/anonymous/`InvalidAuthenticator`.
- Unknown key → `GetOrThrow` raises (a `KeyNotFoundException`-family exception, not `AuthenticationException`) → **500 InternalServerError**, not 401/403 (see the `GetStatus` table in §1.6, which has no case for it). **[INFERENCE]** on the exact exception type — `GetOrThrow` is a Signum utility; the status mapping is read from code.

**User context established:** `new UserWithClaims(user)` (`RestApiKeyServer.cs:35`), which sets `User = user.ToLite()` and runs the `FillClaims` event (`Signum/Security/IUserEntity.cs:22-27`). The filter then wraps the request in `UserHolder.UserSession(...)` (`SignumFilters.cs:66`), so `UserHolder.Current` and `UserEntity.Current` resolve to that user and **all normal role/type/operation/query authorization applies**. An API key is *not* a bypass — it is an impersonation of one specific `UserEntity`.

### 1.4 Provisioning an API key (administrator steps)

There is no self-service endpoint that persists a key. An admin must:

1. Ensure the app calls `RestApiKeyLogic.Start(sb)` at startup (`Extensions/Signum.Rest/RestApiKeyLogic.cs:15-39`). If the app does not include `Signum.Rest`, **`X-ApiKey` does not exist at all** and the CLI must use Bearer tokens.
2. Create a `RestApiKeyEntity` with `User` = the target `Lite<UserEntity>` and `ApiKey` = a generated key (20–100 chars, `RestApiKeyEntity.cs:10`).
3. Save it via the operation **`RestApiKeyOperation.Save`** (`RestApiKeyEntity.cs:18`), wired by `.WithSave(RestApiKeyOperation.Save)` (`RestApiKeyLogic.cs:21`). Over HTTP that is:
   `POST /api/operation/executeEntity/RestApiKeyOperation.Save` (see §4 for the operation-key format).
   The React admin UI does exactly this: `Extensions/Signum.Rest/Templates/RestApiKey.tsx:16-21` calls `api/restApiKey/generate`, assigns to `ctx.value.apiKey`, sets `modified = true`, and the standard save path persists it.
4. Deletion: **`RestApiKeyOperation.Delete`** (`RestApiKeyEntity.cs:19`) → `POST /api/operation/deleteLite/RestApiKeyOperation.Delete`.

There is **no expiry, no scope, no rotation support** on `RestApiKeyEntity` — one key per user is the implicit model (`api/restApiKey/current` uses `SingleOrDefault()`, `RestApiKeyController.cs:18`). Revocation = delete the row (the cache is invalidated by `InvalidateWith(typeof(RestApiKeyEntity))`, `RestApiKeyLogic.cs:34`).

### 1.5 `RestLogFilter` / `RestLogLogic` — does logging constrain the client?

`RestLogFilter` is an **opt-in `ActionFilterAttribute`** that an application puts on its *own* REST controllers; it is **not** in the global filter list (`Signum/API/SignumServer.cs:57-73` does not contain it). So for the framework's own `api/query/*`, `api/operation/*`, `api/entity/*` endpoints it is **not active** and imposes nothing.

Where an app does apply it (`Extensions/Signum.Rest/RestLogFilter.cs:9-22`, ctor takes `bool allowReplay`, plus `IgnoreRequestBody` / `IgnoreResponseBody` properties):

- It records, per request: HTTP method, `request.Path`, **the full query string as key/value rows**, the authenticated user, controller/action/machine/app names, start & end dates, remote IP, host, the `Referrer` header, **the entire request body**, and **the entire response body** (`RestLogFilter.cs:36-57`, `:106-138`; entity shape in `Extensions/Signum.Rest/RestLog.cs:5-72`).
- Consequences for a CLI:
  - **Do not put the API key in the query string** on `RestLogFilter`-decorated endpoints — `QueryString` is persisted verbatim into `RestLogEntity.QueryString` (`RestLogFilter.cs:36-38`, `RestLog.cs:28-29`). The header is not logged. `RestLogLogic.GetRestDiffResult` even strips `apiKey=` from the URL before replay (`RestLogLogic.cs:66-71`), confirming the query-string form is considered leaky.
  - Request bodies are buffered and read fully (`RestLogFilter.cs:86-104`, `request.EnableBuffering()`); response bodies are captured through a `MemoryStream` swap (`:28-32`, `:144-153`). Large payloads are therefore fully materialised — a CLI streaming huge uploads/downloads through a logged endpoint should expect memory/latency cost, not a protocol constraint.
  - **Replay**: `AllowReplay` + `RestLogLogic.GetRestDiffResult(httpMethod, url, apiKey, oldRequestBody)` re-issues the recorded request with `X-ApiKey` (`RestLogLogic.cs:53-82`), diffs the response, and stores `ReplayState` (`NoChanges` / `WithChanges`, `RestLog.cs:83-87`) and `ChangedPercentage`. This is a server-side regression tool. **There is no idempotency key, no required correlation header, no `Idempotency-Key` concept anywhere.** Replay is destructive for non-idempotent endpoints — a CLI cannot and need not do anything about it.
- Also note `SignumExceptionFilterAttribute.LogException` persists `req.QueryString` and the whole request body into `ExceptionEntity` on *any* unhandled error, globally (`Signum/API/Filters/SignumExceptionFilterAttribute.cs:92-93`). Another reason to keep the key out of the URL.

### 1.6 The Bearer token scheme (`AuthTokensServer.cs`)

**Header name** — `Authorization`, value `"Bearer " + token`:

```csharp
// Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs:57
public static string AuthHeader = "Authorization";

// :59-62 — apps hosted under Windows Authentication rename it, because IIS eats `Authorization`:
public static void PrepareForWindowsAuthentication()
{
    AuthHeader = "Signum_Authorization";
}
```
```csharp
// :140-151
public static Func<string, AuthToken?> DeserializeAuthHeaderToken = (string authHeader) =>
{
    try { return DeserializeToken(authHeader.After("Bearer ")); }
    catch (AuthenticationException) { return null; }
};
```
Client-side confirmation: `Extensions/Signum.Authorization/AuthClient.tsx:49` (`AuthHeader: "Authorization"`) and `:163` (`options.headers[Options.AuthHeader] = "Bearer " + token;`).

> Note the literal `"Bearer "` with a trailing space and `.After(...)`, so the prefix must be exactly `Bearer ` (capital B). **[INFERENCE]**: `After` is Signum's "substring after first occurrence" helper, so `bearer x` would not match.

**Token format — NOT a JWT.** It is an AES-CBC-encrypted, Deflate-compressed, JSON-serialized .NET object, then Base64 (standard, not URL-safe):

```csharp
// :205-228
static string SerializeToken(AuthToken token)
{
    var array = new MemoryStream().Using(ms => {
        using (DeflateStream ds = new DeflateStream(ms, CompressionMode.Compress))
        using (Utf8JsonWriter writer = new Utf8JsonWriter(ds))
            JsonSerializer.Serialize(writer, token, EntityJsonContext.FullJsonSerializerOptions);
        return ms.ToArray();
    });
    array = Encrypt(array);
    return Convert.ToBase64String(array);
}
```
```csharp
// :264-272 — the payload
public class AuthToken
{
    public Lite<IUserEntity> User { get; set; }
    public Dictionary<string, object?> Claims { get; set; }
    public byte[]? PasswordHash { get; set; } //To check if the password has changed
    public DateTime CreationDate { get; set; }
}
```

- **Crypto**: `AES`, `CipherMode.CBC`, `PaddingMode.PKCS7`, random IV prepended as the first 16 bytes of the ciphertext (`:233-261`). Key = **MD5 hash of the app's `AuthTokenEncryptionKey` config string** (`:24-25`), i.e. a 128-bit AES key derived by a single unsalted MD5 — no HMAC, so the token is encrypted but **not authenticated**; integrity rests on the JSON deserialization failing. Any decrypt/parse failure → `throw new AuthenticationException("Invalid token")` (`:174`).
- **Therefore a client cannot mint or inspect tokens.** It must obtain them from the server and treat them as opaque strings. (Encoding is standard Base64 → contains `+`, `/`, `=`; must **not** be put in a URL unescaped.)
- **Expiration / refresh** (`:64`, `:76-102`):
  ```csharp
  public static DateTime GetTokenLimitDate() => Clock.Now.AddMinutes(-Configuration().RefreshTokenEvery);
  ...
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
  Config: `AuthTokenConfigurationEmbedded { int RefreshTokenEvery = 30 /*mins*/; DateTime? RefreshAnyTokenPreviousTo; }` (`Extensions/Signum.Authorization/AuthToken/AuthTokenConfigration.cs:3-10`).

  **Key CLI behaviour:** tokens never hard-expire and there is no separate refresh endpoint. An old token is *silently accepted* and the server hands back a fresh one in the **`New_Token` response header** (`AuthTokensServer.cs:92`). A client MUST read `New_Token` off every response and replace its stored token — exactly as the React client does (`AuthClient.tsx:166-172`). Adding `?refreshToken` to any request forces a refresh (`AuthTokensServer.cs:88`).
- Refresh-time validations, all → `AuthenticationException` → 403 (`:104-137`): user deleted, `user.State != UserState.Active`, `ToString()` changed (username changed), **`PasswordHash` changed** (`:117-118`). So *changing the user's password invalidates all outstanding tokens*, but does **not** invalidate an API key. Also, a future-dated token (`Clock.Now.AddSeconds(2) < token.CreationDate`) is rejected (`:82-83`), and a recently-disabled user is rejected before any refresh (`:78-80`).

### 1.7 `AuthController` — the login endpoints and their real DTOs

```csharp
// Extensions/Signum.Authorization/AuthController.cs:9-13
[ValidateModelFilter]
public class AuthController : ControllerBase
{
    [HttpPost("api/auth/login"), SignumAllowAnonymous]
    public ActionResult<LoginResponse> Login([Required, FromBody] LoginRequest data)
```
```csharp
// :167-179 — verbatim
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
```
(The DTO members are *already* camelCase in C# — note the `#pragma warning disable IDE1006 // Naming Styles` at `:166`. So the wire names are unambiguous regardless of naming policy.)

Full endpoint list:

| Route | Method | Auth needed | Body | Returns |
|---|---|---|---|---|
| `api/auth/login` | POST | anonymous OK (`:12`) | `LoginRequest` | `LoginResponse` (200) or **`400`** `ModelState` dict (`:159-163`) |
| `api/auth/loginFromApiKey?apiKey=…` | GET | yes — the ApiKeyAuthenticator must have already run (`:72-80`) | — | `LoginResponse` with `authenticationType: "api-key"` |
| `api/auth/relogin` | GET | yes (`:82-92`) | — | `LoginResponse`, `authenticationType: "relogin"` |
| `api/auth/loginFromCookie` | POST | anonymous, needs `sfUser` cookie (`:94-106`) | — | `LoginResponse` (`"cookie"`) or **`null`** body when the cookie is missing/invalid |
| `api/auth/currentUser` | GET | yes (`:108-113`) | — | `UserEntity` JSON, or `null` if the caller resolved to the anonymous user |
| `api/auth/logout` | POST | yes (`:115-121`) | — | 204/empty; only clears the remember-me cookie — **the Bearer token is not revoked server-side** |
| `api/auth/ChangePassword` | POST | yes (`:123-156`) | `ChangePasswordRequest { oldPassword, newPassword }` (`:181-185`) | `LoginResponse` (`"changePassword"`) — a *new* token, because the old one is now invalid (§1.6) |

Login error shape: `ModelError(field, msg)` → `new BadRequestObjectResult(ModelState)` (`:159-163`), i.e. **HTTP 400** with the standard ASP.NET `ModelStateDictionary` serialization, e.g. `{"userName":["Invalid username"]}`. Field keys used: `userName`, `password`, `oldPassword`, `newPassword`, `login` (`:16,19,35-47,126-144`). If `AuthServer.AvoidExplicitErrorMessages` is on (`Extensions/Signum.Authorization/AuthServer.cs:17`) all cases collapse to `login: "Invalid username or password"`.

`api/auth/loginFromApiKey` is notable: it ignores its own `apiKey` parameter entirely and just reads `UserEntity.Current` (`:73-80`) — the parameter exists only so the value lands in the query string where `ApiKeyAuthenticator` can see it. A CLI should prefer sending the key as the **header** to `api/auth/relogin`, which is the identical operation without the query-string leak. **[INFERENCE]** that `relogin` works with an API key — it only requires that *some* authenticator succeeded, which `X-ApiKey` satisfies; `AuthLogic.OnUserLogingIn` is additionally fired at `:89`.

### 1.8 `UserTicket` — the remember-me cookie

```csharp
// Extensions/Signum.Authorization/UserTicket/UserTicket.cs:5-28
[EntityKind(EntityKind.System, EntityData.Transactional), TicksColumn(false)]
public class UserTicketEntity : Entity
{
    public Lite<UserEntity> User { get; set; }
    [StringLengthValidator(Min = 36, Max = 36)] public string Ticket { get; set; }  // a Guid
    public DateTime ConnectionDate { get; set; }
    [StringLengthValidator(Max = 200)] public string Device { get; set; }

    public string StringTicket() => "{0}|{1}".FormatWith(User.Id, Ticket);
    public static (PrimaryKey userId, string ticket) ParseTicket(string ticket) { /* regex ^(?<id>.*)\|(?<ticket>.*)$ */ }
}
```

- Wire form: a **cookie named `sfUser`** (`Extensions/Signum.Authorization/UserTicket/UserTicketServer.cs:10`) whose value is `"{userId}|{guid}"`.
- Created only when `LoginRequest.rememberMe == true` (`AuthController.cs:62-65` → `UserTicketServer.OnSaveCookie`), stored server-side as a row; consumed by `POST api/auth/loginFromCookie` (`AuthController.cs:94-106` → `UserTicketServer.LoginFromCookie`, `UserTicketServer.cs:14-47`).
- Expiry `TimeSpan.FromDays(60)`, max 4 tickets per user, and **all tickets are deleted when the user's password changes** (`Extensions/Signum.Authorization/UserTicket/UserTicketLogic.cs:5-6`, `:35-47`).
- **Device/IP binding is inconsistent in the framework**: `SaveCookie` stores `httpConnection.LocalIpAddress` as `Device` (`UserTicketServer.cs:63`) but `LoginFromCookie` validates with `RemoteIpAddress` (`:25`). Whether that actually blocks reuse depends on `UserTicketLogic.UpdateTicket`; regardless, it is **cookie/browser-oriented and a poor fit for a CLI**: it requires an interactive password login with `rememberMe:true` to obtain, needs a cookie jar, is rotated on every use (`UserTicketServer.cs:29-34` re-appends the cookie), and requires `UserTicketLogic.Start(sb)` to be enabled at all (`UserTicketLogic.cs:10-16`). **Usable headlessly only with effort; not recommended.**

### 1.9 Error → HTTP status mapping (applies to *all* endpoints)

```csharp
// Signum/API/Filters/SignumExceptionFilterAttribute.cs:131-146
private static HttpStatusCode GetStatus(Type type)
{
    if (type == typeof(UnauthorizedAccessException))  return HttpStatusCode.Forbidden;      // 403
    if (type == typeof(AuthenticationException))      return HttpStatusCode.Forbidden;      // 403  (comment: Unauthorized would trigger a browser login dialog)
    if (type == typeof(EntityNotFoundException))      return HttpStatusCode.NotFound;       // 404
    if (type == typeof(IntegrityCheckException))      return HttpStatusCode.BadRequest;     // 400
    return HttpStatusCode.InternalServerError;                                              // 500
}
```

Body is `application/json` (`:40-57`) of:

```csharp
// :151-177
public class HttpError
{
    public string  ExceptionType { get; set; }      // e.g. "System.Security.Authentication.AuthenticationException"
    public string  ExceptionMessage { get; set; }
    public string? ExceptionId { get; set; }        // id of the persisted ExceptionEntity
    public string? StackTrace { get; set; }         // included when HttpError.IncludeErrorDetails(e) — defaults to `e => true`!
    public ModelEntity? Model;                      // set when the exception is a ModelRequestedException
    public HttpError? InnerException;
}
```

**Important CLI notes**
- There is **no 401 anywhere** — auth failures are `403`. Do not build retry logic on 401.
- Property names here are PascalCase in C#; with the ASP.NET camelCase policy they appear as `exceptionType`, `exceptionMessage`, `exceptionId`, `stackTrace`, `model`, `innerException`. Confirmed by the React client checking `e.httpError.exceptionType` (`AuthClient.tsx:177`).
- The React client's rule for "the session is dead" is `exceptionType?.endsWith(".AuthenticationException")` (`AuthClient.tsx:177`) — a good rule for a CLI too.
- The JSON error body is only produced when the action's declared return type is *not* an `IActionResult` (`ExpectsJsonResult`, `:112-121`). Actions returning `ActionResult<T>` — e.g. `AuthController.Login`, `OperationController.ExecuteEntity` — handle their own errors and return `ModelState`/`ValidationProblemDetails` instead.
- `ConcurrencyException` (`Signum/Engine/Exceptions.cs:341-352`) is **not** in the `GetStatus` table → optimistic-concurrency conflicts surface as **HTTP 500** with `exceptionType: "Signum.Engine.ConcurrencyException"`. See §2.

### 1.10 **Ranked recommendation for a CLI**

#### 🥇 1st choice — `X-ApiKey` header on every request (requires `Signum.Rest`)

Zero round-trips, no token lifecycle, no cookie jar, no clock skew, no `New_Token` bookkeeping. It is the only mechanism in the framework designed for machine callers.

```http
GET /api/auth/currentUser HTTP/1.1
Host: signum.example.internal
X-ApiKey: YOUR_API_KEY_HERE
Accept: application/json
```

```http
POST /api/query/executeQuery HTTP/1.1
Host: signum.example.internal
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json
Accept: application/json

{ …QueryRequest… }
```

Caveats to encode in the client: send the key **only** as a header (never `?apiKey=`, §1.5); send it exactly once; expect **500** (not 403) for an unknown key; and be aware the server may echo the key in the error message, so redact response bodies on auth failure.

#### 🥈 2nd choice — API key → Bearer token, then Bearer for the session

Best when you want the API-key secret to touch the wire once per session, or when you want `LoginResponse.userEntity` up front.

```http
GET /api/auth/relogin HTTP/1.1
Host: signum.example.internal
X-ApiKey: YOUR_API_KEY_HERE
Accept: application/json
```
→ `200` `{"authenticationType":"relogin","token":"BASE64_TOKEN_HERE","userEntity":{ …UserEntity JSON… }}`

then

```http
POST /api/query/executeQuery HTTP/1.1
Host: signum.example.internal
Authorization: Bearer BASE64_TOKEN_HERE
Content-Type: application/json
```

**Mandatory:** after every response, `if (resp.headers["New_Token"]) token = resp.headers["New_Token"]` (`AuthTokensServer.cs:92`, `AuthClient.tsx:166-172`).

#### 🥉 3rd choice — username/password → Bearer token

The universal fallback: works on every Signum app, needs no `Signum.Rest` and no admin provisioning. Cost: the CLI must hold a real user password.

```http
POST /api/auth/login HTTP/1.1
Host: signum.example.internal
Content-Type: application/json
Accept: application/json

{
  "userName": "svc-cli",
  "password": "YOUR_PASSWORD_HERE",
  "rememberMe": false
}
```
→ `200`
```json
{
  "authenticationType": "Database",
  "token": "BASE64_TOKEN_HERE",
  "userEntity": { "Type": "User", "id": 42, "ticks": "638…", "toStr": "svc-cli", "userName": "svc-cli", "...": "..." }
}
```
→ or `400` `{"password":["Invalid password"]}`

Then use `Authorization: Bearer …` + the `New_Token` refresh rule. If the response's `userEntity.mustChangePassword` is true, the framework's own client refuses to proceed (`AuthClient.tsx:216-219`) — a CLI should fail loudly and tell the operator to run `POST /api/auth/ChangePassword`.

If the app was set up with `AuthTokenServer.PrepareForWindowsAuthentication()` (`AuthTokensServer.cs:59-62`) the header is **`Signum_Authorization: Bearer …`** instead. A robust CLI should make the header name configurable.

#### ❌ Not recommended — `UserTicket` cookie
Browser-shaped, requires an interactive password login with `rememberMe:true`, rotates per use, may be IP-bound, and is often not even started. See §1.8.

#### ❌ Never — `?apiKey=` in the URL
Logged into `RestLogEntity.QueryString` and `ExceptionEntity.QueryString`, plus proxy/access logs. §1.5.

---
## 2. Entity JSON wire format

Primary sources: `Signum/API/Json/EntityJsonConverter.cs`, `LiteJsonConverter.cs`, `MListJsonConverter.cs`, `EntityJsonContext.cs`, plus the generated TypeScript mirror `Signum/React/Signum.Entities.ts` (which is the literal wire contract) and `Signum/Entities/Lite.cs` / `LiteImp.cs`.

### 2.0 Two strategies — a CLI only ever sees `WebAPI`

```csharp
// Signum/API/Json/EntityJsonConverter.cs:90-97 (doc comments on EntityJsonConverterStrategy)
WebAPI  // "Only the visible entites are serialized, when deserializing a retrieve is made to apply changes"
Full    // "Serialized and deserialized as-is. Usefull for files and Auth Tokens."
```
The MVC pipeline uses `WebEntityJsonConverterFactory` whose `Strategy => EntityJsonConverterStrategy.WebAPI` (`Signum/API/SignumServer.cs:146-148`, registered at `:45`). `EntityJsonContext.FullJsonSerializerOptions` (`Signum/API/Json/EntityJsonContext.cs:8-29`) is internal-only (auth tokens, files).

**The single most important consequence:** in `WebAPI` mode, POSTing an entity does **not** replace it. The server calls `Database.Retrieve(type, id, partitionId)` and then **diff-applies** your JSON onto the freshly-retrieved instance (`EntityJsonConverter.cs:661-676`). Properties you omit keep their DB values; properties you send that are *equal* to the DB value are no-ops.

### 2.1 The envelope for a full `Entity` — write order and literal keys

From the `Write` method (`Signum/API/Json/EntityJsonConverter.cs:249-355`):

| # | Literal key | Emitted when | Value | Line |
|---|---|---|---|---|
| 1 | **`"Type"`** | always | `Entity` ⇒ `TypeLogic.TryGetCleanName(type)` (clean name, e.g. `"AwardNomination"`); non-Entity ⇒ `ReflectionServer.GetTypeName(type)` | 265 / 290 |
| 2 | **`"id"`** | always for `Entity` (`null` when new) | `entity.IdOrNull?.Object` serialized **with its runtime type** → `int`/`long` ⇒ JSON *number*; `Guid`/`string` ⇒ JSON *string* | 267-268 |
| 3 | **`"isNew"`** | only `if (entity.IsNew)` | literal `true` | 271-274 |
| 4 | **`"partitionId"`** | only if the table is partitioned **and** non-null | number | 278-281 |
| 5 | **`"ticks"`** | only `if (table.Ticks != null)` | `entity.Ticks.ToString()` ⇒ **JSON string holding an int64** | 283-286 |
| 6 | **`"toStr"`** | `if (!(mod is MixinEntity))` | `mod.ToString()` | 293-296 |
| 7 | **`"modified"`** | always | `true` iff `Modified ∈ {Modified, SelfModified}` (`Signum/Entities/Modifiable.cs:72-84`) | 298 |
| 8 | *one key per property* | see §2.2 | camelCase names | 300-303 |
| 9 | **`"propsMeta"`** | only if non-empty | `string[]`; bare name ⇒ read-only for this instance, `"!"`-prefix ⇒ hidden | 305-331 |
| 10 | **`"mixins"`** | only `if (mod.Mixins.Any())` | object keyed by **`m.GetType().Name`** (CLR name, e.g. `"CorruptMixin"`) | 333-350 |

There is **no** `temporalDate`, no `$type`, no `error` key on the server side. `error` exists in the TS interface but is filled client-side from a 400 `ModelState` (`Signum/React/Services.ts:249`).

TypeScript mirror, verbatim (`Signum/React/Signum.Entities.ts:10-34`):
```ts
export interface ModifiableEntity {
  Type: string;
  toStr: string | undefined;
  modified: boolean;
  isNew: boolean | undefined; //required in embedded to remove and re-create in EntityJsonSerializer
  error?: { [member: string]: string };
  propsMeta?: string[];
  mixins?: { [name: string]: MixinEntity }
}

export interface Entity extends ModifiableEntity {
  id: number | string | undefined;
  ticks: string | undefined; //max value
}

export interface MixinEntity extends ModifiableEntity { }
```

### 2.2 Reading: hard ordering constraint + property naming

```csharp
// Signum/API/Json/EntityJsonConverter.cs:769
static readonly string[] specialProps = new string[] { "toStr", "id", "isNew", "Type", "ticks", "modified", "temporalId" };
```
`ReadIdentityInfo` (`:725-769`) consumes properties in a `while` loop and `goto finish`es on the **first** non-special key.

⚠️ **Client rule:** all seven special props MUST precede every regular property. A late one throws (`:455-456`):
> `Property '{propertyName}' is a special property like 'toStr', 'id', 'isNew', 'Type', 'ticks', 'modified', 'temporalId', and they can only be at the beginning of the Json object for performance reasons`

Other read-side constraints from the same method:
- `"Type"` is **mandatory** — `if (info.Type == null) throw new JsonException(...)` (`:763-764`).
- `"ticks"` must be a **JSON string**: `long.Parse(reader.GetString()!)` (`:752`). A number throws.
- `"temporalId"` (GUID string) is a **client→server-only** identity token used to correlate new objects across the round trip (`Signum/Entities/ModifiableEntity.cs:289`; applied at `EntityJsonConverter.cs:629-630, 654-655, 672-673, 709-717`). The server never writes it.
- Sending `"EntityType"` inside a full entity is an explicit error (`:755`): *"Unexpected property 'EntityType' in full entity JSON. Use 'Type' instead."*

**Property naming** is computed by Signum itself, **independent of `PropertyNamingPolicy`** (`:136-144`):
```csharp
.ToDictionary(a => a.PropertyValidator!.PropertyInfo.Name.FirstLower())
```
Only the **first character** is lowered: `Name → "name"`, `BonusTrack → "bonusTrack"`, `HResult → "hResult"` (confirmed by generated TS `hResult: number;`, `Signum/React/Signum.Basics.ts:129`). Excluded from serialization entirely: `[InTypeScript(false)]`, `[HiddenProperty]`, `[ExpressionField]` (`ShouldSerialize`, `:146-160`).

**Unknown properties are rejected** (`:450-459`) with `KeyNotFoundException` ⇒ **HTTP 500**. Only `"mixins"` and `"propsMeta"` are tolerated non-property keys. A CLI must therefore round-trip exactly what it received and never invent keys.

**Read-only / non-writable handling** — four layers (`:520-549`):
1. get-only property (`pi.CanWrite == false`) ⇒ value read and silently dropped (`:524`).
2. Value equals the DB value ⇒ no-op (`:526`, `IsEquals` at `:592-604` — sequence-equal for `byte[]`, **±10 ms tolerance** for `DateTime`/`DateTimeOffset` because "*Json dates get rounded*"). This is why echoing read-only props back is safe.
3. Value differs **but `"modified": false`** ⇒ the change is **silently discarded** (the `InvalidOperationException($"'modified' is not set but '{pi.Name}' is modified")` at `:528-541` is deliberately swallowed). **A CLI that forgets `"modified": true` gets HTTP 200 and no change.**
4. Value differs and `modified: true` ⇒ `AssertCanWrite` (`:544` → `:122-127`) throws `UnauthorizedAccessException($"Property {arg} is readonly")` (`Signum/API/SignumServer.cs:108-119`) ⇒ **HTTP 403**.

Writing a `null` into a non-nullable value type records a validation error instead of throwing (`:545-549`).
Properties the caller lacks read permission on are **omitted** on write (`:375-380`) ⇒ treat every property as optional when parsing.

### 2.3 `Lite<T>`

`Write` (`Signum/API/Json/LiteJsonConverter.cs:23-68`), in order:

| Key | When | Value |
|---|---|---|
| **`"EntityType"`** | always | clean name, `TypeLogic.GetCleanName` (`:28`) |
| **`"ModelType"`** | only when `lite.ModelType != Lite.DefaultModelType(lite.EntityType)` (`:30-31`) | `"string"` or the model's clean type name (`Signum/Entities/Lite.cs:412-417`) |
| **`"id"`** | always (may be `null` for a fat lite of a new entity) | number or string, runtime-typed (`:33-34`) |
| **`"partitionId"`** | only if non-null | number (`:36-40`) |
| **`"model"`** | only if `lite.Model != null` | a **string** (the default model type *is* `string`, `Lite.cs:387-390`) **or** a full `ModelEntity` object with its own `"Type"` (`:42-56`) |
| **`"entity"`** | only for *fat* lites | a complete Entity envelope per §2.1 (`:58-66`) |

**There is no `toStr` in a Lite** — the display string travels in `model`. `Read` (`:70-141`) accepts exactly those six keys; anything else ⇒ `throw new JsonException("unexpected property " + propName)` (`:137`), and `"Type"` gets a dedicated message (`:136`): *"Unexpected property 'Type' in Lite JSON. Use 'EntityType' instead."* `id` accepts null/string/number (`:91-103`) then `PrimaryKey.Parse` (`:145`) — a numeric id may be sent as a string.

```ts
// Signum/React/Signum.Entities.ts:79-87
export interface Lite<T extends Entity> {
  EntityType: string;
  id?: number | string;
  model?: unknown;
  partitionId?: number;
  ModelType?: string;
  entity?: T;
}
```

**The `"Type;id"` string form is a *separate*, non-JSON representation.**
```csharp
// Signum/Entities/LiteImp.cs:182-190
public string Key()     => "{0};{1}".FormatWith(TypeLogic.GetCleanName(this.EntityType), this.Id);
public string KeyLong() => "{0};{1};{2}".FormatWith(TypeLogic.GetCleanName(this.EntityType), this.Id, this.ToString());
```
```csharp
// Signum/Entities/Lite.cs:183
public static readonly Regex ParseRegex = new Regex(@"(?<type>[^;]+);(?<id>[\d\w-]+)(;(?<toStr>.+))?");
```
with an optional `Id/PartitionId` sub-form (`Lite.cs:216-220` — note that branch reassigns `idStr` before evaluating `.After("/")`, which looks like a bug; avoid relying on it). TS side: `liteKey`, `liteKeyLong`, `parseLite`, `liteKeyRegEx = /^([a-zA-Z]+)[;]([0-9a-zA-Z-]+)$/` (`Signum/React/Signum.Entities.ts:20-22, 255-285`).

**Where each form is valid:** the JSON object form is the *only* accepted form for a `Lite<T>` JSON value — a bare string fails `reader.Assert(JsonTokenType.StartObject)` (`LiteJsonConverter.cs:75`). The `Type;id` string form is for URLs, text blobs, filter *values* and clipboard. Entity routes use the split form: `api/entity/{type}/{id}` (`Signum/API/Controllers/EntityController.cs:10`).

### 2.4 `MList<T>` — row shape

`Write` (`Signum/API/Json/MListJsonConverter.cs:65-89`) emits a **JSON array of exactly-two-key objects**:
```json
[ { "rowId": 101, "element": { … } }, { "rowId": null, "element": { … } } ]
```
- **No `order` column on the wire.** Ordering is the array index; whether it is persisted depends on `[PreserveOrder]` server-side (`:189-191`, `:217-222`).
- `rowId` is the DB row PK (number or string per its runtime type), **`null` for a new row**; the literal string `"dummy"` also means "no row id" (`:131`, `GraphExplorer.DummyRowId`, `Signum/Entities/Reflection/GraphExplorer.cs:207`). Values are coerced via `ReflectionTools.ChangeType` (`:133`) so `"5"` and `5` both work.
- The reader is **strictly positional** (`:112-127`): `rowId` must be the first key, `element` the second, and **no third key is allowed** — `throw new JsonException($"member 'rowId' expected …")` / `"member 'element' expected …"`.
- Rows are matched to existing DB rows by `rowId`, preserving embedded-row identity (`:96-97`, `:135-159`).
- MList mutation is gated on the owner's `modified`: `EntityJsonContext.SetAllowDirectMListChanges(... || markedAsModified)` (`EntityJsonConverter.cs:416`) and `if (!EntityJsonContext.AllowDirectMListChanges) return new MList<T>(newList);` (`MListJsonConverter.cs:193-194`) → silently ignored per §2.2 point 3.

```ts
// Signum/React/Signum.Entities.ts:59-72
export type MList<T> = Array<MListElement<T>>;
export interface MListElement<T> { rowId: number | string | null; element: T; }
export function newMListElement<T>(element: T): MListElement<T> { return { rowId: null, element }; }
```

### 2.5 `EmbeddedEntity` / `ModelEntity` / `MixinEntity` vs `Entity`

All go through the same converter (`CanConvert`: `typeof(IModifiableEntity).IsAssignableFrom(typeToConvert)`, `EntityJsonConverter.cs:218-221`).

| | `Entity` | `EmbeddedEntity` / `ModelEntity` | `MixinEntity` |
|---|---|---|---|
| `"Type"` value | clean name, `Entity` suffix stripped (`"AwardNomination"`) | `ReflectionServer.GetTypeName` → falls back to `t.Name`, i.e. **the CLR name including the suffix**: `"NominationPointEmbedded"`, `"AwardLiteModel"` (`ReflectionServer.cs:405-411`; confirmed by generated TS `Type: "DeleteLogParametersEmbedded";`, `Signum/React/Signum.Basics.ts:73`) | same (`"CorruptMixin"`) |
| `"id"` / `"ticks"` / `"partitionId"` | conditional | **never** | never |
| `"toStr"` | yes | yes | **no** (`:293-296`) |
| `"modified"` | yes | yes | yes |
| `"isNew"` on read | forces a new instance | **honoured** — `isNew: true` removes and re-creates the embedded (`:621-632`; TS comment at `Signum.Entities.ts:14`) | n/a |
| read behaviour | `Database.Retrieve` then diff-apply (`:661-676`) | reuse the existing instance if same type, else `Activator.CreateInstance` (`:701-721`) | **cannot be added or replaced, only patched**: `if (typeof(MixinEntity).IsAssignableFrom(objectType)) { var mixin = (MixinEntity)existingValue!; return mixin; }` (`:614-619`); the instance is looked up on the parent by CLR type name (`:430`, `Signum/Entities/ModifiableEntity.cs:571-581`) |

⚠️ **A bare `EmbeddedEntity` cannot be POSTed to an arbitrary endpoint.** The deserializer needs a `PropertyRoute`, and for a root embedded there is none, so it throws (`Signum/API/SignumServer.cs:150-163`):
> `Impossible to determine PropertyRoute for {embedded.GetType().Name}. Consider adding someting like [EmbeddedPropertyRoute<T>] to your action or controller.`

`ModelEntity` implements `IRootEntity` so models are fine at the root. **[INFERENCE]** from `EntityJsonConverter.cs:164-165` plus `LiteJsonConverter.cs:50` using `PropertyRoute.Root(lite.Model.GetType())`.

**`PropertyRoute` is never on the wire** — it is reconstructed from the serialization stack (`SerializationPath : Stack<SerializationStep>` with `CurrentPropertyRoute()`, `EntityJsonContext.cs:70-121`, pushed at `EntityJsonConverter.cs:257-259, 382, 435, 504` and `MListJsonConverter.cs:80, 137, 164`). The server needs it for MList rowId typing, `[PreserveOrder]`, `DateTimeKind`, and read/write authorization. ⇒ **A CLI must send complete graphs rooted at a known type.**

### 2.6 Scalar encodings

| CLR type | JSON | Evidence |
|---|---|---|
| `enum` (property) | **string member name** | `new JsonStringEnumConverter()` (`SignumServer.cs:48`, `EntityJsonContext.cs:24`); generated TS emits string-literal unions, e.g. `export type BooleanEnum = "False" \| "True";` (`Signum.Entities.ts:354-357`) |
| enum as an entity reference (`EnumEntity<T>`) | normal Entity/Lite envelope; type name is the plain enum name, mapped by `EnumEntity.Generate(type)` | `EntityJsonConverter.cs:207-208`, `SignumServer.cs:174-175` |
| `bool` | `true` / `false` | STJ default |
| all integers, `decimal`, `float`, `double` | **plain JSON number** (TS: `number`) — **no** string-wrapping for `decimal` | no custom converter registered (`SignumServer.cs:44-51`); `Signum.TSGenerator/EntityDeclarationGenerator.cs:600-613` |
| `DateTime`, `DateTimeOffset` | **ISO-8601 round-trip string** (STJ default), e.g. `"2026-07-17T09:14:23.1234567Z"` | absence of a converter; TS `string /*DateTime*/`. On read the `Kind` is re-stamped from `[DbType(DateTimeKind=…)]`: `newValue = dt.ToKind(kind);` (`EntityJsonConverter.cs:512-516`). Comparison tolerance ±10 ms (`:597-601`) |
| `DateOnly` | **`"yyyy-MM-dd"`** — `"o"` round-trip, `ParseExact`, **strict** | `Signum/API/Json/DateOnlyConverter.cs:10-18` |
| `TimeOnly` | **`"HH:mm:ss[.FFFFFFF]"`** — `ParseExact`, **strict** | `Signum/API/Json/TimeOnlyConverter.cs:10-22` |
| `TimeSpan` | `TimeSpan.ToString()` ⇒ `"03:20:00"`, `"1.03:20:00"`; read via lenient `TimeSpan.Parse` | `Signum/API/Json/TimeSpanConverter.cs:8-17` |
| `Guid` | string | STJ default; TS `string /*Guid*/` |
| `byte[]` | **base64 string** | STJ default; `EntityDeclarationGenerator.cs:625-626` → `string /*Byte[]*/`, e.g. `binaryFile: string /*Byte[]*/;` (`Extensions/Signum.Files/Signum.Files.ts:51`) |
| `TypeEntity` (a DB type row) | an ordinary Entity/Lite; clean name is **`"Type"`**, and `[TicksColumn(false)]` ⇒ **no `ticks` key** | `Signum/Basics/Type.cs:1-25` |
| `System.Type` | **never serialized.** No `JsonConverter<Type>` exists. Types travel as clean-name strings (in `"Type"`/`"EntityType"`, resolved by `TypeLogic.GetType`) or as `Lite<TypeEntity>` | grep over `Signum/API` |

### 2.7 Polymorphism / abstract & interface-typed properties

No `$type`. The discriminator is the mandatory `"Type"` (entities/embeddeds/models/mixins) or `"EntityType"` (lites), plus `"ModelType"` for lite models. Resolution (`Signum/API/SignumServer.cs:165-183`):
```csharp
public override Type ResolveType(string typeStr, Type objectType, Func<string, Type>? parseType)
{
    if (Reflector.CleanTypeName(objectType) == typeStr) return objectType;
    if (parseType != null) return parseType(typeStr);
    var type = ReflectionServer.TypesByName.Value.GetOrThrow(typeStr);
    if (type.IsEnum) type = EnumEntity.Generate(type);
    if (!objectType.IsAssignableFrom(type))
        throw new JsonException($"Type '{type.Name}' is not assignable to '{objectType.TypeName()}'");
    return type;
}
```
`TypesByName` is keyed by exactly `ReflectionServer.GetTypeName` (`ReflectionServer.cs:35`) — the same strings the writer emits, and the same keys as `api/reflection/types`. **Round-tripping `"Type"` verbatim is always correct**, and for `[ImplementedBy]` / interface-typed properties (`Lite<IAuthorEntity>`) the concrete clean name is what selects the implementation. The `parseType` escape hatch is used for `Lite.model` (`Lite.ParseModelType`, `LiteJsonConverter.cs:124, 150`; `Lite.cs:420-433`), which accepts `"string"`/`"String"` or a registered model clean name.

### 2.8 Optimistic concurrency via `ticks`

`ticks` is a **string-encoded int64** (.NET DateTime ticks), written only when the table has a Ticks column (`EntityJsonConverter.cs:283-286`; field `internal long ticks;` / `[HiddenProperty] public long Ticks` at `Signum/Entities/Entity.cs:48-54`). String encoding avoids JS 2^53 precision loss. TS: `ticks: string | undefined; //max value`.

**Client rule: echo `ticks` back verbatim.** Two independent checks:

**(a) At deserialization** (`EntityJsonConverter.cs:635-676`):
```csharp
if (identityInfo.Ticks != null)
{
    if (ConcurrencyLogic.IsEnabled && identityInfo.Modified == true && retrievedEntity.Ticks != identityInfo.Ticks.Value)
        throw new ConcurrencyException(type, id);
    retrievedEntity.Ticks = identityInfo.Ticks.Value;
}
```
Note the conjunction: it only fires when `modified == true` **and** `ConcurrencyLogic.IsEnabled`. **Omitting `ticks` skips the check entirely** and the DB-level check then compares against the just-retrieved value — i.e. you silently overwrite whatever the other writer did. A CLI must always send `ticks`.

**(b) At `UPDATE`** — the SQL carries `WHERE Ticks = @oldTicks`; zero affected rows throws (`Signum/Engine/Schema/Schema.Save.cs:414-432`, batch variant `:496-508`):
```csharp
long oldTicks = entity.Ticks;
entity.Ticks = Clock.Now.Ticks;
...
int num = (int)new SqlPreCommandSimple(sqlUpdate, …).ExecuteNonQuery();
if (ConcurrencyLogic.IsEnabled)
{
    if (num != 1) throw new ConcurrencyException(entity.GetType(), entity.Id);
}
```
A successful save assigns `Clock.Now.Ticks` ⇒ **the response entity carries a new `ticks` the client must adopt** before the next save.

**What comes back on conflict:**
```csharp
// Signum/Engine/Exceptions.cs:341-352 — namespace Signum.Engine
public class ConcurrencyException : Exception
{
    public Type Type { get; private set; }
    public PrimaryKey[] Ids { get; private set; }
    public ConcurrencyException(Type type, params PrimaryKey[] ids)
        : base(EngineMessage.ConcurrencyErrorOnDatabaseTable0Id1.NiceToString().FormatWith(type.NiceName(), ids.ToString(", "))) { … }
}
```
`ConcurrencyException` is **not** in `GetStatus` (`SignumExceptionFilterAttribute.cs:131-146`) ⇒ **HTTP 500**, `application/json`, body = `HttpError` (§1.9). **Detection rule for a CLI: `status == 500 && exceptionType == "Signum.Engine.ConcurrencyException"`.** There is no dedicated status code and no client-side special handling anywhere in `Signum/React`.

```ts
// Signum/React/Services.ts:376-383 — the client's view of the error body
export interface WebApiHttpError {
  exceptionType: string;
  exceptionMessage: string | null;
  stackTrace: string | null;
  exceptionId: string | null;
  model?: ModelEntity;
  innerException: WebApiHttpError | null;
}
```
Validation 400s are shaped differently and are distinguished by "**400 without `exceptionType`**" (`Signum/React/Services.ts:246-249`). `ModelState` keys are dotted paths built by `SignumValidationVisitor`: `Key + "." + name`, `Key + "[" + i + "].element"`, `Key + ".mixins[" + TypeName + "]"`, `Key + ".entity"` (`Signum/API/Filters/SignumObjectValidator.cs:160, 178, 209, 232`) — e.g. `entity.songs[2].element.name`.

### 2.9 Worked examples

Model (real code, `Signum.Test/Environment/Entities.cs:326-350`):
```csharp
public class AwardNominationEntity : Entity, ICanBeOrdered
{
    [ImplementedBy(typeof(ArtistEntity), typeof(BandEntity))] public Lite<IAuthorEntity> Author { get; set; }
    [LiteModel(typeof(AwardLiteModel), ForEntityType = typeof(GrammyAwardEntity))]
    [ImplementedBy(typeof(GrammyAwardEntity), typeof(PersonalAwardEntity), typeof(AmericanMusicAwardEntity))]
    public Lite<AwardEntity> Award { get; set; }
    public int Year { get; set; }
    public int Order { get; set; }
    [PreserveOrder, NoRepeatValidator] public MList<NominationPointEmbedded> Points { get; set; } = new();
}
public class NominationPointEmbedded : EmbeddedEntity { public int Point { get; set; } }
```

**(a) Full entity with an MList of embeddeds and two Lite references.** Key names, ordering and encodings are code-derived; the *values* are illustrative — there is no golden-JSON fixture in the repo. **[INFERENCE on the values only.]**

```json
{
  "Type": "AwardNomination",
  "id": 17,
  "ticks": "638520201234567890",
  "toStr": "AwardNomination 17",
  "modified": true,
  "author": {
    "EntityType": "Artist",
    "id": 3,
    "model": "Michael Jackson"
  },
  "award": {
    "EntityType": "GrammyAward",
    "id": 42,
    "model": {
      "Type": "AwardLiteModel",
      "toStr": "Best Album 1983",
      "modified": false,
      "category": "Best Album",
      "year": 1983
    }
  },
  "year": 1984,
  "order": 0,
  "points": [
    { "rowId": 101,  "element": { "Type": "NominationPointEmbedded", "toStr": "NominationPointEmbedded", "modified": false, "point": 5 } },
    { "rowId": 102,  "element": { "Type": "NominationPointEmbedded", "toStr": "NominationPointEmbedded", "modified": true,  "point": 9 } },
    { "rowId": null, "element": { "Type": "NominationPointEmbedded", "toStr": "NominationPointEmbedded", "modified": true,  "point": 7 } }
  ]
}
```

Why each piece looks like that:
- `"Type": "AwardNomination"` — clean name, `Entity` stripped (`Reflector.cs:86-89` via `TypeLogic.TryGetCleanName`).
- `"id": 17` is a **number** because the PK is `int`; `AwardEntity` is `[PrimaryKey(typeof(long))]` so `award.id` is also a number. A `Guid` PK would be a string.
- `"ticks"` is a **string**, and it is echoed unchanged so the concurrency check actually runs (`:666-667`).
- No `"isNew"`, `"partitionId"`, `"propsMeta"` or `"mixins"` — all conditional.
- Lites carry `EntityType` + `id` + `model`; `author.model` is a plain string (default model type is `string`), `award.model` is a full `AwardLiteModel` object because a `[LiteModel]` is registered. `"ModelType"` appears **only** when the lite's model type differs from `Lite.DefaultModelType(EntityType)` (`LiteJsonConverter.cs:30-31`) — a client must handle both presence and absence.
- MList rows: `rowId` first, `element` second, nothing else; `rowId: null` = new row; array order is persisted because of `[PreserveOrder]`.
- **`"modified": true` on the root is mandatory** or nothing is applied (§2.2 point 3, and the MList assignment is skipped at `MListJsonConverter.cs:193`).

Minimal **new** entity (client → server):
```json
{
  "Type": "AwardNomination",
  "id": null,
  "isNew": true,
  "toStr": null,
  "modified": true,
  "author": { "EntityType": "Band", "id": 8 },
  "award": null,
  "year": 2026,
  "order": 0,
  "points": [ { "rowId": null, "element": { "Type": "NominationPointEmbedded", "modified": true, "point": 3 } } ]
}
```

**(b) A standalone `Lite`.** JSON object form (the only accepted form as a JSON value):
```json
{ "EntityType": "Artist", "id": 3, "model": "Michael Jackson" }
```
The same lite in the **string** form used in URLs / text / filter values (`LiteImp.cs:182-190`, `Lite.cs:183`):
```
Artist;3                          // Lite.Key()     / TS liteKey()
Artist;3;Michael Jackson          // Lite.KeyLong() / TS liteKeyLong()
```
A *fat* lite with a non-default model type, all optional members present, in write order:
```json
{
  "EntityType": "GrammyAward",
  "ModelType": "AwardLiteModel",
  "id": 42,
  "partitionId": 2,
  "model": { "Type": "AwardLiteModel", "toStr": "Best Album 1983", "modified": false, "category": "Best Album", "year": 1983 },
  "entity": {
    "Type": "GrammyAward", "id": 42, "ticks": "638520200000000000",
    "toStr": "Best Album 1983", "modified": false,
    "year": 1983, "category": "Best Album", "result": "Won"
  }
}
```
(`"result": "Won"` shows the enum-as-string rule.)

### 2.10 Entity-serialization checklist for a client implementer

1. Emit `Type` (or `EntityType` for lites) first, then the other special props (`id`, `isNew`, `ticks`, `toStr`, `modified`, `temporalId`), **then** regular camelCase props. Never place a special prop after a regular one.
2. `ticks` = string; `id` = number **or** string matching the PK type; `temporalId` = GUID string (optional, outbound only).
3. Always send `"modified": true` on every object you changed **and on its ancestors** — otherwise changes are silently dropped and MLists are not assigned.
4. Round-trip everything you received (including `propsMeta` and read-only props — they are ignored because equal). **Never invent keys**: unknown keys ⇒ 500.
5. Never send `toStr` or `Type` inside a `Lite`; never `EntityType` inside a full entity. All three are explicit `JsonException`s.
6. MList rows: exactly `{"rowId": …, "element": …}` **in that order**, no third key; `null` rowId for new rows; array position = order.
7. Dates: `DateOnly` `"yyyy-MM-dd"`, `TimeOnly` `"HH:mm:ss[.fffffff]"`, `TimeSpan` `"[d.]hh:mm:ss[.fffffff]"` — the first two use `ParseExact` and reject anything else. `DateTime` = ISO-8601. `byte[]` = base64. Enums = member-name strings. `decimal` = plain number.
8. Errors: 403 read-only/permission, 404 not found, 400 validation (`ModelState`/`ValidationProblemDetails`, no `exceptionType`), 500 concurrency (`exceptionType == "Signum.Engine.ConcurrencyException"`) and malformed JSON.

---
## 3. The DynamicQuery request/response wire format

Primary sources: `Signum/API/Controllers/QueryController.cs`, `Signum/API/Json/FilterJsonConverter.cs` (which holds *all* the request DTOs), `Signum/API/Json/ResultTableConverter.cs`, `Signum/DynamicQuery/**`, and the TS mirror `Signum/React/FindOptions.ts` + `Signum/React/QueryToken.ts` + `Signum/React/Reflection.ts`.

> Note: the request DTOs use **public fields** (`public required string queryKey;`), which serialize only because `jso.IncludeFields = true` (`Signum/API/SignumServer.cs:43`). All enums are member-name strings via `JsonStringEnumConverter` (`:48`).

### 3.1 Routes

| Purpose | Verbatim attribute | Line | Body → Response |
|---|---|---|---|
| autocomplete | `[HttpGet("api/query/findLiteLike"), ProfilerActionSplitter("types")]` | `QueryController.cs:18` | query params `types`, `subString`, `count` → `List<Lite<Entity>>` |
| all lites of a type | `[HttpGet("api/query/allLites"), ProfilerActionSplitter("types")]` | `:26` | `types` → `List<Lite<Entity>>` (refuses `EntityData.Transactional`, `:31-35`) |
| query description | `[HttpGet("api/query/description/{queryName}"), ProfilerActionSplitter("queryName")]` | `:45` | → `QueryDescriptionTS` |
| query entity row | `[HttpGet("api/query/queryEntity/{queryName}"), ProfilerActionSplitter("queryName")]` | `:52` | → `QueryEntity` |
| **parse tokens** | `[HttpPost("api/query/parseTokens")]` | `:59` | `ParseTokensRequest` → `List<QueryTokenTS>` |
| **sub tokens (discovery)** | `[HttpPost("api/query/subTokens")]` | `:76` | `SubTokensRequest` → `List<QueryTokenTS>` |
| **execute query** | `[HttpPost("api/query/executeQuery/{queryKey}"), ProfilerActionSplitter("queryKey")]` | `:95` | `QueryRequestTS` → `ResultTable` |
| lites of a query | `[HttpPost("api/query/lites/{queryKey}"), ProfilerActionSplitter("queryKey")]` | `:104` | `QueryEntitiesRequestTS` → `List<Lite<Entity>>` |
| full entities of a query | `[HttpPost("api/query/entities/{queryKey}"), ProfilerActionSplitter("queryKey")]` | `:110` | `QueryEntitiesRequestTS` → `List<Entity>` |
| **single value / aggregate** | `[HttpPost("api/query/queryValue/{queryKey}"), ProfilerActionSplitter("queryKey"), EmbeddedPropertyRouteAttribute<QueryValueResolver>]` | `:116` | `QueryValueRequestTS` → `object?` (a bare JSON scalar/array) |

- **There is no separate "query grouped" route.** Grouping is `executeQuery` with `groupResults: true`, which flips `canAggregate` for filter/order/column token parsing (`Signum/API/Json/FilterJsonConverter.cs:263-265`). `QueryGroupRequest` does not exist as a wire type.
- **`queryKey` is sent twice** (URL segment *and* body) and must match: `if (queryKey != this.queryKey) throw new ArgumentException(nameof(queryKey));` (`FilterJsonConverter.cs:250-252`, also `:204`, `:286`) → **HTTP 500** on mismatch.
- `types` for the autocomplete routes is a **comma-separated list of clean type names**: `Implementations.By(types.Split(',').Select(a => TypeLogic.GetType(a.Trim()))…)` (`QueryController.cs:42`).
- Extension hook: `public static Action<QueryRequest>? AssertQuery;` runs after parsing (`QueryController.cs:16, 99`) — apps can inject extra rejections.
- The TS client calls `"/api/query/findTypeLike?…"` (`Signum/React/Finder.tsx:2136`) but **no such route exists in this repo** — it must come from an app controller.

### 3.2 Token discovery — the CLI's best friend

```csharp
// Signum/API/Controllers/QueryController.cs:70-74
public class ParseTokensRequest { public required string queryKey; public required List<string> tokens; }
// :89-93
public class SubTokensRequest { public required string queryKey; public string? token; }   // token: null => top-level
```
Both parse with **`SubTokensOptions.All`** (`:65`, `:82`, `:84`), so discovery sees *every* token kind regardless of what `executeQuery` would accept. `subTokens` with `token: null` returns the query's root columns plus `Count` and `TimeSeries` (`Signum/DynamicQuery/QueryUtils.cs:278-289`).

Response element (`QueryController.cs:251-272`): `key`, `fullKey`, `toStr?`, `niceName?`, `queryTokenType?`, `type` (a `TypeReferenceTS`), `filterType?`, `format?`, `unit?`, `isGroupable`, `hasOrderAdapter?`, `preferEquals?`, `tsVectorFor?`, `parent?`, `propertyRoute?`, `autoExpand?`, `hideInAutoExpand?`, `subTokens?`.
⚠️ `toStr`/`niceName` are **omitted when equal** to `key`/`toStr` (`:180-185`) and the TS client re-derives them (`Signum/React/QueryToken.ts:52-59`) — a CLI must do the same fallback.

`queryTokenType` values (`QueryController.cs:274-286`): `Aggregate, Element, AnyOrAll, OperationContainer, ToArray, Manual, Nested, Snippet, TimeSeries, IndexerContainer`.

`GET api/query/description/{queryName}` → `QueryDescriptionTS` (`:139-170`) = `{ queryKey, columns: { [tokenKey]: QueryTokenTS } }`, seeded with `AggregateToken(Count)` and `TimeSeriesToken` **before** the real columns (`:148-158`).

**Recommended CLI bootstrap:** `description` for the root columns, then `subTokens` to walk/complete, then `parseTokens` to validate a user-typed token before building a request.

### 3.3 Request DTOs (verbatim C# + TS wire mirror)

```csharp
// Signum/API/Json/FilterJsonConverter.cs:225-233
public class QueryRequestTS
{
    public required string queryKey;
    public required bool groupResults;
    public required List<FilterTS> filters;
    public required List<OrderTS> orders;
    public required List<ColumnTS> columns;
    public required PaginationTS pagination;
    public SystemTimeRequest? systemTime;
}
```
```ts
// Signum/React/FindOptions.ts:319-327
export interface QueryRequest {
  queryKey: string;
  groupResults: boolean;
  filters: FilterRequest[];
  orders: OrderRequest[];
  columns: ColumnRequest[];
  pagination: Pagination;
  systemTime?: SystemTime;
}
```
`QueryUrl` on the server-side domain object is **not** part of the wire — it is taken from the HTTP `Referer` header (`QueryController.cs:98`).

```csharp
// FilterJsonConverter.cs:144-147
public class ColumnTS { public required string token; public string? displayName; }
// :301-304
public class OrderTS { public required string token; public required OrderType orderType; }
// :194-200
public class QueryValueRequestTS
{
    public required string queryKey;
    public List<FilterTS>? filters;
    public string? valueToken;
    public bool? multipleValues;
    public SystemTimeRequest? systemTime;
}
// :275-280
public class QueryEntitiesRequestTS
{
    public required string queryKey;
    public required List<FilterTS> filters;
    public required List<OrderTS> orders;
    public int? count;
}
```
```ts
// Signum/React/FindOptions.ts:302-317, 331-337
export interface OrderRequest  { token: string; orderType: OrderType }
export interface ColumnRequest { token: string; displayName: string; }
export interface QueryEntitiesRequest { queryKey: string; filters: FilterRequest[]; orders: OrderRequest[]; count: number | null; }
export interface QueryValueRequest    { queryKey: string; filters: FilterRequest[]; multipleValues?: boolean; valueToken?: string; systemTime?: SystemTime; }
```
`displayName` is nullable in C# and `displayName ?? queryToken.NiceName()` is used (`:155`) — **omit it to get the server's nice name.** `valueToken` omitted/empty ⇒ plain row count (`:210`).
`orderType` is `required`, so omitting it is a model-binding error rather than a default.

**Which token kinds each wire position accepts** (from the `SubTokensOptions` passed to `QueryUtils.Parse`):

| Wire position | Options | Line |
|---|---|---|
| `filters[].token` (condition and group) | `CanElement \| CanAnyAll` (+`CanAggregate` if `groupResults`) (+`CanTimeSeries`) | `FilterJsonConverter.cs:87`, `:133-134` |
| `columns[].token` | `CanElement \| CanToArray \| CanSnippet` + (`groupResults ? CanAggregate : CanOperation \| CanManual`) (+`CanTimeSeries`) | `:151-153` |
| `orders[].token` | `CanElement \| CanSnippet` (+`CanAggregate`) (+`CanTimeSeries`) | `:308-311` |
| `valueToken` | `CanAggregate \| CanElement` | `:210` |
| `parseTokens` / `subTokens` | `SubTokensOptions.All` | `QueryController.cs:65, 82, 84` |

```csharp
// Signum/DynamicQuery/QueryUtils.cs:717-733
public enum SubTokensOptions
{
    CanAggregate = 1, CanAnyAll = 2, CanElement = 4, CanOperation = 8,
    CanToArray = 16, CanSnippet = 32, CanManual = 64, CanTimeSeries = 128, CanNested = 256,
    All = CanAggregate | CanAnyAll | CanElement | CanOperation | CanToArray | CanSnippet | CanManual | CanTimeSeries | CanNested,
}
```
⚠️ **Gotcha:** `CanNested` is never passed by *any* HTTP path, while `CollectionNestedToken` is only produced when `options.HasFlag(SubTokensOptions.CanNested)` (`Signum/DynamicQuery/Tokens/QueryToken.cs:614-615`). So `.Nested` tokens are **discoverable via `subTokens` but not usable in `executeQuery`** in this version — even though `QueryRequest.AssertNeasted()` exists (`Signum/DynamicQuery/Requests/QueryRequest.cs:68-79`). Likely a regression; a CLI should not offer `.Nested` for queries. Similarly, `columns` does not get `CanAnyAll`, and `filters` does not get `CanToArray`/`CanSnippet`/`CanOperation`/`CanManual`.

### 3.4 **The QueryToken string grammar** (the crux)

#### Separator and parsing

```csharp
// Signum/DynamicQuery/QueryUtils.cs:370
public static readonly Regex SplitRegex = new Regex(@"(?<!\[[^\]]*)\.(?![^\[]*\])");
```
The separator is **`.` — but only dots that are NOT inside square brackets.**

```csharp
// Signum/DynamicQuery/QueryUtils.cs:372-394 (verbatim)
public static QueryToken Parse(string tokenString, QueryDescription qd, SubTokensOptions options)
{
    if (string.IsNullOrEmpty(tokenString))
        throw new ArgumentNullException(nameof(tokenString));

    //Dot not inside of brackets
    string[] parts = SplitRegex.Split(tokenString);

    string firstPart = parts.FirstEx();

    QueryToken? result = SubToken(null, qd, options, firstPart);

    if (result == null)
        throw new FormatException("Column '{0}' not found on query {1}".FormatWith(firstPart, QueryUtils.GetKey(qd.QueryName)));

    foreach (var part in parts.Skip(1))
    {
        var newResult = SubToken(result, qd, options, part);
        result = newResult ?? throw new FormatException("Token with key '{0}' not found on token '{1}' of query {2}".FormatWith(part, result.FullKey(), QueryUtils.GetKey(qd.QueryName)));
    }

    return result;
}
```
Per-segment resolution (`QueryUtils.cs:258-276`, `:345-360`): if this is the **first** segment it must match a `ColumnDescription.Name` of the query, else (with `CanAggregate`) an aggregate key, else (with `CanTimeSeries`, root only) the literal `TimeSeries`. Otherwise it is an **exact, case-sensitive dictionary lookup** on the parent token's sub-tokens (`Signum/DynamicQuery/Tokens/QueryToken.cs:226-241`), which additionally enforces per-token authorization:
```csharp
string? allowed = result.IsAllowed();
if (allowed != null)
    throw new UnauthorizedAccessException($"Access to token '{FullKey()}.{key}' in query '{QueryUtils.GetKey(QueryName)}' is not allowed because: {allowed}");
```
And the round-trip:
```csharp
// Signum/DynamicQuery/Tokens/QueryToken.cs:667-673
public string FullKey()
{
    if (Parent == null) return Key;
    return Parent.FullKey() + "." + Key;
}
```
So a token string is exactly `Key ("." Key)*`.

#### Grammar (formalised — **[INFERENCE]**, distilled from the key-producing code below)

```
tokenString  := segment ( "." segment )*
segment      := plainKey | bracketKey | parenKey
plainKey     := [A-Za-z0-9_#]+           ; property/column/aggregate/date-part/Step0_1/x1_5/Mod100/Order#Save
bracketKey   := "[" <any chars except ']'> "]"   ; [Operations] [QuickLinks] [EntityType] [MyDict] [SomeKey] [null]
parenKey     := "(" cleanTypeName ")"            ; AsTypeToken, e.g. (Order)
```
There is **no escaping and no quoting** for a literal `.` outside brackets. Note the deliberate substitution: operation keys contain a `.`, so they are re-encoded with `#` (see `OperationToken` below).

#### The `Entity` prefix / "entity dot"

`Entity` is not special syntax — it is a **plain first segment** resolved as a `ColumnToken` whose `ColumnDescription.Name == "Entity"`:
```csharp
// Signum/DynamicQuery/QueryDescription.cs:17
public const string Entity = "Entity";
```
Its type is `Lite<T>`, so sub-token generation follows the `cleanType.IsIEntity()` branch (`QueryToken.cs:308-338`) and yields `Id`, `ToString`, optionally `PartitionId`, `SystemValidFrom`/`SystemValidTo`, `[Operations]`, `[QuickLinks]`, then **all entity properties** (including flattened mixin properties, `:659-662`), then tsvector/vector columns, then `HasValue`. Hence `Entity.Customer.Name`, `Entity.Id`, `Entity.ToString`, `Entity.(Order).OrderDate.Year`, `Entity.[Operations].Order#Save` are all valid. **This is the "string-embedded Lite navigation"** — you simply keep dotting through the `Lite<T>`; there is no dereference operator.

The TS token builder confirms the encodings (`Signum/React/Reflection.ts`):
```ts
:1604-1606  static entity<T>() { return new QueryTokenString<T>("Entity"); }
:1620-1622  getToString()      => + ".ToString"
:1624-1626  cast(t)            => + ".(" + t.typeName + ")"
:1696-1698  "Count" + ((option == undefined) ? "" : option)   // option?: "Distinct" | "Null" | "NotNull"
:1732-1734  operation(os)      => + ".[Operations]." + os.key.replace(".", "#")
:1740-1742  indexer(prefix,key)=> + ".[" + prefix + "].[" + key + "]"
:1744-1746  mlistElementProperty("RowId" | "RowOrder" | "RowPartitionId")
:1753-1758  a lambda's `toStr` maps to the segment `ToString`; `.entity` is stripped when navigating a Lite<T>
```

#### Complete token-kind → literal key table

Every `QueryToken` subclass in `Signum/DynamicQuery/Tokens/`:

| Token class | Literal key produced | Key source | Created at |
|---|---|---|---|
| `ColumnToken` | the query column name (`Entity`, `Id`, `Customer`, …) | `ColumnToken.cs:24-27` (`Column.Name`) | `QueryUtils.cs:354, 365` — **root only** |
| `EntityPropertyToken` | PascalCase property name (`Name`, `Customer`, `Details`) | `EntityPropertyToken.cs:58-61` | `QueryToken.cs:651-664` |
| `EntityPropertyToken.IdProperty` | `Id` | `EntityPropertyToken.cs:12-16` | `QueryToken.cs:322` |
| `EntityPropertyToken.PartitionIdProperty` | `PartitionId` | `:18-22` | `:324` (only if `QueryLogic.HasPartitionId`) |
| `EntityToStringToken` | `ToString` | `EntityToStringToken.cs:26-29` | `:323` |
| `EntityTypeToken` | `[EntityType]` | `EntityTypeToken.cs:28-31` | `:312, 337` (ImplementedByAll / multi-impl) |
| `AsTypeToken` | `(Order)`, `(Customer)` — **parens are part of the key** | `AsTypeToken.cs:31-34` (`"({0})".FormatWith(TypeLogic.GetCleanName(entityType))`) | `:337` |
| `SystemTimeToken` | `SystemValidFrom` / `SystemValidTo` | `SystemTimeToken.cs:30-33` | `:325-326` (only if system-versioned) |
| `OperationsContainerToken` | `[Operations]` | `OperationsContainerToken.cs:31` | `:327` (needs `CanOperation`) |
| `OperationToken` | operation key with `.` → `#`, e.g. **`Order#Save`** | `OperationsContainerToken.cs:41` (`o.Key.Replace(".", "#")`) | `:40-42` |
| `QuickLinksToken` | `[QuickLinks]` | `QuickLinksToken.cs:9` | `:328` (needs `CanManual`) |
| `ManualToken` | **arbitrary** — any segment after a manual container is accepted verbatim | `ManualToken.cs:36`; `QueryToken.cs:228-229` | |
| `CountToken` | `Count` (collection element count, `int?`) | `CountToken.cs:27-30` | `:609` |
| `AggregateToken` | `Count`, `Average`, `Sum`, `Min`, `Max`, `CountDistinct`, `CountNull`, `CountNotNull`, `Count<EnumValue>`, `CountNot<EnumValue>`, `CountTrue`, `CountFalse` | `AggregateToken.cs:152-192` | `QueryUtils.cs:292-343` |
| `CollectionElementToken` | `Element`, `Element2`, `Element3` | `CollectionElementToken.cs:60-63` | `:611-612` (needs `CanElement`) |
| `CollectionAnyAllToken` | `Any`, `All`, `NotAny`, `NotAll` | `CollectionAnyAllToken.cs:39-42` | `:617-618` (needs `CanAnyAll`) |
| `CollectionNestedToken` | `Nested` | `CollectionNestedToken.cs:33-36` | `:614-615` (needs `CanNested` — see the gotcha in §3.3) |
| `CollectionToArrayToken` | `SeparatedByComma`, `SeparatedByCommaDistinct`, `SeparatedByNewLine`, `SeparatedByNewLineDistinct` | `CollectionToArrayToken.cs:39-42` | `:620-621` (needs `CanToArray`) |
| `MListElementPropertyToken` | `RowId`, `RowOrder`, `RowPartitionId` — only as a child of `Element*`/`Any*`/`All*`/`Nested`/`SeparatedBy*` | `MListElementPropertyToken.cs:19-37, 62` | `CollectionElementToken.cs:72-79` etc. |
| `NetPropertyToken` | see the date/time/string table below | `NetPropertyToken.cs:42-45` (`MemberInfo.Name`) | `QueryToken.cs:410-581` |
| `DateToken` | `Date` (DateTime → DateOnly; no sub-tokens) | `DateToken.cs:40-43` | `:447` |
| `DatePartStartToken` | `MonthStart`, `QuarterStart`, `WeekStart`, `HourStart`, `MinuteStart`, `SecondStart`, plus stepped: `Every12Hours`, `Every6Hours`, `Every4Hours`, `Every3Hours`, `Every2Hours`, `Every30Minutes`, `Every20Minutes`, `Every10Minutes`, `Every5Minutes`, `Every4Minutes`, `Every3Minutes`, `Every2Minutes`, `Every30Seconds`, `Every20Seconds`, `Every10Seconds`, `Every5Seconds`, `Every4Seconds`, `Every3Seconds`, `Every2Seconds`, `Every500Milliseconds`, `Every200Milliseconds`, `Every100Milliseconds` | `DateTimeSpecialTokens.cs:124-133` | `:450-482` (DateTime), `:513-541` (TimeSpan), `:558-560` (TimeOnly), `:577-579` (DateOnly) |
| `HasValueToken` | `HasValue` — appended to nearly every value/entity/collection token | `HasValueToken.cs:50-53` | `:282-347` via `.AndHasValue(this)` |
| `StepToken` | `Step0_0001` … `Step1000000` (`"Step" + size, '.'→'_'`) | `DecimalSpecialTokens.cs:40-43` | `:296-300` |
| `StepMultiplierToken` | `x1`, `x1_2`, `x1_5`, `x2`, `x2_5`, `x3`, `x4`, `x5`, `x6`, `x8` (child of a `Step*`) | `DecimalSpecialTokens.cs:138-141` | `:45-60` |
| `StepRoundingToken` | `Floor`, `Ceil`, `Round`, `RoundMiddle` (child of an `x*`) | `DecimalSpecialTokens.cs:231-234` | `:150-158` |
| `ModuloToken` | `Mod10`, `Mod100`, `Mod1000`, `Mod10000` (integers only) | `DecimalSpecialTokens.cs:374-377` | via `:300` |
| `TranslatedToken` | `Translated` | `TranslatedToken.cs:25-28` | if `PropertyRouteTranslationLogic.IsTranslateable` |
| `StringSnippetToken` | `Snippet` | `StringSnippetToken.cs:22` | `EntityPropertyToken.cs:168-171` (needs `CanSnippet` **and** a large/unbounded string column, `:38-46`) |
| `FullTextRankToken` / `PgTsRankToken` | `Rank` | `FullTextRankToken.cs:19`, `PgTsRankToken.cs:21` | full-text indexed columns |
| `PgTsVectorColumnToken` | the tsvector column name (TS default `"tsvector"`) | `PgTsVectorColumnToken.cs:25` | `:353-377` |
| `VectorColumnToken` / `VectorDistanceToken` | the vector property name / `Distance` | `VectorColumnToken.cs:24`, `VectorDistanceToken.cs:22` | `:379-408` |
| `ExtensionToken` | the registered-expression name, e.g. `TotalPrice` | `ExtensionToken.cs:58` | `:261-267` (`QueryLogic.Expressions.GetExtensionsTokens`) |
| `IndexerContainerToken` | `[MyDictionary]` (`"[" + info.Prefix + "]"`) | `IndexerContainerToken.cs:31` | `:269-272` |
| `ExtensionWithParameterToken<T,K,V>` | `[SomeKey]`, `[null]` | `IndexerContainerToken.cs:109` | `:37` |
| `TimeSeriesToken` | `TimeSeries` — **root only** | `TimeSeriesToken.cs:29-34` (`public const string KeyText = "TimeSeries";`) | `QueryUtils.cs:272-273, 285-286` |

Aggregate key construction, verbatim:
```csharp
// Signum/DynamicQuery/Tokens/AggregateToken.cs:152-192
public override string Key
{
    get
    {
        var distinct = this.Distinct ? "Distinct" : null;

        var op =
            this.FilterOperation == null ? null :
            this.FilterOperation == DynamicQuery.FilterOperation.EqualTo ? "" :
            this.FilterOperation == DynamicQuery.FilterOperation.DistinctTo ? "Not" :
            this.FilterOperation.Value.ToString();

        var value =
            this.FilterOperation == null ? null :
            this.Value == null ? "Null" :
            this.Value.ToString();

        return AggregateFunction.ToString() + distinct + op + value;
    }
}
```
```csharp
// Signum/DynamicQuery/Tokens/AggregateToken.cs:214-221
public enum AggregateFunction { Count, Average, Sum, Min, Max, }
```
Which aggregates are offered where (`QueryUtils.cs:292-343`): root ⇒ `Count`; numeric/bool ⇒ `Average`, `Sum`, `Min`, `Max`; DateTime/Time ⇒ `Min`, `Max`; any filterable ⇒ `CountNotNull` and `CountNull`; groupable ⇒ `CountDistinct`; enums ⇒ `Count<Value>` / `CountNot<Value>` per member; bool ⇒ `CountTrue`, `CountFalse`.

#### Date / time / string / numeric sub-token keys (`NetPropertyToken`)

- **`DateTime`** (`QueryToken.cs:424-485`, gated by the column's `DateTimePrecision`): `Year`, `Quarter`, `Month`, `WeekNumber`, `DayOfYear`, `Day`, `DayOfWeek`, `Hour`, `Minute`, `Second`, `Millisecond`, `TimeOfDay` — plus `Date` and the `*Start`/`Every*` tokens. (`Quarter`/`WeekNumber` come from extension *methods*, so the key is the method name.)
- **`DateTimeOffset`** (`:488-496`): `UtcDateTime`, `DateTime`.
- **`DateOnly`** (`:565-581`): `Year`, `Quarter`, `Month`, `WeekNumber`, `DayOfYear`, `Day`, `DayOfWeek`, `QuarterStart`, `WeekStart`, `MonthStart`.
- **`TimeSpan`** (`:498-545`): `Hours`, `Minutes`, `Seconds`, `Milliseconds`, `TotalDays`, `TotalHours`, `TotalMinutes`, `TotalSeconds`, `TotalMilliseconds` + `*Start`/`Every*`. ⚠️ **Note the plural** — `TimeSpan.Hours` ⇒ `Hours`, unlike `DateTime.Hour`.
- **`TimeOnly`** (`:547-563`): `Hour`, `Minute`, `Second`, `Millisecond`, `HourStart`, `MinuteStart`, `SecondStart`.
- **`string`** (`:410-416`): exactly one — **`Length`** — plus `HasValue`.
- **`Guid`** (`:305-306`): only `HasValue`.

#### Extra validity gates beyond parsing

`QueryUtils.CanFilter` (`QueryUtils.cs:432-444`) / `CanColumn` (`:446-…`): you cannot **filter** by a collection type, nor by `OperationsContainerToken`/`OperationToken`/`ManualContainerToken`/`ManualToken`/`IndexerContainerToken`; you cannot use a collection or a `Vector` as a **column**. `QueryUtils.TryParse` (`:396-430`) is the non-throwing variant with `out string? error, out QueryToken? lastParsedToken` — **not exposed over HTTP**, so a CLI validating a token must use `POST api/query/parseTokens` and catch the 500.

### 3.5 Filters: conditions vs groups, and `FilterOperation`

**The discriminator is the presence of `operation` vs `groupOperation` — there is no `$type`.**

```csharp
// Signum/API/Json/FilterJsonConverter.cs:23-49 (verbatim Read)
public override FilterTS? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
{
    using (var doc = JsonDocument.ParseValue(ref reader))
    {
        var elem = doc.RootElement;

        if (elem.TryGetProperty("operation", out var oper))
        {
            return new FilterConditionTS
            {
                token = elem.GetProperty("token").GetString()!,
                operation = oper.GetString()!.ToEnum<FilterOperation>(),
                value = elem.TryGetProperty("value", out var val) ? val.ToObject<object>(options) : null,
            };
        }

        if (elem.TryGetProperty("groupOperation", out var groupOper))
            return new FilterGroupTS
            {
                groupOperation = groupOper.GetString()!.ToEnum<FilterGroupOperation>(),
                token = elem.TryGetProperty("token", out var token) ? token.GetString() : null,
                filters = elem.GetProperty("filters").EnumerateArray().Select(a => a.ToObject<FilterTS>()!).ToList()
            };

        throw new InvalidOperationException("Impossible to determine type of filter");
    }
}
```
Rules:
- `operation` present ⇒ **condition**; `token` is then **mandatory** (`elem.GetProperty("token")` throws); `value` optional (absent ⇒ `null`).
- else `groupOperation` present ⇒ **group**; `token` optional/nullable; `filters` **mandatory**.
- `operation` wins if both appear (ordering of the two `if`s). **[INFERENCE]**
- Neither ⇒ `InvalidOperationException("Impossible to determine type of filter")` ⇒ **HTTP 500**.
- Enum parsing is `.ToEnum<FilterOperation>()` on the raw string ⇒ **exact member name required**.

```csharp
// Signum/API/Json/FilterJsonConverter.cs:79-83, 125-129
public class FilterConditionTS : FilterTS { public required string token; public FilterOperation operation; public object? value; }
public class FilterGroupTS     : FilterTS { public FilterGroupOperation groupOperation; public string? token; public required List<FilterTS> filters; }
```
```ts
// Signum/React/FindOptions.ts:288-300
export type FilterRequest = FilterConditionRequest | FilterGroupRequest;
export interface FilterGroupRequest     { groupOperation: FilterGroupOperation; token?: string; filters: FilterRequest[]; }
export interface FilterConditionRequest { token: string; operation: FilterOperation; value: any; }
```
**Group semantics:** `And`/`Or` aggregate the children (`Signum/DynamicQuery/Requests/Filter.cs:167-169`), and — crucially — a group whose `token` ends in an `Any`/`All` collection token makes **all its children apply to the same collection element** (`Filter.cs:161-170`). Groups nest arbitrarily (`filters` is `List<FilterTS>` recursing through the same converter).

**`FilterOperation` — complete list, declaration order** (`Signum/DynamicQuery/Requests/Filter.cs:557-617`; the literal serialized names are the identifiers):

`EqualTo`, `DistinctTo`, `GreaterThan`, `GreaterThanOrEqual`, `LessThan`, `LessThanOrEqual`, `Contains`, `StartsWith`, `EndsWith`, `Like`, `NotContains`, `NotStartsWith`, `NotEndsWith`, `NotLike`, `IsIn`, `IsNotIn`, `ComplexCondition`, `FreeText`, `TsQuery`, `TsQuery_Plain`, `TsQuery_Phrase`, `TsQuery_WebSearch`, `SmartSearch`, `Between`, `BetweenNoEnd`

Confirmed verbatim in the generated TS (`Signum/React/Signum.DynamicQuery.ts:33-59`):
```ts
export type FilterOperation =
  "EqualTo" | "DistinctTo" | "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual" |
  "Contains" | "StartsWith" | "EndsWith" | "Like" | "NotContains" | "NotStartsWith" | "NotEndsWith" |
  "NotLike" | "IsIn" | "IsNotIn" | "ComplexCondition" | "FreeText" | "TsQuery" | "TsQuery_Plain" |
  "TsQuery_Phrase" | "TsQuery_WebSearch" | "SmartSearch" | "Between" | "BetweenNoEnd";
```
```csharp
// Signum/DynamicQuery/Requests/Filter.cs:12-16
public enum FilterGroupOperation { And, Or, }
```

**Shape of `value` per operation:**
```csharp
// Signum/DynamicQuery/Requests/Filter.cs:277-289
public static Type GetValueType(QueryToken token, FilterOperation operation)
{
    if (operation.IsTsQuery())               return typeof(string);
    if (operation == FilterOperation.SmartSearch) return typeof(string);
    if (operation.IsList() || operation.IsPair())
        return typeof(IEnumerable<>).MakeGenericType(token.Type.Nullify());
    return token.Type;
}
```
with `QueryUtils.cs:688-709`: `IsList()` = `IsIn`/`IsNotIn`; `IsPair()` = `Between`/`BetweenNoEnd`; `IsTsQuery()` = the four `TsQuery*`.
⇒ **`IsIn`, `IsNotIn`, `Between`, `BetweenNoEnd` take a JSON array**; `TsQuery*`/`SmartSearch` take a string; everything else takes the token's own type. A wrong type gives `InvalidOperationException("Invalid value when filtering by " + token)` (`FilterJsonConverter.cs:98-101`) ⇒ 500. `DateTime` values are re-kinded to `parsedToken.DateTimeKind` (`:103-117`).
A `Lite` filter value uses the §2.3 object form; the minimum is `{"EntityType":"Order","id":42}`.

`FilterType` (on `QueryTokenTS.filterType`, tells the CLI what value shape a token wants) — `Signum/DynamicQuery/Requests/Filter.cs:618-633`: `Integer, Decimal, String, DateTime, Time, Lite, Embedded, Model, Boolean, Enum, Guid, TsVector, Vector`.

### 3.6 Pagination

Discriminator field: **`mode`**.
```csharp
// Signum/API/Json/FilterJsonConverter.cs:162-189
public class PaginationTS
{
    public PaginationMode mode;
    public int? elementsPerPage;
    public int? currentPage;
    ...
    public Pagination ToPagination()
    {
        return mode switch
        {
            PaginationMode.All      => new Pagination.All(),
            PaginationMode.Firsts   => new Pagination.Firsts(this.elementsPerPage!.Value),
            PaginationMode.Paginate => new Pagination.Paginate(this.elementsPerPage!.Value, this.currentPage!.Value),
            _ => throw new InvalidOperationException($"Unexpected {mode}"),
        };
    }
}
```
```csharp
// Signum/DynamicQuery/Requests/QueryRequest.cs:121-129
public enum PaginationMode { All, [Description("First")] Firsts, [Description("Pages")] Paginate }
```
```ts
// Signum/React/FindOptions.ts:352-356
export interface Pagination { mode: PaginationMode; elementsPerPage?: number; currentPage?: number; }
```

| `mode` | required fields | notes |
|---|---|---|
| `"All"` | — | `elementsPerPage`/`currentPage` ignored |
| `"Firsts"` | `elementsPerPage` | `currentPage` ignored; null `elementsPerPage` ⇒ 500 |
| `"Paginate"` | `elementsPerPage` **and** `currentPage` | ctor throws if either `<= 0` (`QueryRequest.cs:294-304`); **`currentPage` is 1-based** |

Default page size `Pagination.Firsts.DefaultTopElements = 20` (`QueryRequest.cs:275`). Index math: `StartElementIndex() => (ElementsPerPage * (CurrentPage - 1)) + 1` (`:309`), `TotalPages(total) => (total + ElementsPerPage - 1) / ElementsPerPage` (`:311`).

⚠️ **`totalElements` availability** (`Signum/DynamicQuery/DQueryable.cs:957-1008`): `All` ⇒ `allList.Count`; **`Firsts` ⇒ `null`** (no `COUNT(*)` is issued); `Paginate` ⇒ a real count. A CLI that wants a total must use `Paginate` or `All`.

### 3.7 Ordering

```csharp
// Signum/DynamicQuery/Requests/Order.cs:40-45
public enum OrderType { Ascending, Descending }
```
Wire object: `{ "token": "...", "orderType": "Ascending" }`. A `Snippet` order is silently rewritten into a full-text `Rank` order with **inverted** direction (`Order.cs:26-37`) — a CLI should not be surprised by that.

### 3.8 SystemTime (temporal queries)

```csharp
// Signum/DynamicQuery/Requests/QueryRequest.cs:138-146
public class SystemTimeRequest
{
    public SystemTimeMode mode;
    public SystemTimeJoinMode? joinMode;
    public DateTime? startDate;
    public DateTime? endDate;
    public int? timeSeriesStep;
    public TimeSeriesUnit? timeSeriesUnit;
    public int? timeSeriesMaxRowsPerStep;
}
// :209-239
public enum SystemTimeMode     { AsOf, Between, ContainedIn, All, TimeSeries, }
public enum TimeSeriesUnit     { Year, Quarter, Month, Week, Day, Hour, Minute, Second, Millisecond, }
public enum SystemTimeJoinMode { Current, FirstCompatible, AllCompatible, }
```

| `mode` | requires |
|---|---|
| `"AsOf"` | `startDate` |
| `"Between"` | `startDate`, `endDate`, `joinMode` |
| `"ContainedIn"` | `startDate`, `endDate`, `joinMode` |
| `"All"` | `joinMode` |
| `"TimeSeries"` | `timeSeriesUnit`, `timeSeriesStep`, `startDate`/`endDate`; `ToSystemTime()` returns `null` (`:203`) |

`"TimeSeries"` additionally **unlocks `CanTimeSeries`** for filter/order/column parsing (`FilterJsonConverter.cs:256, 263-265`), i.e. it makes the root `TimeSeries` token usable. `SystemTimeToken` (`SystemValidFrom`/`SystemValidTo`) is always `DateTimeKind.Utc` (`SystemTimeToken.cs:23`).

⚠️ The TS interface (`Signum/React/FindOptions.ts:358-368`) contains **`splitQueries?: boolean` which has no C# counterpart** — it is purely client-side (`Finder.tsx:2108-2110`). **Do not send it.**
Also: `IsSystemVersioned` on `TypeInfoTS` (§5.2, `ReflectionServer.cs:267`) is how a CLI discovers which types support temporal queries at all.

### 3.9 `ResultTable` response shape

```csharp
// Signum/API/Json/ResultTableConverter.cs:10-98 — emission order
"columns"        // string[] of QueryToken FullKey()
"uniqueValues"   // { [tokenFullKey]: any[] }   — the string-interning table
"pagination"     // a PaginationTS echo
"totalElements"  // number or explicit null
"rows"           // [ { "entity"?: Lite, "columns": any[] } ]
```
`Read` throws `NotImplementedException` (`:144-147`) — **response-only**.

```ts
// Signum/React/FindOptions.ts:339-350
export interface ResultTable {
  columns: string[];
  uniqueValues: { [token: string]: any[] }
  rows: ResultRow[];
  pagination: Pagination
  totalElements?: number;
}
export interface ResultRow { entity: Lite<Entity> | undefined; columns: any[]; }
```

**Four semantics a client MUST implement:**

1. **Positional alignment.** `columns[j]` names the token whose value is at `rows[i].columns[j]`.
2. **Value interning — this will silently corrupt results if ignored.** If `columns[j]` is a key in `uniqueValues`, then `rows[i].columns[j]` is an **integer index into `uniqueValues[columns[j]]`** (or `null`), *not* the value. The reference decompression pass:
   ```ts
   // Signum/React/Finder.tsx:2009-2026
   export function decompress(rt: ResultTable): ResultTable {
     var rows = rt.rows; var columns = rt.columns;
     for (var i = 0; i < columns.length; i++) {
       var uniqueValues = rt.uniqueValues[columns[i]];
       if (uniqueValues != null) {
         for (var j = 0; j < rows.length; j++) {
           var row = rows[j];
           var index = row.columns[i] as number | null;
           if (index != null) row.columns[i] = uniqueValues[index];
         }
       }
     }
     return rt;
   }
   ```
   Which columns get compressed (`Signum/DynamicQuery/DQueryable.cs:1451-1452`):
   ```csharp
   if (req.SystemTime == null && (token.Type.IsLite() || isMultiKeyGrupping && token is not AggregateToken) && token.HasToArray() == null)
       rc.CompressUniqueValues = true;
   ```
   with `isMultiKeyGrupping = req.GroupResults && req.Columns.Count(col => col.Token is not AggregateToken) >= 2` (`:1437`). ⇒ **Every `Lite` column is compressed whenever `systemTime == null`.** A CLI must always run the decompress pass.
3. **The `Entity` column is hoisted out of `columns` into `rows[i].entity`** for non-grouped queries, and the server **injects it whether you asked or not**:
   ```csharp
   // Signum/DynamicQuery/Requests/ResultTable.cs:53-56
   this.entityColumn = isGroupResults ? null : columns.SingleOrDefault(c => c.Token.IsEntity());
   this.columns = columns.Where(c => c.Token.IsAllowed() == null && (isGroupResults || !c.Token.IsEntity())).ToArray();
   ```
   ```csharp
   // Signum/DynamicQuery/AutoDynamicQuery.cs:96-98
   var columns = request.Columns.Select(a => a.Token).ToHashSet();
   if (!columns.Any(t => t.IsEntity()))
       columns.Add(new ColumnToken(EntityColumnFactory().BuildColumnDescription(), QueryName));
   ```
   ⇒ with `groupResults: false`, `rows[i].entity` is **always present** and `"Entity"` **never appears** in `columns` even if requested. With `groupResults: true` there is no `entity` and a requested `Entity` column stays in `columns`.
4. **Unauthorized columns are dropped** from the response (`IsAllowed() == null` filter, `ResultTable.cs:56`) ⇒ **the returned `columns` array can be shorter than the requested one.** Always key off the returned `columns`, never your request.

Plus: `totalElements` is written explicitly and may be `null` (`ResultTableConverter.cs:49-53`) even though the TS types it optional; and nested sub-tables would appear as a whole `ResultTable` object inside `rows[i].columns[j]` (`DQueryable.cs:1463-1505`) — moot today given the `CanNested` gap (§3.3).

### 3.10 Errors (query-specific)

The global mapping of §1.9 applies. Query-specific triggers:

| Client mistake | Result |
|---|---|
| bad token string | `FormatException("Column 'X' not found on query Q")` / `("Token with key 'X' not found on token 'Y' of query Q")` ⇒ **500**, `exceptionType: "System.FormatException"` (`QueryUtils.cs:385, 390`) |
| token not permitted for the caller | `UnauthorizedAccessException` ⇒ **403** (`QueryToken.cs:238`) |
| `queryKey` in URL ≠ body | `ArgumentException` ⇒ **500** (`FilterJsonConverter.cs:251`) |
| filter with neither `operation` nor `groupOperation` | `InvalidOperationException` ⇒ **500** (`FilterJsonConverter.cs:47`) |
| wrong `value` type for the operation | `InvalidOperationException("Invalid value when filtering by …")` ⇒ **500** (`:100`) |
| `mode:"Firsts"` without `elementsPerPage` | `InvalidOperationException` ⇒ **500** (`:185`) |
| missing `required` member / malformed JSON | **400** with a `ModelState` dict, or `AggregateException` ⇒ **500** (`ValidateModelFilterAttribute.cs:22-25`) |

⚠️ Note that **most user errors are 500s, not 400s**, because they are plain `FormatException`/`InvalidOperationException`. A CLI should therefore surface `exceptionMessage` prominently rather than saying "server error", and pre-validate tokens via `parseTokens`.
Also: `HttpError.exceptionType` is the **full .NET type name** (`e.GetType().FullName`, `SignumExceptionFilterAttribute.cs:158`) while the TS client switches on short names (`Signum/React/Services.ts:345-350`) — **suffix-match**, don't equality-match.

### 3.11 Worked examples

**[INFERENCE on the token/value specifics]** — hand-written from the DTOs and converters above; no fixture in the repo. Real token names come from `GET api/query/description/{queryKey}`.

#### Request: two filters (one inside an Or-group), a sort, Paginate

```http
POST /api/query/executeQuery/Order HTTP/1.1
Host: signum.example.internal
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json
Accept: application/json
```
```json
{
  "queryKey": "Order",
  "groupResults": false,
  "filters": [
    { "token": "Entity.State", "operation": "EqualTo", "value": "Shipped" },
    {
      "groupOperation": "Or",
      "filters": [
        { "token": "Entity.Customer.Name", "operation": "StartsWith", "value": "Ac" },
        { "token": "Entity.OrderDate.Year", "operation": "IsIn", "value": [2024, 2025] },
        {
          "groupOperation": "And",
          "token": "Entity.Details.Any",
          "filters": [
            { "token": "Entity.Details.Any.Product.UnitPrice", "operation": "GreaterThan", "value": 100 },
            { "token": "Entity.Details.Any.Quantity", "operation": "GreaterThanOrEqual", "value": 5 }
          ]
        }
      ]
    }
  ],
  "columns": [
    { "token": "Entity" },
    { "token": "Id" },
    { "token": "Entity.OrderDate", "displayName": "Ordered on" },
    { "token": "Entity.Customer" },
    { "token": "Entity.Customer.Name" },
    { "token": "Entity.Details.Count" },
    { "token": "Entity.ShipAddress.City" }
  ],
  "orders": [
    { "token": "Entity.OrderDate", "orderType": "Descending" },
    { "token": "Id", "orderType": "Ascending" }
  ],
  "pagination": { "mode": "Paginate", "elementsPerPage": 3, "currentPage": 2 }
}
```

Why each piece is legal:
- Top-level `filters` are implicitly ANDed; the second entry is an `Or` group containing a nested `And` group whose `token: "Entity.Details.Any"` pins **all its children to the same collection element** (`Filter.cs:161-170`).
- `Any` needs `CanAnyAll`, which filter tokens do get (`FilterJsonConverter.cs:87`). ✔
- `IsIn` takes an array (`Filter.cs:285-286`). ✔
- `Entity.OrderDate.Year` is a `NetPropertyToken` (`QueryToken.cs:433`); `Entity.Details.Count` is a `CountToken` (`:609`). ✔
- `{ "token": "Entity" }` with `displayName` omitted ⇒ server nice name; the column will **not** appear in the response `columns` (§3.9 rule 3). ✔
- No `systemTime` ⇒ `canTimeSeries: false` and Lite columns get interned (`DQueryable.cs:1451`). ✔

#### Matching `ResultTable` response

`200 OK`, `application/json`, pretty-printed (`WriteIndented = true`):
```json
{
  "columns": [
    "Id",
    "Entity.OrderDate",
    "Entity.Customer",
    "Entity.Customer.Name",
    "Entity.Details.Count",
    "Entity.ShipAddress.City"
  ],
  "uniqueValues": {
    "Entity.Customer": [
      { "EntityType": "Company", "id": 7,  "model": "Acme Corp" },
      { "EntityType": "Person",  "id": 31, "model": "Ada Lovelace" }
    ]
  },
  "pagination": { "mode": "Paginate", "elementsPerPage": 3, "currentPage": 2 },
  "totalElements": 47,
  "rows": [
    {
      "entity": { "EntityType": "Order", "id": 1042, "model": "Order 1042" },
      "columns": [ 1042, "2025-03-14T09:30:00", 0, "Acme Corp", 4, "Berlin" ]
    },
    {
      "entity": { "EntityType": "Order", "id": 1039, "model": "Order 1039" },
      "columns": [ 1039, "2025-02-02T16:05:00", 1, "Ada Lovelace", 1, null ]
    },
    {
      "entity": { "EntityType": "Order", "id": 1038, "model": "Order 1038" },
      "columns": [ 1038, "2024-11-21T11:00:00", 0, "Acme Corp", 12, "Hamburg" ]
    }
  ]
}
```
Reading it correctly:
- `"Entity"` is **absent** from `columns`; each row carries `entity` instead.
- `Entity.Customer` is a Lite column ⇒ it appears in `uniqueValues`, so `rows[i].columns[2]` holds `0`/`1` — **indices**, not objects.
- `Entity.ShipAddress.City` shows a genuine `null` (that column is *not* interned).
- `totalElements: 47` because `mode == "Paginate"`; with `"Firsts"` it would be `null`.

#### Companion calls

Aggregate without grouping:
```json
POST /api/query/queryValue/Order
{ "queryKey": "Order", "valueToken": "Entity.TotalPrice.Sum", "filters": [] }
```
→ body is a **bare JSON number**.

Grouped query (`groupResults: true` unlocks aggregates in columns/orders/filters):
```json
POST /api/query/executeQuery/Order
{
  "queryKey": "Order",
  "groupResults": true,
  "filters": [],
  "columns": [
    { "token": "Entity.OrderDate.MonthStart" },
    { "token": "Count" },
    { "token": "Entity.TotalPrice.Sum" },
    { "token": "Entity.Customer.CountDistinct" }
  ],
  "orders": [ { "token": "Entity.OrderDate.MonthStart", "orderType": "Ascending" } ],
  "pagination": { "mode": "All" }
}
```

Token discovery (the recommended CLI bootstrap):
```json
POST /api/query/subTokens
{ "queryKey": "Order", "token": "Entity.Customer" }
```
→ `List<QueryTokenTS>`; each element's `key` is one dotted segment and `fullKey` is the complete token string to put in a request (`QueryController.cs:178-179`).

### 3.12 Residual uncertainties in this section

- Whether the *host application* sets `PropertyNamingPolicy` is outside this repo; camelCase for `HttpError` is inferred from `Services.ts` expecting `exceptionType`. All request-DTO field names and all `ResultTable` key names are hard-coded and unaffected.
- `api/query/findTypeLike` is called by the TS client but has **no server implementation in this repository**.
- `ExtensionToken`, `IndexerContainerToken`, `ManualToken` and `OperationToken` keys are **application-defined at runtime** — there is no static list. Discover them via `POST api/query/subTokens`.
- `StepMultiplierToken.Key` uses `Multiplier.ToString()` **without `InvariantCulture`** (`DecimalSpecialTokens.cs:140`), unlike `StepToken` (`:42`) — under a comma-decimal server culture the key could come out as `x1,2`. Latent, unverified at runtime.
- The `CanNested` omission in `ColumnTS.ToColumn` (§3.3) looks like a regression; read from code, not exercised.
- `Extensions/**` adds further controllers (Chart, Excel, UserQuery, Dashboard, Toolbar…) that consume these same `QueryRequestTS`/`FilterTS` DTOs — out of scope here.

---

## 4. Operation invocation over HTTP

`Signum/API/Controllers/OperationController.cs`. The controller is decorated `[ValidateModelFilter]` at class level (`:14`).

**There is no `POST /api/save` endpoint.** `EntityController` (`Signum/API/Controllers/EntityController.cs`) is read-only: `api/entity/{type}/{id}`, `api/entityPack/{type}/{id}`, `api/entityPackLight/{type}/{id}`, `api/entityPackEntity`, `api/liteModels`, `api/fetchAll/{typeName}`, `api/validateEntity`, `api/exists/{type}/{id}`. **Saving an entity is an operation** — you POST the entity to `api/operation/executeEntity/{TypeName}Operation.Save`. This is the single most important structural fact for a CLI's `save` verb.

### 4.1 Routes — the Lite vs full-entity matrix

| Route (all POST) | Body DTO | Returns | Source |
|---|---|---|---|
| `api/operation/construct/{operationKey}` | `ConstructOperationRequest` | `EntityPackTS?` | `:17-27` |
| `api/operation/constructFromEntity/{operationKey}` | `EntityOperationRequest` | `EntityPackTS?` | `:29-37` |
| `api/operation/constructFromLite/{operationKey}` | `LiteOperationRequest` | `EntityPackTS?` | `:39-46` |
| `api/operation/executeEntity/{operationKey}` | `EntityOperationRequest` | `ActionResult<EntityPackTS>` | `:48-74` |
| `api/operation/executeLite/{operationKey}` | `LiteOperationRequest` | `EntityPackTS` | `:77-85` |
| `api/operation/executeLiteWithProgress/{operationKey}` | `LiteOperationRequest` | **NDJSON** stream of `ProgressStep<EntityPackTS>` | `:87-100` |
| `api/operation/deleteEntity/{operationKey}` | `EntityOperationRequest` | `void` (empty 200/204) | `:102-107` |
| `api/operation/deleteLite/{operationKey}` | `LiteOperationRequest` | `void` | `:109-115` |
| `api/operation/constructFromMany/{operationKey}` | `MultiOperationRequest` | `EntityPackTS?` | `:203-212` |
| `api/operation/constructFromMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` | `:214-227` |
| `api/operation/executeMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` | `:230-243` |
| `api/operation/deleteMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` | `:246-260` |
| `api/operation/stateCanExecutes` | `StateCanExecuteRequest` | `StateCanExecuteResponse` | `:334-350` |

The `*Entity` variants take the **full entity JSON in the body** — so they carry your local (possibly modified) graph and are how you persist changes. The `*Lite` variants take only a `Lite<Entity>` and the server does `request.lite.Retrieve()` (`:42`, `:80`, `:92`, `:112`) — cheaper, but they operate on the *database* state, so they cannot carry modifications.

Client-side URL construction is confirmed in `Signum/React/Operations.tsx:233-303`, e.g. `:260`:
```ts
return ajaxPost({ url: "/api/operation/executeEntity/" + getOperationKey(operationKey) }, { entity: entity, args: args } as EntityOperationRequest);
```

### 4.2 The `operationKey` string format

The operation is identified **in the URL path**, not in the body. The key is `OperationSymbol.Key`, built by the `Symbol` base constructor:

```csharp
// Signum/Basics/Symbol.cs:15-22
public Symbol(Type declaringType, string fieldName)
{
    this.fieldInfo = declaringType.GetField(fieldName, ...);
    ...
    this.Key = declaringType.Name + "." + fieldName;
}
```

So the format is **`ContainerClassName.FieldName`** — the *simple* class name of the `[AutoInit]` static container plus the field name. **It is NOT namespace-qualified**, and the container name is **not** cleaned of suffixes (unlike entity type names). Real examples from the generated TypeScript:

```ts
// Extensions/Signum.Authorization/Signum.Authorization.ts:146-153
export namespace UserOperation {
  export const Create        = registerSymbol("Operation", "UserOperation.Create");
  export const Save          = registerSymbol("Operation", "UserOperation.Save");
  export const Reactivate    = registerSymbol("Operation", "UserOperation.Reactivate");
  export const Deactivate    = registerSymbol("Operation", "UserOperation.Deactivate");
  export const Delete        = registerSymbol("Operation", "UserOperation.Delete");
}
```
and `RestApiKeyOperation.Save` / `RestApiKeyOperation.Delete` from `Extensions/Signum.Rest/RestApiKeyEntity.cs:15-20`.

Resolution and authorization happen together:

```csharp
// Signum/API/Controllers/OperationController.cs:133-145
public class BaseOperationRequest
{
    public OperationSymbol GetOperationSymbol(string operationKey, Entity entity) => ParseOperationAssert(operationKey, entity.GetType(), entity);
    public OperationSymbol GetOperationSymbol(string operationKey, Type entityType) => ParseOperationAssert(operationKey, entityType, null);

    public static OperationSymbol ParseOperationAssert(string operationKey, Type entityType, Entity? entity)
    {
        var symbol = SymbolLogic<OperationSymbol>.ToSymbol(operationKey);
        OperationLogic.AssertOperationAllowed(symbol, entityType, inUserInterface: true, entity: entity);
        return symbol;
    }
```
`SymbolLogic<T>.ToSymbol` is a `GetOrThrow` on the symbol dictionary (`Signum/Basics/SymbolLogic.cs:167-170`) → **unknown key ⇒ HTTP 500**. `AssertOperationAllowed` throws `UnauthorizedAccessException` (`Signum/Operations/OperationLogic.cs:341-347`) → **HTTP 403** (§1.9). Note `inUserInterface: true` is hard-coded, so operations hidden from the UI are also hidden from the API.

The key contains a `.` but no `/`, so no URL-encoding is strictly required; still, percent-encode defensively. **[INFERENCE]** — `.` in the last path segment can trip some proxies/IIS static-file handlers.

### 4.3 Request DTOs (verbatim)

```csharp
// Signum/API/Controllers/OperationController.cs:118-131 & 147
public class ConstructOperationRequest : BaseOperationRequest
{
    public required string Type { get; set; }        // clean type name, e.g. "User"
}

public class EntityOperationRequest : BaseOperationRequest
{
    public required Entity entity { get; set; }      // full entity JSON — see §2
}

public class LiteOperationRequest : BaseOperationRequest
{
    public required Lite<Entity> lite { get; set; }
}

public class BaseOperationRequest
{
    ...
    public List<JsonElement>? Args { get; set; }
}
```
```csharp
// :304-321
public class MultiOperationRequest : BaseOperationRequest
{
    public string? Type { get; set; }
    public required Lite<Entity>[] Lites { get; set; }
    public List<PropertySetter>? Setters { get; set; }
}

public class PropertySetter
{
    public required string Property;                 // a dotted property path, resolved with PropertyRoute.AddMany (:384)
    public PropertyOperation? Operation;             // Set | AddElement | AddNewElement | ChangeElements | RemoveElement | RemoveElementsWhere
    public FilterOperation? FilterOperation;
    public object? Value;
    public string? EntityType;
    public List<PropertySetter>? Predicate;
    public List<PropertySetter>? Setters;
}
```

TypeScript mirror (authoritative for the wire casing) — `Signum/React/Operations.tsx:350-383`:
```ts
export interface MultiOperationRequest { type?: string; lites: Lite<Entity>[]; args: any[]; setters?: PropertySetter[] }
export interface PropertySetter { property: string; operation?: PropertyOperation; filterOperation?: FilterOperation; value?: any; entityType?: string; predicate?: PropertySetter[]; setters?: PropertySetter[] }
export interface ConstructOperationRequest { type?: string; args: any[] }
export interface EntityOperationRequest   { entity: Entity; type?: string; args: any[] }
export interface LiteOperationRequest     { lite: Lite<Entity>; type?: string; args: any[] }
```

**`args` semantics** — `Args` is `List<JsonElement>`, i.e. **raw JSON**, converted heuristically at `:164-200`:

```csharp
case JsonValueKind.String:
    if (token.TryGetDateTime(out var dt))  return dt;
    if (token.TryGetDateTimeOffset(out var dto)) return dto;
    return token.GetString();
case JsonValueKind.Number: return token.GetDecimal();          // NOTE: every number becomes a decimal
...
case JsonValueKind.Object:
    if (token.TryGetProperty("EntityType", out var entityType)) return token.ToObject<Lite<Entity>>(jsonOptions);
    if (token.TryGetProperty("Type", out var type))             return token.ToObject<ModifiableEntity>(jsonOptions);
    // else: fall through to per-operation CustomOperationArgsConverters (:155-162)
```
Consequences for a CLI: an argument is discriminated purely by shape — the presence of the literal property **`"EntityType"`** ⇒ a `Lite`, the presence of **`"Type"`** ⇒ a full `ModifiableEntity`. A JSON string that *looks* like a date silently becomes a `DateTime`. Objects of any other shape need an app-registered `CustomOperationArgsConverters` entry or they deserialize to `null`. Args are positional and untyped — **there is no metadata endpoint that describes an operation's argument list**, which is a real limitation for CLI validation (see §5).

### 4.4 Response shape

```csharp
// Signum/API/SignumServer.cs:185-200
public class EntityPackTS
{
    public Entity entity { get; set; }
    public Dictionary<string, string?> canExecute { get; set; }

    [JsonExtensionData]
    public Dictionary<string, object?> extension { get; set; } = new Dictionary<string, object?>();
}
```
Built by (`Signum/API/SignumServer.cs:121-143`):
```csharp
public static EntityPackTS GetEntityPack(Entity entity)
{
    var canExecutes = OperationLogic.ServiceCanExecute(entity);
    var result = new EntityPackTS(entity, canExecutes.ToDictionary(a => a.Key.Key, a => a.Value));
    ... // AddExtension hooks add arbitrary extra top-level keys via [JsonExtensionData]
    return result;
}
```
So the response is:
```json
{
  "entity":  { "Type": "...", "id": 1, "ticks": "...", ... },
  "canExecute": { "UserOperation.Save": null, "UserOperation.Deactivate": "The user is already deactivated" },
  "someExtensionKey": { }
}
```
Note the `[JsonExtensionData]` bag flattens into the top-level object — a CLI's deserializer must tolerate **unknown top-level properties** on `EntityPackTS`.

The delete routes return `void` → empty body. The `*Multiple` / `*WithProgress` routes return **`application/x-ndjson`**: one compact JSON object per line, newline-terminated, flushed per item (`Signum/API/Controllers/OperationController.cs:603-629`), with a hard guarantee that no object contains a raw `\n` (`:623-624`). Line shapes:
```csharp
// :262-272
public class OperationResult { public Lite<Entity> Entity; public string? Error; }
// :291-302
public class ProgressStep<T> { public string? CurrentTask; public int? Min; public int? Max; public int? Position; public bool IsFinished; public T? Result; public HttpError? Error; }
```
These streams use their own serializer options with **`PropertyNamingPolicy = JsonNamingPolicy.CamelCase` and `IncludeFields = true`** explicitly (`:571-579`, `:605-612`) → `entity`, `error`, `currentTask`, `isFinished`, `result`. TS mirror at `Signum/React/Operations.tsx:318-331`.

Crucially, **per-item errors in the NDJSON streams do not fail the HTTP request** — each item is wrapped in try/catch and reported as `{"entity":…, "error":"…"}` with HTTP 200 (`:274-288`). A CLI must parse every line and check `error`.

### 4.5 Errors and validation failures

Three distinct shapes, depending on the endpoint:

1. **`executeEntity` validation failure** — the only route with bespoke handling (`:56-71`):
   ```csharp
   catch (IntegrityCheckException ex)
   {
       GraphExplorer.SetValidationErrors(GraphExplorer.FromRootVirtual(request.entity), ex);
       this.TryValidateModel(request, "request");
       if (this.ModelState.IsValid)
           this.ModelState.AddModelError(string.Empty, ex.Message);
       return BadRequest(new ValidationProblemDetails(this.ModelState)
       {
           Title = "Validation error",
           Detail = ex.Message,
           Status = StatusCodes.Status400BadRequest
       });
   }
   ```
   → **HTTP 400**, RFC 7807 `ValidationProblemDetails`: `{"title":"Validation error","detail":"…","status":400,"errors":{"request.entity.userName":["Must have a value"], …}}`. Keys are model-binding paths rooted at `request`.
2. **Model-binding / `[Required]` failure before the action runs** — `[ValidateModelFilter]` (`Signum/API/Filters/ValidateModelFilterAttribute.cs:8-27`): if any `ModelState` error carries an `Exception` it rethrows an `AggregateException` (→ 500); otherwise **HTTP 400** with the bare `ModelStateDictionary`.
3. **Everything else** — the global `SignumExceptionFilterAttribute` `HttpError` JSON of §1.9. Notably `deleteEntity`/`deleteLite`/`executeLite` return `void`/`EntityPackTS` (not `ActionResult`), so `ExpectsJsonResult` is true (`SignumExceptionFilterAttribute.cs:112-121`) and their `IntegrityCheckException` becomes a plain **400 `HttpError`** rather than `ValidationProblemDetails`. A CLI must handle *both* body shapes on 400.

### 4.6 Discovering which operations are allowed (`canExecute`)

Three complementary mechanisms:

1. **Static, per type — the metadata endpoint.** `GET /api/reflection/types` returns for every entity type an `Operations` dictionary **keyed by `OperationSymbol.Key`** (`Signum/API/ReflectionServer.cs:307`), value `OperationInfoTS` (`:518-543`) with `OperationType`, `CanBeNew`, `CanBeModified`, `ForReadonlyEntity`, `ResultIsSaved`, `HasCanExecute`, `HasCanExecuteExpression`, `HasStates`. Only operations the current user is authorized for appear here (the whole payload is user/role-filtered — §5). **This is what a CLI should use for tab-completion of operation names.** It also tells you which route family to use: `OperationType` ∈ `Execute | Delete | Constructor | ConstructorFrom | ConstructorFromMany` (`Signum/Operations/Operation.cs:233-240`).
2. **Dynamic, per entity instance — `canExecute` in `EntityPackTS`.** `GET /api/entityPack/{type}/{id}` (`EntityController.cs:47-60`) returns `canExecute: { "<operationKey>": <reason-or-null> }`. Semantics from `OperationLogic.ServiceCanExecute` (`Signum/Operations/OperationLogic.cs:445-460`): the dictionary **only contains operations that are authorized and applicable** (`eo.CanBeNew || !entity.IsNew`), and the value is `null` when the operation *can* run, or a **human-readable reason string** when it is currently blocked by state. So the CLI rule is: *key present && value == null ⇒ allowed*.
   (`api/entityPackLight/{type}/{id}` deliberately blanks `canExecute` and `extension` — `EntityController.cs:26-45` — so don't use it for this.)
3. **Bulk, for lites — `api/operation/stateCanExecutes`.** (`OperationController.cs:334-350`)
   ```csharp
   public class StateCanExecuteRequest  { public required string[] OperationKeys { get; set; } public required Lite<Entity>[] Lites { get; set; } }
   public class StateCanExecuteResponse { public bool AnyReadonly; public Dictionary<string, string> CanExecutes { get; set; } }
   ```
   Wire (per the TS at `Signum/React/Operations.tsx:386-393`): request `{ "lites": [...], "operationKeys": ["UserOperation.Deactivate"] }`, response `{ "canExecutes": { "UserOperation.Deactivate": "reason" }, "anyReadonly": false }`.
   ⚠️ The TS interface declares `isReadOnly?: boolean` (`:392`) while the C# field is `AnyReadonly` (`:368`) → the actual wire name is **`anyReadonly`**; the TS name looks like a bug. Trust the C#.
   Also note `:339-341`: each operation key must resolve to the *same* symbol across all the lite types (`.Distinct().SingleEx()`), so you cannot mix unrelated entity types in one call.

### 4.7 Worked example — saving an entity

```http
POST /api/operation/executeEntity/UserOperation.Save HTTP/1.1
Host: signum.example.internal
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json
Accept: application/json

{
  "entity": {
    "Type": "User",
    "id": 42,
    "ticks": "638712345678901234",
    "toStr": "svc-cli",
    "modified": true,
    "userName": "svc-cli",
    "state": "Active",
    "role": { "EntityType": "Role", "id": 3, "toStr": "Administrator" }
  },
  "args": null
}
```
→ `200` with an `EntityPackTS` whose `entity.ticks` has advanced and `entity.modified` is false. On a stale `ticks` → **500** `{"exceptionType":"Signum.Engine.ConcurrencyException", …}` (§1.9, §2).

Delete by lite:
```http
POST /api/operation/deleteLite/UserOperation.Delete HTTP/1.1
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json

{ "lite": { "EntityType": "User", "id": 42 }, "args": null }
```
→ `200`, empty body.

Construct + save in one shot:
```http
POST /api/operation/construct/UserOperation.Create HTTP/1.1
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json

{ "type": "User", "args": null }
```
→ `EntityPackTS` with an `entity` whose `isNew` is true (unsaved — check `OperationInfoTS.ResultIsSaved`), which you then post to `executeEntity/UserOperation.Save`.

---

## 5. Metadata discovery (`ReflectionServer` / `api/reflection/types`)

### 5.1 The endpoints

```csharp
// Signum/API/Controllers/ReflectionController.cs:14-27
[HttpGet("api/reflection/types"), SignumAllowAnonymous]
public ActionResult<Dictionary<string, TypeInfoTS>> Types()
{
    this.Response.GetTypedHeaders().LastModified = ReflectionServer.LastModified;

    var requestHeaders = this.Request.GetTypedHeaders();
    if (requestHeaders.IfModifiedSince.HasValue &&
        (ReflectionServer.LastModified - requestHeaders.IfModifiedSince.Value).TotalSeconds < 1)
    {
        return this.StatusCode(StatusCodes.Status304NotModified);
    }

    return ReflectionServer.GetTypeInfoTS();
}
```
Plus:
- `GET api/reflection/typeEntity/{typeName}` → the `TypeEntity` row for a clean type name (`:29-33`)
- `GET api/reflection/enumEntities/{typeName}` → `Dictionary<string, Entity>` of the `EnumEntity` rows for enums that are persisted as tables (`:35-41`)
- `GET api/reflection/typeInDomains` → per-entity-type read/write id sets for "domain" entities (`:44-61`)

**Caching**: `Last-Modified` + `If-Modified-Since` with **1-second granularity**, and a **304** short-circuit. `LastModified` is bumped on schema/description/cache invalidation (`Signum/API/ReflectionServer.cs:26`, `:89-93`). A CLI should persist the payload plus its `Last-Modified` on disk and revalidate — this is explicitly designed for exactly that.

⚠️ `[SignumAllowAnonymous]` on `Types()` does **not** mean the payload is public: the response is **filtered by the current user's permissions**, and the server caches one variant *per culture only* (`cache.GetOrAdd(GetContext(), …)` where `GetContext = GetCurrentValidCulture`, `:15-24`, `:166`). Filtering is implemented by `OverrideIsNamespaceAllowed` predicates such as `() => UserHolder.Current != null` (`Signum/API/SignumServer.cs:99-105`) and by the `TypeExtension`/`PropertyRouteExtension`/`OperationExtension` hooks (`ReflectionServer.cs:97-157`) that authorization modules subscribe to in order to drop types/members/operations the user can't see. **[INFERENCE]** — I read the hook plumbing here, not the `Signum.Authorization` subscribers. Practical CLI consequence: **always fetch `api/reflection/types` authenticated**, or you get a heavily reduced view.

### 5.2 The payload shape

Top level: `Dictionary<cleanTypeName, TypeInfoTS>`, keyed by `ReflectionServer.GetTypeName` (`:405-411`) = `TypeLogic.TryGetCleanName(t) ?? t.Name`, i.e. `"User"`, `"Role"`, `"RestApiKey"`, and for non-entities the raw name (`"UserState"`, `"UserOperation"`).

```csharp
// Signum/API/ReflectionServer.cs:462-487 (verbatim)
public class TypeInfoTS
{
    public KindOfType Kind { get; set; }
    public string FullName { get; set; } = null!;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? NiceName { get; set; }
    [JsonIgnore(...WhenWritingNull)] public string? NicePluralName { get; set; }
    [JsonIgnore(...WhenWritingNull)] public string? Gender { get; set; }
    [JsonIgnore(...WhenWritingNull)] public EntityKind? EntityKind { get; set; }
    [JsonIgnore(...WhenWritingNull)] public EntityData? EntityData { get; set; }
    [JsonIgnore(...WhenWritingDefault)] public bool IsLowPopulation { get; set; }
    [JsonIgnore(...WhenWritingDefault)] public bool IsSystemVersioned { get; set; }
    [JsonIgnore(...WhenWritingNull)] public string? ToStringFunction { get; set; }
    [JsonIgnore(...WhenWritingDefault)] public bool QueryDefined { get; set; }
    [JsonIgnore(...WhenWritingDefault)] public bool NoSchema { get; set; }
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, MemberInfoTS> Members { get; set; } = null!;
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, CustomLiteModelTS>? CustomLiteModels { get; set; } = null!;
    [JsonIgnore(...WhenWritingDefault)] public bool HasConstructorOperation { get; set; }
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, OperationInfoTS>? Operations { get; set; }

    [JsonExtensionData] public Dictionary<string, object> Extension { get; set; } = new();
}

public enum KindOfType { Entity, Enum, Message, Query, SymbolContainer }   // :629-636
```

- **`Kind`** discriminates four very different records:
  - `Entity` — a `ModifiableEntity` (only `IRootEntity`s are emitted; `:243-244`)
  - `Enum` / `Message` / `Query` — a C# enum; the split is by name suffix: `…Query` ⇒ `Query`, `…Message` ⇒ `Message`, else `Enum` (`:338-339`)
  - `SymbolContainer` — a static `[AutoInit]` class holding `Symbol` fields (operations, permissions, …) (`:363-380`)
- **`Members`** for entities is keyed by **`pr.PropertyString()`** — the PropertyRoute string, which is the *dotted path* including MList element steps (`:293`). This is the same vocabulary as `PropertySetter.Property` (§4.3) and closely related to QueryToken paths (§3). **This is the key to token/path tab-completion.**
- **`Members`** for enums is keyed by the C# field name (`:351`); for symbol containers by the field name with the symbol's DB `Id` attached (`:369-379`).
- **`Operations`** keyed by `OperationSymbol.Key` (`:307`) — see §4.6.
- **`ToStringFunction`** is a **JavaScript source string** produced by `LambdaToJavascriptConverter` (`:268`) — a non-.NET CLI cannot evaluate it and should ignore it, falling back to the server-provided `toStr`. Same for `CustomLiteModels[].ConstructorFunctionString` (`:302`).

```csharp
// :495-516 — per-member
public class MemberInfoTS
{
    public TypeReferenceTS? Type { get; set; }
    public string? NiceName { get; set; }
    public bool IsReadOnly { get; set; }
    public bool Required { get; set; }
    public string? Unit { get; set; }
    public string? Format { get; set; }
    public bool IsIgnoredEnum { get; set; }
    public bool IsVirtualMList { get; set; }
    public int? MaxLength { get; set; }
    public bool IsMultiline { get; set; }
    public bool PreserveOrder { get; set; }
    public bool AvoidDuplicates { get; set; }
    public object? Id { get; set; }        // only for symbol-container members
    public bool IsPhone { get; set; }
    public bool IsMail { get; set; }
    public bool HasFullTextIndex { get; set; }
    [JsonExtensionData] public Dictionary<string, object> Extension { get; set; } = new();
}

// :545-553
public class TypeReferenceTS
{
    public bool IsCollection { get; set; }
    public bool IsLite { get; set; }
    public bool IsFullEntity { get; set; }
    public bool IsNotNullable { get; set; }
    public bool IsEmbedded { get; set; }
    public required string Name { get; set; }
    public string? TypeNiceName { get; set; }
}
```
`TypeReferenceTS.Name` is either a **primitive token** — `"boolean" | "sbyte" | "byte" | "short" | "ushort" | "int" | "uint" | "long" | "ulong" | "float" | "double" | "decimal" | "string"` (`:602-625`) — or a clean type name, or, for polymorphic references, `implementations.Value.Key()` which is a **`|`-joined list of clean type names** for `ImplementedBy` (`:569-579`). **[INFERENCE]** on the exact separator being `|`; I read that `Implementations.Key()` is used but did not open `Implementations`. A CLI must be prepared for a multi-type `Name`.

```csharp
// :518-543
public class OperationInfoTS
{
    public OperationType OperationType;
    public bool? CanBeNew, CanBeModified, ForReadonlyEntity, ResultIsSaved, HasCanExecute, HasCanExecuteExpression, HasStates;
    [JsonExtensionData] public Dictionary<string, object> Extension { get; set; } = new();
}
```

### 5.3 Suitability for a CLI

**Strong points**
- One request gives you: every entity type name, every property path with its type/nullability/collection-ness/max-length/format/unit, every enum with its members, every operation key per type with its `OperationType`, every symbol container (permissions, operations) with DB ids, plus which types have a registered dynamic query (`QueryDefined`, `:269`) and which are temporal (`IsSystemVersioned`, `:267`).
- Already permission-filtered ⇒ tab-completion never offers something the user can't do.
- `Last-Modified`/`304` ⇒ cheap revalidation, cache to disk keyed by (base URL, user, culture).
- `NiceName`/`NicePluralName` ⇒ good `--help` text for free.

**Gaps a CLI must work around**
- **No operation argument metadata.** `OperationInfoTS` says nothing about `args` (§4.3). Argument construction cannot be validated or completed from metadata.
- **No QueryToken enumeration.** `Members` gives property routes, but the *query token* space is larger (aggregates, date parts, `.Count`, `.Element`, entity-dots — §3). Token completion needs the query-side token endpoints, not this one.
- **`Extension` (`[JsonExtensionData]`) on all three records** means every extension module can inject arbitrary keys — a CLI's parser must ignore unknown properties everywhere, at every level.
- **JS source strings** (`ToStringFunction`, `ConstructorFunctionString`) are dead weight outside a JS host and inflate the payload.
- Almost every field is `[JsonIgnore(WhenWritingNull/WhenWritingDefault)]` ⇒ **absent means false/null**. A strict deserializer with required fields will fail; only `Kind`, `FullName` and `TypeReferenceTS.Name` are unconditional.

**Size** — I cannot measure it without a running server. Structurally it is *one JSON object per type in every registered entity assembly, with one nested object per property route (recursively expanded through embedded entities and MList items via `PropertyRoute.GenerateRoutes`, `:270`), plus one per enum member and per operation*, all pretty-printed (`WriteIndented = true`, `Signum/API/SignumServer.cs:44`). For a real business app that is **hundreds of types and many thousands of members** — realistically **single-digit MB**. **[INFERENCE], flagged as an estimate.** Mitigations, in order: honour `If-Modified-Since`; request `Accept-Encoding: gzip`; cache to disk. Do **not** fetch it per CLI invocation.

---
## Appendix — the fastest path to a working CLI

1. **Auth**: `X-ApiKey: <key>` on every request (§1.10). Fall back to `POST /api/auth/login` → `Authorization: Bearer <token>` + honour the `New_Token` response header.
2. **Bootstrap metadata**: `GET /api/reflection/types` with `If-Modified-Since`, cached on disk per (base URL, user, culture) (§5).
3. **Query**: `GET /api/query/description/{queryKey}` for root columns → `POST /api/query/subTokens` to complete → `POST /api/query/executeQuery/{queryKey}` (§3). **Always run the `uniqueValues` decompression pass** and read `rows[i].entity`.
4. **Read one entity**: `GET /api/entityPack/{cleanType}/{id}` — gives you the entity *and* its live `canExecute` map (§4.6).
5. **Save**: mutate the entity JSON, set `"modified": true` on every touched object, keep `ticks`, then `POST /api/operation/executeEntity/{Container}Operation.Save` (§4.7, §2.10).
6. **Other operations**: `POST /api/operation/{execute|delete|constructFrom}{Entity|Lite}/{operationKey}` where `operationKey` is `ContainerClassName.FieldName` (§4.2).
7. **Errors**: no 401 ever; 403 = auth/permission; 400 = validation (two possible body shapes); **500 = most user input errors** — surface `exceptionMessage`, and suffix-match `exceptionType` (§1.9, §3.10).
