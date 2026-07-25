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

**Two behaviours a client MUST implement:**

1. **Token rotation.** The token never hard-expires. After ~30 minutes the server returns a
   replacement in the **`New_Token` response header**; the client must adopt it and use it
   from then on (`AuthTokensServer.cs:66-102`). Ignoring this eventually 403s.
2. **Opacity.** The token is *not* a JWT — Deflate + AES-CBC, Base64. Never try to parse it
   for an expiry claim; there isn't one to read.

A password change invalidates all tokens. An API key survives password changes.

### 1c. Key → Bearer

`GET /api/auth/relogin` with `X-ApiKey` returns a `LoginResponse`. Useful only to obtain a
short-lived token from a long-lived key.

### 1d. Not viable headlessly

`UserTicket` is a browser `sfUser` cookie. Skip it.

Also note: **no CSRF protection and no default CORS** on these endpoints; the browser client
stores its token in `sessionStorage`, not cookies.

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

### `args` encoding

`args` is a raw JSON array, discriminated **by shape** (`OperationController.cs:164-200`):

| Shape | Interpreted as |
|---|---|
| object with `"EntityType"` | `Lite<T>` |
| object with `"Type"` | full entity |
| bare number | `decimal` |

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
- The `Entity` column is **hoisted** out of `columns` into `rows[i].entity`.
- A `QueryDescription` always has an injected `Entity` column of type `Lite<T>`.

Any table/CSV renderer must de-intern first.

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
