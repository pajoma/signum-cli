# Signum HTTP API — contract for a headless client

The contract `signum-cli` is built against. Read this before writing any request code.

Source of truth is `Framework/Signum/API/` plus `Framework/Extensions/Signum.Rest/` and
`Framework/Extensions/Signum.Authorization/`. Exhaustive detail with citations:
[`reference/wire-protocol-and-auth.md`](reference/wire-protocol-and-auth.md) and
[`reference/client-and-http-api.md`](reference/client-and-http-api.md).

**The API is generic.** Endpoints are parameterised by type *names* and token *strings*,
never by compiled domain types. One client binary works against any Signum application.
The app's domain is discovered at runtime from `api/reflection/types`.

---

## 1. Authentication

Auth is a **global MVC resource filter** (`Signum/API/SignumServer.cs:68`) running a chain
of authenticators; the first non-null result wins
(`Signum/API/Filters/SignumFilters.cs:43-55`).

> **There is no 401 anywhere.** Every auth failure is **403**
> (`SignumExceptionFilterAttribute.cs:131-146`). Do not write `if (status == 401)` retry
> logic — it will never fire.

### 1a. API key — preferred

Requires the target app to have `Signum.Rest` started. Constants
(`Extensions/Signum.Rest/RestApiKeyLogic.cs:9-10`, verified verbatim):

```csharp
public readonly static string ApiKeyQueryParameter = "apiKey";
public readonly static string ApiKeyHeader = "X-ApiKey";
```

The API-key authenticator is inserted at **index 0** of the chain
(`RestApiKeyServer.cs:19`), so it takes precedence over Bearer.

```http
GET /api/auth/currentUser HTTP/1.1
X-ApiKey: YOUR_API_KEY_HERE
```

> **Never use `?apiKey=`.** `RestLogFilter.cs:36-38` persists the whole query string into
> `RestLogEntity.QueryString`, and the global exception logger does the same. A key in the
> URL is a key written to the application database in plaintext. **Header only.**

Provisioning is an admin action in the target app: create a
`RestApiKeyEntity { User, ApiKey }` and save it via `RestApiKeyOperation.Save`. Keys are 32
random bytes, Base64Url-encoded (`RestApiKeyLogic.cs:41-46`).

### 1b. Username/password → Bearer — universal fallback

Works without `Signum.Rest`.

```http
POST /api/auth/login HTTP/1.1
Content-Type: application/json

{"userName":"USER","password":"YOUR_PASSWORD_HERE","rememberMe":false}
```

→ `200` with `LoginResponse { authenticationType, token, userEntity }`, or `400` with a
`ModelState` body. Then send `Authorization: Bearer <token>` on every request
(`AuthTokensServer.cs:57,144`).

**Three behaviours a client MUST implement:**

1. **Token rotation.** Tokens **never expire**. `RefreshTokenEvery` (default 30 min) is a
   *rotation* interval: past it the server revalidates against the database and returns a
   replacement in the **`New_Token` response header** (`AuthTokensServer.cs:85-94`). Adopt it
   atomically. Ignoring it does **not** 403 — it costs a DB hit per request and **freezes the
   user's role permanently**, since `RoleEntity.Current` reads the role from the token claim
   (`RoleEntity.cs:33`). Force a rotation on demand with `?refreshToken`.
2. **Opacity.** The token is *not* a JWT — JSON → Deflate → AES-128-CBC/PKCS7 with the key
   derived as MD5 of the app secret, IV prepended, **no MAC**. Never parse it; there is no
   expiry claim to read and no integrity check to rely on.
3. **Verify after load.** A malformed, tampered, or wrong-key token is **swallowed and degrades
   silently to anonymous**, not rejected. After loading a stored token, confirm it with
   `GET api/auth/currentUser` before relying on it.

Token invalidation happens only on the rotation path: user deleted, `State != Active`, username
changed, or password hash changed (`AuthTokensServer.cs:106-118`). There is no IP, user-agent, or
session binding. `POST api/auth/logout` clears a cookie and performs **no token revocation**.

A password change invalidates all tokens. An API key survives password changes.

### 1c. Key → Bearer

`GET api/auth/loginFromApiKey` (or `GET api/auth/relogin`) with `X-ApiKey` returns a
`LoginResponse`. Recommended: trade the long-lived key for a rotating token at startup, so the
key appears on exactly one request per invocation.

### 1d. Not viable headlessly

`UserTicket` is a browser `sfUser` cookie. Skip it.

Also note: **no CSRF protection and no default CORS** on these endpoints; the browser client
stores its token in `sessionStorage`, not cookies.

### 1e. Complete `api/auth/*` surface

14 routes across the core and the authorization modules:

| Verb | Route | Anonymous? |
|---|---|---|
| POST | `api/auth/login` | **yes** |
| GET | `api/auth/loginFromApiKey` | no (filter authenticates first) |
| GET | `api/auth/relogin` | no |
| POST | `api/auth/loginFromCookie` | **yes** |
| GET | `api/auth/currentUser` | no |
| POST | `api/auth/logout` | no |
| POST | `api/auth/ChangePassword` | no |
| POST | `api/auth/forgotPasswordEmail` · `resetPassword` · `requestNewLink` | **yes** ×3 |
| POST | `api/auth/loginWithOpenID` · `loginWithAzureAD` · `loginWindowsAuthentication` | **yes** ×3 |
| GET | `api/auth/openIDEndpoints` | **yes** |

### 1f. Browser login is possible today

`POST api/auth/loginWithOpenID` is `[SignumAllowAnonymous]` and takes `{Code, RedirectUri}`.
Signum does **not validate the redirect URI** — `OpenIDConfigurationEmbedded` has no such field —
and forwards it verbatim to the IdP token endpoint (`OpenIDAuthenticationServer.cs:96`). A
loopback URI is therefore accepted unconditionally; only the IdP gates it. The server holds the
`client_secret`, so a CLI needs no secret.

Caveats: **PKCE is not implemented** (zero repo-wide hits), and `client_id`/scopes are not exposed
by any API. Full flow and acceptance criteria: [`stories/auth.md`](stories/auth.md) STORY-01.

`POST api/auth/loginWithAzureAD` accepts a raw `idToken`, validating `aud`/`iss` — a genuine token
exchange, so a CLI can run its own device-code flow and hand the token over. The grant is hand-rolled over plain HTTP
(no identity SDK). **Note:** for the target application this path is *blocked* on an Entra
app-registration change; see the target profile. See
[`decisions/0004-entra-primary-identity-provider.md`](decisions/0004-entra-primary-identity-provider.md)
and STORY-10. Note the audience trap: Signum validates `aud == ApplicationID`, so a CLI with its own
app registration needs the app to opt in via `AzureAuthenticationServer.ExtraValidAudiences`.

---

## 2. Endpoint reference

Routes are declared absolutely per action. Controllers live in
`Signum/API/Controllers/`; `EntitiesController` is in the file `EntityController.cs`. Only
`CascadeDeleteController` is `[ApiController]`. `TypeHelpController` is **not** in core — it
is in `Extensions/Signum.Eval/`.

### Metadata

| Verb | Route | Notes |
|---|---|---|
| GET | `api/reflection/types` | **Anonymous.** `Last-Modified` + 304. → `{ typeName: TypeInfoTS }` |

This single document is the CLI's map of the target application: type names, members,
entity kinds, operations, queries, enums, permissions, and localized strings. Cache it on
disk keyed by `Last-Modified` and revalidate with `If-Modified-Since` — that gives fully
offline tab-completion and pre-flight validation.

> **The document is anonymous-*accessible* but not identity-*independent*.** Anonymous means no
> credential is *required*; the response still differs by caller. `AuthServer.cs:143-157`
> rewrites `TypeInfoTS.QueryDefined` to `false` for any query the caller may not run, and
> `UserEntity.Current == null` (an anonymous request) means *no* query is allowed — so an
> anonymous document reports nothing as queryable. Meanwhile `ReflectionServer.LastModified` is a
> process-wide static (`ReflectionController.cs:17`), so the server will happily answer `304` to
> a conditional request from a *different* caller. **Cache anonymous and authenticated responses
> separately**, or a pre-login `types` call poisons every post-login validation.

`TypeInfoTS.QueryDefined` (`ReflectionServer.cs:474`) is `queryDefined` on the wire and carries
`[JsonIgnore(WhenWritingDefault)]` — it is present-and-`true`, or **absent**, never `false`.

### Entities

| Verb | Route | → |
|---|---|---|
| GET | `api/entity/{type}/{id}` | `Entity` |
| GET | `api/entityPack/{type}/{id}` | `EntityPackTS` |
| GET | `api/entityPackLight/{type}/{id}` | `EntityPackTS` |
| POST | `api/entityPackEntity` | `EntityPackTS` |
| POST | `api/liteModels` | models for a `Lite[]` |
| POST | `api/validateEntity` | validation result |
| GET | `api/fetchAll/{typeName}` | `Entity[]` |
| GET | `api/exists/{type}/{id}` | `bool` |

`EntityPackTS` = `{ entity, canExecute: { operationKey: null | reason }, …extensions }`.
`canExecute` is how a client discovers which operations are currently permitted — a
`null` value means allowed, a string means the reason it is blocked.

### Queries

| Verb | Route | Body → |
|---|---|---|
| GET | `api/query/description/{queryKey}` | `QueryDescription` |
| GET | `api/query/findLiteLike?types=&subString=&count=` | `Lite[]` — autocomplete |
| GET | `api/query/allLites?types=` | `Lite[]` |
| POST | `api/query/parseTokens` | `{queryKey, tokens[]}` → `QueryTokenTS[]` |
| POST | `api/query/subTokens` | `{queryKey, token}` → `QueryTokenTS[]` — completion |
| POST | `api/query/executeQuery/{queryKey}` | `QueryRequestTS` → `ResultTable` |
| POST | `api/query/lites/{queryKey}` | → `Lite[]` |
| POST | `api/query/entities/{queryKey}` | → `Entity[]` |
| POST | `api/query/queryValue/{queryKey}` | → scalar |

`QueryRequestTS` = `{ queryKey, groupResults, filters, orders, columns, pagination, systemTime? }`.

### Operations

| Verb | Route |
|---|---|
| POST | `api/operation/construct/{operationKey}` |
| POST | `api/operation/constructFromEntity/{operationKey}` |
| POST | `api/operation/constructFromLite/{operationKey}` |
| POST | `api/operation/executeEntity/{operationKey}` |
| POST | `api/operation/executeLite/{operationKey}` |
| POST | `api/operation/deleteEntity/{operationKey}` |
| POST | `api/operation/deleteLite/{operationKey}` |
| POST | `api/operation/{constructFromMany,constructFromMultiple,executeMultiple,deleteMultiple}/{operationKey}` |
| POST | `api/operation/executeLiteWithProgress/{operationKey}` — NDJSON stream |
| POST | `api/operation/stateCanExecutes` |

*(verified against `OperationController.cs:17-334`)*

---

## 3. Mutation is always an operation

**There is no save endpoint.** Saving is an operation:

```http
POST /api/operation/executeEntity/UserOperation.Save HTTP/1.1
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json

{
  "entity": { "Type": "User", "id": 42, "ticks": "638500000000000000",
              "modified": true, "userName": "alice" },
  "args": null
}
```

→ `EntityPackTS`.

### operationKey format

`ContainerClassName.FieldName` — **not namespace-qualified**
(`Signum/Basics/Symbol.cs:22`, verified):

```csharp
this.Key = declaringType.Name + "." + fieldName;
```

So `UserOperation.Save`, not `Signum.Authorization.UserOperation.Save`.

### Only UI-visible operations are invokable

`OperationController.cs:142` hardcodes `inUserInterface: true` when calling
`OperationLogic.AssertOperationAllowed` (`OperationLogic.cs:341-347`). Every HTTP invocation is judged
as though it came from the web UI, so an operation hidden from the UI **cannot be invoked over the API
at all**. No client-side workaround exists.

### `args` encoding

`args` is a raw JSON array, discriminated **by value kind** in
`BaseOperationRequest.ConvertObject` (`OperationController.cs:~165-200`):

| Shape | Interpreted as |
|---|---|
| string | `DateTime` if parseable, then `DateTimeOffset`, else `string` |
| number | **always `decimal`** |
| object with `"EntityType"` | `Lite<T>` |
| object with `"Type"` | `ModifiableEntity` (embedded/model entities too, not just roots) |
| object with **neither** | app-registered `CustomOperationArgsConverters`, else **silently `null`** |
| array | recursive list |
| true / false / null | as expected |

Two of these are silent hazards: **a date-shaped string is always coerced to a date**, and an
unrecognised object **arrives as null with no error**. Guard both client-side.

### Errors

| Status | Meaning |
|---|---|
| 403 | not authorized (also: not authenticated) |
| 400 | `ValidationProblemDetails` — only on `executeEntity` |
| 500 | body has `exceptionType == "Signum.Engine.ConcurrencyException"` → stale `ticks` |

### Entity vs Lite variant

Pick `…Entity` when the local entity graph has unsaved changes, `…Lite` when you only hold
an identity. The browser client decides via `canBeModified`.

---

## 4. Serialization rules

camelCase throughout. The traps, in order of how likely they are to bite:

1. **`Type` vs `EntityType`.** Full entities carry `Type` with the *clean* name
   (`RoleEntity` → `"Role"`). Lites carry `EntityType`. **Mixing them throws.**
2. **`ticks` is a string**, not a number. It drives optimistic concurrency.
3. **Special properties must come first** in the JSON object, and **unknown keys are
   rejected**.
4. **`modified: true` must be propagated up the entity graph.** The browser does this in
   `ajaxPostRaw` via `GraphExplorer.propagateAll`. A hand-built client must replicate it or
   saves silently drop changes.
5. **`MList<T>`** serializes as `[{ rowId, element }]` — not a bare array.
6. **`Lite<T>`** in string form is `"Album;3"` (`TypeName;id`).

### `ResultTable` is column-interned

The single most surprising response shape. Repeated values are deduplicated:

- `rows[i].columns[j]` may be an **index into `uniqueValues[columns[j]]`**, not a value
  (`ResultTableConverter.cs:71-78`, decoded client-side in `Finder.tsx:2009-2026`).
- The `Entity` column is **hoisted** out of `columns` into `rows[i].entity` — the response's
  `columns` array does **not** contain it (`ResultTable.cs:55-56` filters it out, and
  `ResultTableConverter.cs:61-65` writes `entity` per row only when `EntityColumn != null`).
  Its token is exactly `"Entity"` (`QueryDescription.cs:17`).
- With `groupResults: true` nothing is hoisted — the entity column stays inline
  (`ResultTable.cs:55`).
- The framework's own reconstruction puts it **first**: `AllColumns()` is
  `Columns.PreAnd(entityColumn)` (`ResultTable.cs:51`). A client that wants the caller's
  requested order has to track the request's `columns` list itself.
- A `QueryDescription` always has an injected `Entity` column of type `Lite<T>`.

Any table/CSV renderer must de-intern **and** put the hoisted column back first.

---

## 5. QueryToken grammar

A token is a `.`-separated path, but the split only breaks on dots **outside brackets**
(`Signum/DynamicQuery/QueryUtils.cs:370`, verified):

```csharp
public static readonly Regex SplitRegex = new Regex(@"(?<!\[[^\]]*)\.(?![^\[]*\])");
```

Parsing resolves segment 1 against the query's `ColumnDescription.Name`s, then each later
segment by **exact, case-sensitive** dictionary lookup on the parent. A forbidden token
throws `UnauthorizedAccessException`.

| Segment form | Examples |
|---|---|
| plain property | `Name`, `Id`, `ToString` |
| collection | `Element`, `Count`, `Any`, `All`, `NotAny`, `NotAll`, `RowId`, `RowOrder` |
| date part | `Year`, `Month`, `MonthStart`, `Every15Minutes` |
| numeric | `Length`, `Step0_1`, `x1_5`, `Mod100` |
| bracketed | `[Operations]`, `[QuickLinks]`, `[EntityType]`, `[MyDict]` |
| cast | `(Order)` |
| aggregate | `Count`, `Sum`, `Min`, `Max`, `Average`, `CountDistinct`, `CountNull`, `CountNotNull`, `CountTrue` |

`Entity` is an ordinary column of type `Lite<T>`; you keep dotting through it
(`Entity.Customer.Name`). Operations escape their own dot as `#`:
`Entity.[Operations].Order#Save`. `TimeSpan` uses plurals (`Hours`) where `DateTime` uses
singular (`Hour`).

Discover tokens with `POST api/query/subTokens`; validate with `POST api/query/parseTokens`.
Both use `SubTokensOptions.All`.

**Known traps**

- `.Nested` is discoverable via `subTokens` but **unusable** in `executeQuery` —
  `CanNested` is never passed (`FilterJsonConverter.cs:87-153`).
- Aggregate tokens require `groupResults: true`.
- `SubTokensOptions` differ per slot (filter vs. column vs. order).
- `IsIn` **cannot express null**.
- Importing data needs `OperationLogic.AllowSave<T>()` enabled server-side.

---

## 6. Minimal request recipes

Query, two filters with one in an Or-group, sorted:

```http
POST /api/query/executeQuery/Order HTTP/1.1
X-ApiKey: YOUR_API_KEY_HERE
Content-Type: application/json

{
  "queryKey": "Order",
  "groupResults": false,
  "filters": [
    { "token": "Entity.Customer.Name", "operation": "StartsWith", "value": "A" },
    { "groupOperation": "Or", "filters": [
        { "token": "State", "operation": "EqualTo", "value": "Shipped" },
        { "token": "State", "operation": "EqualTo", "value": "Delivered" } ] }
  ],
  "orders":  [ { "token": "OrderDate", "orderType": "Descending" } ],
  "columns": [ { "token": "Entity" }, { "token": "OrderDate" } ],
  "pagination": { "mode": "Paginate", "elementsPerPage": 50, "currentPage": 1 }
}
```

Confirm the exact `FilterOperation` and `Pagination` discriminator spellings against
[`reference/wire-protocol-and-auth.md`](reference/wire-protocol-and-auth.md) before
committing to them in code — they are enum names serialized by name.

---

## 7. Verify before you trust

Nothing here has been exercised against a live server; it is read from source at
`74bd24693d`. Before the first release, run every recipe against a real Southwind instance
and correct this document. Mark anything you confirm with `✅ verified against <version>`.
