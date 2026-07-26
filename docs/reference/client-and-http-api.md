# Signum Framework — Client/TypeScript stack & the HTTP API boundary

Repo analysed read-only: `/home/patrick.maue/git/sfcl/signum-framework` (branch `develop`).
All paths below are absolute. Line numbers refer to the state of the working tree at analysis time.

---

## 0. Executive orientation

Signum's C#↔React boundary is **not** a hand-written REST API. It is a small, fixed,
*generic* API — roughly 25 core endpoints — plus a **type-metadata endpoint**
(`GET api/reflection/types`) that ships the entire schema (types, properties, nice names,
operations, formats, validators) to the client at boot. Everything the UI does
(navigate, search, save, run business operations) is expressed through those generic
endpoints parameterised by *clean type names*, *query keys*, *query tokens* and
*operation keys* that come from the metadata.

Consequence for a CLI: you implement ~10 HTTP calls plus a JSON entity
(de)serialiser, and you get the *whole* application surface, for any Signum app,
without per-app code. The metadata endpoint is your discovery mechanism.

Three vocabularies you must internalise:

| Concept | Wire form | Example |
|---|---|---|
| **clean type name** | `Reflector.CleanTypeName` — the C# type name minus the `Entity`/`Model`/`Symbol` suffix, possibly prefixed by an extension namespace | `Role`, `Auth.User`, `Exception`, `OperationLog` |
| **query key** | usually equal to the clean type name for entity queries; otherwise `<EnumName>.<Member>` | `Role`, `Auth.User`, `UserQueryQuery.Custom` |
| **query token** | dotted path over the query's column graph, with pseudo-tokens | `Entity.UserName`, `Entity.Role.Entity.Name`, `Count`, `Entity.Roles.Element.Name` |
| **operation key** | `<ContainerName>.<Member>` | `RoleOperation.Save`, `UserOperation.Delete` |

---

## 1. The HTTP API surface

### 1.1 Core controllers (in `Signum/API/Controllers/`)

Actual class names (verified — note the plural/singular inconsistency):

| File | Class | Namespace |
|---|---|---|
| `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/EntityController.cs` | `EntitiesController` (file is singular, class is plural) | `Signum.API.ApiControllers` |
| `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/QueryController.cs` | `QueryController` | `Signum.API.Controllers` |
| `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/OperationController.cs` | `OperationController` | `Signum.API.Controllers` |
| `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/ReflectionController.cs` | `ReflectionController` | `Signum.API.Controllers` |
| `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/CascadeDeleteController.cs` | `CascadeDeleteController` | `Signum.API.Controllers` |

There is **no** `TypeHelpController` in `Signum/API/` — it lives in an extension:
`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Eval/TypeHelp/TypeHelpController.cs`
(`GET api/typeHelp/{typeName}/{mode}`, `POST api/typeHelp/autocompleteType`,
`POST api/typeHelp/autocompleteEntityCleanType`). Also note routes are declared
**absolutely on each action** (`[HttpGet("api/entity/{type}/{id}")]`) — there is no
`[Route]` prefix on the controllers, and most are **not** `[ApiController]`
(only `CascadeDeleteController` is), which is why model-state errors are produced by the
explicit `[ValidateModelFilter]` attribute rather than by ASP.NET's automatic behaviour.

### 1.2 Endpoint table — entities

Source: `EntityController.cs`.

| Verb | Route | Request | Response |
|---|---|---|---|
| GET | `api/entity/{type}/{id}?partitionId=` | – | `Entity` (full entity JSON) |
| GET | `api/entityPack/{type}/{id}?partitionId=` | – | `EntityPackTS` |
| GET | `api/entityPackLight/{type}/{id}?partitionId=` | – | `EntityPackTS` with `canExecute`/extension emptied |
| POST | `api/entityPackEntity` | `Entity` (body) | `EntityPackTS` |
| POST | `api/liteModels` | `Lite<Entity>[]` | `object[]` — parallel array of lite models (usually `string`) |
| GET | `api/fetchAll/{typeName}` | – | `Entity[]`; **throws** if `EntityData.Transactional` |
| POST | `api/validateEntity` | `ModifiableEntity` | `204`; `400` + ModelState on validation failure |
| GET | `api/exists/{type}/{id}` | – | `bool` |

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/EntityController.cs:10-24
[HttpGet("api/entity/{type}/{id}"), ProfilerActionSplitter("type")]
public Entity GetEntity(string type, string id, [FromQuery]int? partitionId)
{
    var entityType = TypeLogic.GetType(type);
    var primaryKey = PrimaryKey.Parse(id, entityType);
    var lite = Lite.Create(entityType, primaryKey, partitionId: partitionId);

    using (ExecutionMode.ApiRetrievedScope(lite, "EntitiesController.GetEntity"))
    {
        var entity = Database.Retrieve(entityType, primaryKey, partitionId);
        return entity;
    }
}
```

`EntityPackTS` — `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/SignumServer.cs:305-320`:

```csharp
public class EntityPackTS
{
    public Entity entity { get; set; }
    public Dictionary<string, string?> canExecute { get; set; }

    [JsonExtensionData]
    public Dictionary<string, object?> extension { get; set; } = new Dictionary<string, object?>();

    public static Action<EntityPackTS>? AddExtension;   // extensions inject extra top-level props
    ...
}
```

`canExecute` is `operationKey -> null (allowed) | "reason string" (blocked)`. Absent key
means the operation is not applicable at all. This is exactly what the client's button bar
consumes (see §2.7). `extension` is a `[JsonExtensionData]` bag — extensions (Workflow,
Alerts, ConcurrentUser…) add top-level properties here, so a CLI must tolerate unknown keys.

### 1.3 Endpoint table — dynamic queries

Source: `QueryController.cs`. This is the search/reporting engine.

| Verb | Route | Request | Response |
|---|---|---|---|
| GET | `api/query/findLiteLike?types=&subString=&count=` | – | `Lite<Entity>[]` (autocomplete; `types` is comma-separated clean names) |
| GET | `api/query/allLites?types=` | – | `Lite<Entity>[]`; throws on `Transactional` types |
| GET | `api/query/description/{queryName}` | – | `QueryDescriptionTS` |
| GET | `api/query/queryEntity/{queryName}` | – | `QueryEntity` |
| POST | `api/query/parseTokens` | `{ queryKey: string, tokens: string[] }` | `QueryTokenTS[]` (with `parent` chain) |
| POST | `api/query/subTokens` | `{ queryKey: string, token: string \| null }` | `QueryTokenTS[]` (children of `token`, or roots if null) |
| POST | `api/query/executeQuery/{queryKey}` | `QueryRequestTS` | `ResultTable` |
| POST | `api/query/lites/{queryKey}` | `QueryEntitiesRequestTS` | `Lite<Entity>[]` |
| POST | `api/query/entities/{queryKey}` | `QueryEntitiesRequestTS` | `Entity[]` |
| POST | `api/query/queryValue/{queryKey}` | `QueryValueRequestTS` | scalar (`object?`) |

Note the redundancy: `queryKey` appears **both** in the route and in the body, and the
server hard-asserts they match (`QueryRequestTS.ToQueryRequest` →
`if (queryKey != this.queryKey) throw new ArgumentException(...)`).

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/QueryController.cs:95-123
[HttpPost("api/query/executeQuery/{queryKey}"), ProfilerActionSplitter("queryKey")]
public async Task<ResultTable> ExecuteQuery(string queryKey, [Required, FromBody]QueryRequestTS request, CancellationToken token)
{
    var qr = request.ToQueryRequest(queryKey, SignumServer.JsonSerializerOptions, this.HttpContext.Request.Headers.Referer);
    AssertQuery?.Invoke(qr);
    var result = await QueryLogic.Queries.ExecuteQueryAsync(qr, token);
    return result;
}

[HttpPost("api/query/lites/{queryKey}"), ProfilerActionSplitter("queryKey")]
public async Task<List<Lite<Entity>>> GetLites(string queryKey, [Required, FromBody]QueryEntitiesRequestTS request, CancellationToken token)
{
    return await QueryLogic.Queries.GetEntitiesLite(request.ToQueryEntitiesRequest(queryKey, SignumServer.JsonSerializerOptions)).ToListAsync(token);
}
```

#### Request DTOs — `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/FilterJsonConverter.cs`

```csharp
// FilterJsonConverter.cs:225-236
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

// FilterJsonConverter.cs:275-281
public class QueryEntitiesRequestTS
{
    public required string queryKey;
    public required List<FilterTS> filters;
    public required List<OrderTS> orders;
    public int? count;
}

// FilterJsonConverter.cs:194-199
public class QueryValueRequestTS
{
    public required string queryKey;
    public List<FilterTS>? filters;
    public string? valueToken;      // e.g. "Count", "Entity.Salary.Sum"
    public bool? multipleValues;
    public SystemTimeRequest? systemTime;
}

// FilterJsonConverter.cs:144-148  /  :301-305  /  :162-166
public class ColumnTS     { public required string token;  public string? displayName; }
public class OrderTS      { public required string token;  public required OrderType orderType; } // "Ascending" | "Descending"
public class PaginationTS { public PaginationMode mode;    public int? elementsPerPage; public int? currentPage; }
// PaginationMode = "All" | "Firsts" | "Paginate"
```

Filters are a **discriminated union decided by which property is present** — there is no
`$type` tag. `FilterJsonConverter.Read` (`FilterJsonConverter.cs:23-49`):

```csharp
if (elem.TryGetProperty("operation", out var oper))      // -> FilterConditionTS
    return new FilterConditionTS { token = ..., operation = oper.GetString()!.ToEnum<FilterOperation>(), value = ... };

if (elem.TryGetProperty("groupOperation", out var groupOper))   // -> FilterGroupTS
    return new FilterGroupTS { groupOperation = ..., token = ..., filters = ... };

throw new InvalidOperationException("Impossible to determine type of filter");
```

```csharp
// FilterJsonConverter.cs:79-83
public class FilterConditionTS : FilterTS { public required string token; public FilterOperation operation; public object? value; }
// FilterGroupTS: { groupOperation: "And"|"Or"; token?: string; filters: FilterTS[] }
```

`FilterOperation` values (from `Signum/React/Signum.DynamicQuery.ts`, mirroring the C# enum):
`EqualTo, DistinctTo, GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual,
Contains, StartsWith, EndsWith, Like, NotContains, NotStartsWith, NotEndsWith, NotLike,
IsIn, IsNotIn, ComplexCondition, FreeText, Matches, NotMatches`.

The filter `value` is deserialised **against the token's expected CLR type** and DateTimes
are coerced to the token's `DateTimeKind` (`FilterJsonConverter.cs:85-119`) — so send
Lites as Lite JSON objects, enums as their string name, dates as ISO strings.

#### `ResultTable` — the response of `executeQuery`

Non-obvious wire format: **columns are a flat array of token strings, rows carry a
positional array**, and high-cardinality-repeat columns are *dictionary-compressed*.
`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/ResultTableConverter.cs:10-97`:

```csharp
writer.WritePropertyName("columns");            // string[] of token FullKeys
...
writer.WritePropertyName("uniqueValues");       // { token: value[] }  for CompressUniqueValues columns
...
writer.WritePropertyName("pagination");         // PaginationTS
writer.WritePropertyName("totalElements");      // long? (null when mode != Paginate)
writer.WritePropertyName("rows");
foreach (var row in rt.Rows) {
    writer.WriteStartObject();
    if (rt.EntityColumn != null) { writer.WritePropertyName("entity"); JsonSerializer.Serialize(writer, row.Entity, options); }
    writer.WritePropertyName("columns");
    foreach (var column in rt.Columns) {
        if (uniqueValueIndexes.TryGetValue(column, out var indexes)) {
            var ix = indexes[row.Index];        // integer INDEX into uniqueValues[token], or null
            ...
```

Client-side mirror + the decompression step:

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/FindOptions.ts:339-350
export interface ResultTable {
  columns: string[];
  uniqueValues: { [token: string]: any[] }
  rows: ResultRow[];
  pagination: Pagination
  totalElements?: number;
}
export interface ResultRow {
  entity: Lite<Entity> | undefined;
  columns: any[];
}
```

`Finder.API.executeQuery` always pipes through `decompress(rt)`
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Finder.tsx:2107-2114`).
**A CLI must implement this decompression**: for every token present in `uniqueValues`,
the corresponding positional slot in `row.columns` is an integer index (or `null`), not a
value.

`ResultTableConverter.Read` throws `NotImplementedException` — the format is
**write-only**; you cannot POST a ResultTable.

#### Token metadata: `QueryDescriptionTS` / `QueryTokenTS`

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/QueryController.cs:139-170
public class QueryDescriptionTS
{
    public string queryKey;
    public Dictionary<string, QueryTokenTS> columns;   // keyed by token key

    public QueryDescriptionTS(QueryDescription qd)
    {
        this.queryKey = QueryUtils.GetKey(qd.QueryName);
        columns = new Dictionary<string, QueryTokenTS>();
        var count = new AggregateToken(AggregateFunction.Count, qd.QueryName);
        this.columns.Add(count.Key, QueryTokenTS.WithAutoExpand(count, qd));
        var timeSeries = new TimeSeriesToken(qd.QueryName);
        this.columns.Add(timeSeries.Key, QueryTokenTS.WithAutoExpand(timeSeries, qd));
        this.columns.AddRange(qd.Columns, a => a.Name, cd => { ... });
        ...
    }
    [JsonExtensionData] public Dictionary<string, object> Extension { get; set; } = new();
}
```

`QueryTokenTS` fields (`QueryController.cs:251-272`) — heavily `WhenWritingNull/Default`-suppressed:
`key`, `fullKey`, `toStr?`, `niceName?`, `queryTokenType?`, `type` (`TypeReferenceTS`),
`filterType?`, `format?`, `unit?`, `isGroupable`, `hasOrderAdapter`, `preferEquals`,
`tsVectorFor?`, `parent?`, `propertyRoute?`, `autoExpand`, `hideInAutoExpand`, `subTokens?`.

Compaction trick worth knowing (`QueryController.cs:180-185`): `toStr` is nulled when it
equals `key`, and `niceName` is nulled when it equals `toStr`. The client re-inflates them
in `completeToken` (`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/QueryToken.ts:48-69`):

```ts
export function completeToken(token: QueryToken): QueryToken {
  var t = token as Writable<QueryToken>;
  if (t.fullKey == null)  t.fullKey = t.parent == null ? t.key : t.parent.fullKey + "." + t.key;
  if (t.toStr == null)    t.toStr = t.key;
  if (t.niceName == null) t.niceName = t.toStr;
  t.queryTokenColor = getQueryTokenColor(t);
  if (t.filterType == null) t.filterType = getFilterType(t.type);
  ...
}
```

`QueryTokenType` union (`QueryController.cs:274-286` ≡ `QueryToken.ts:30`):
`Aggregate | Element | AnyOrAll | OperationContainer | ToArray | Manual | Nested |
Snippet | TimeSeries | IndexerContainer`.

`SubTokensOptions` is a flags enum the *server* controls; `api/query/subTokens` always
passes `SubTokensOptions.All`, so a CLI browsing tokens sees everything and must filter
client-side if it cares (the TS mirror is at `QueryToken.ts:32-42`).

### 1.4 Endpoint table — operations

Source: `OperationController.cs`. Operations are Signum's *only* write path for business
logic (there is no generic `PUT api/entity`). Saving is itself an operation
(e.g. `RoleOperation.Save`).

| Verb | Route | Request DTO | Response |
|---|---|---|---|
| POST | `api/operation/construct/{operationKey}` | `ConstructOperationRequest` = `{ Type, Args? }` | `EntityPackTS?` |
| POST | `api/operation/constructFromEntity/{operationKey}` | `EntityOperationRequest` = `{ entity, Args? }` | `EntityPackTS?` |
| POST | `api/operation/constructFromLite/{operationKey}` | `LiteOperationRequest` = `{ lite, Args? }` | `EntityPackTS?` |
| POST | `api/operation/executeEntity/{operationKey}` | `EntityOperationRequest` | `EntityPackTS` \| `400 ValidationProblemDetails` |
| POST | `api/operation/executeLite/{operationKey}` | `LiteOperationRequest` | `EntityPackTS` |
| POST | `api/operation/executeLiteWithProgress/{operationKey}` | `LiteOperationRequest` | **NDJSON** stream of `ProgressStep<EntityPackTS>` |
| POST | `api/operation/deleteEntity/{operationKey}` | `EntityOperationRequest` | `204` |
| POST | `api/operation/deleteLite/{operationKey}` | `LiteOperationRequest` | `204` |
| POST | `api/operation/constructFromMany/{operationKey}` | `MultiOperationRequest` | `EntityPackTS?` |
| POST | `api/operation/constructFromMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` |
| POST | `api/operation/executeMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` |
| POST | `api/operation/deleteMultiple/{operationKey}` | `MultiOperationRequest` | **NDJSON** stream of `OperationResult` |
| POST | `api/operation/stateCanExecutes` | `{ OperationKeys: string[], Lites: Lite[] }` | `{ AnyReadonly: bool, CanExecutes: { key: msg } }` |

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/OperationController.cs:118-152
public class ConstructOperationRequest : BaseOperationRequest { public required string Type { get; set; } }
public class EntityOperationRequest   : BaseOperationRequest { public required Entity entity { get; set; } }
public class LiteOperationRequest     : BaseOperationRequest { public required Lite<Entity> lite { get; set; } }

public class BaseOperationRequest
{
    public OperationSymbol GetOperationSymbol(string operationKey, Entity entity) => ParseOperationAssert(operationKey, entity.GetType(), entity);
    public static OperationSymbol ParseOperationAssert(string operationKey, Type entityType, Entity? entity)
    {
        var symbol = SymbolLogic<OperationSymbol>.ToSymbol(operationKey);
        OperationLogic.AssertOperationAllowed(symbol, entityType, inUserInterface: true, entity: entity);
        return symbol;
    }
    public List<JsonElement>? Args { get; set; }
    public object?[]? ParseArgs(OperationSymbol op) => Args?.Select(a => ConvertObject(a, SignumServer.JsonSerializerOptions, op)).ToArray();
}
```

**Casing gotcha:** the DTO members are a *mix* — `entity`, `lite` are lowercase; `Type`,
`Args`, `Lites`, `Setters`, `OperationKeys` are PascalCase. But
`JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase`
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/EntityJsonContext.cs:15`,
and `AddSignumJsonConverters` in `SignumServer.cs:160-175` uses the MVC-configured options),
so on the wire everything is **camelCase**: `type`, `args`, `lites`, `setters`,
`operationKeys`. This is confirmed by the client, which sends camelCase
(`Operations.tsx:233`: `{ args, type: getTypeName(type) }`).

**`args` is weakly typed and heuristically decoded** (`OperationController.cs:164-200`):

```csharp
case JsonValueKind.Object:
{
    if (token.TryGetProperty("EntityType", out var entityType))
        return token.ToObject<Lite<Entity>>(jsonOptions);      // has EntityType -> Lite
    if (token.TryGetProperty("Type", out var type))
        return token.ToObject<ModifiableEntity>(jsonOptions);  // has Type -> full entity
    var conv = operationSymbol == null ? null : CustomOperationArgsConverters.TryGetC(operationSymbol);
    return conv.GetInvocationListTyped().Select(f => f(token)).NotNull().FirstOrDefault();
}
case JsonValueKind.Number: return token.GetDecimal();   // NB: every number becomes decimal
case JsonValueKind.String:
    if (token.TryGetDateTime(out var dt)) return dt;    // NB: date-looking strings become DateTime
    ...
```

So: numbers arrive as `decimal`, ISO-8601-looking strings silently become `DateTime`, and
arbitrary objects need a server-registered `RegisterCustomOperationArgsConverter`.

**Bulk operations stream NDJSON** (`Produces("application/x-ndjson")`), one JSON object per
line, flushed per item (`OperationController.cs:603-629`):

```csharp
public static async Task ForeachNDJson<T, TResult>(this ControllerBase controller, IEnumerable<T> lites,
    CancellationToken cancellationToken, Func<T, Task<TResult>> action)
{
    var options = new JsonSerializerOptions { WriteIndented = false, IncludeFields = true,
                                              PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    options.Converters.AddRange(SignumServer.JsonSerializerOptions.Converters);
    foreach (var lite in lites.Distinct())
    {
        if (cancellationToken.IsCancellationRequested) return;
        var s = await action(lite);
        var json = JsonSerializer.Serialize(s, options);
        if (json.Contains("\n")) throw new InvalidOperationException("\n in Json object found!");
        await context.Response.WriteAsync(json + "\n");
        await context.Response.Body.FlushAsync();
    }
}
```

Payload shapes for the streams: `OperationResult = { entity: Lite, error?: string }`
(`OperationController.cs:262-272`) and
`ProgressStep<T> = { currentTask?, min?, max?, position?, isFinished, result?, error? }`
(`OperationController.cs:291-302`). Errors inside a bulk operation are **per-item**, so
HTTP 200 with `error` set on individual lines — a CLI must inspect each line.

`MultiOperationRequest` also supports declarative **setters** applied before the operation
(`OperationController.cs:304-321`), a mini expression language:

```csharp
public class MultiOperationRequest : BaseOperationRequest
{
    public string? Type { get; set; }
    public required Lite<Entity>[] Lites { get; set; }
    public List<PropertySetter>? Setters { get; set; }
}
public class PropertySetter
{
    public required string Property;         // property route, e.g. "Role" or "Details/Item/Quantity"
    public PropertyOperation? Operation;     // Set | AddElement | AddNewElement | ChangeElements | RemoveElement | RemoveElementsWhere | CreateNewEntity | ModifyEntity
    public FilterOperation? FilterOperation; // used inside Predicate
    public object? Value;
    public string? EntityType;
    public List<PropertySetter>? Predicate;
    public List<PropertySetter>? Setters;
}
```

Execution is in `MultiSetter.SetSetters` (`OperationController.cs:373-518`) and it
re-checks write permission per property route via
`SignumServer.WebEntityJsonConverterFactory.AssertCanWrite`.

**Validation errors on `executeEntity`** return `400` with an ASP.NET
`ValidationProblemDetails` built from the entity's `IntegrityCheckException`
(`OperationController.cs:48-74`) — i.e. a `{ "<prefix>.<property>": ["message"] }` map.
This is what the client turns into `ValidationError` and paints on the form.

### 1.5 Endpoint table — reflection / misc

| Verb | Route | Auth | Response |
|---|---|---|---|
| GET | `api/reflection/types` | **anonymous** | `Dictionary<string, TypeInfoTS>` + `Last-Modified` / `304` support |
| GET | `api/reflection/typeEntity/{typeName}` | auth | `TypeEntity?` |
| GET | `api/reflection/enumEntities/{typeName}` | auth | `{ enumValue: Entity }` |
| GET | `api/reflection/typeInDomains` | auth | `{ entityType: { domainType: { read: id[], write: id[] } } }` |
| POST | `api/registerClientError` | **anonymous** | `204` — logs a client-side JS error as `ExceptionEntity` |
| POST | `api/cascadeDelete/references` | auth | `List<CascadeReferenceDto>` (body: a bare `Lite<Entity>`) |

`CascadeDeleteController` is the only `[ApiController]` and takes a **bare Lite as the whole
body** (no wrapper object) — `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/CascadeDeleteController.cs:115-119`.

### 1.6 Extension endpoints (breadth, for CLI discovery)

There are ~250 additional routes under `Extensions/`. All follow `api/<area>/<action>`.
Enumerated with
`grep -rhn 'Http\(Get\|Post\)("' --include=*.cs Extensions Signum`. Highlights a CLI may care about:

- **Auth**: `api/auth/*`, `api/authAdmin/*` (see §1.8).
- **Excel export/import**: `POST api/excel/plain/{queryKey}` (a `QueryRequestTS` → xlsx),
  `POST api/excel/excelReport/{queryKey}`, `POST api/excel/import/{queryKey}`,
  `POST api/excel/validateForImport/{queryKey}`, `GET api/excel/reportsFor/{queryKey}`.
- **Files**: chunked upload protocol `POST api/files/startUpload` → `uploadChunk` →
  `finishUpload` / `abortUpload`; download `GET api/files/downloadFile/{fileId}`,
  `downloadFilePath/{filePathId}`, `downloadEmbeddedFilePath/{rootType}/{id}`.
- **User assets** (portable definitions of queries/charts/dashboards):
  `POST api/userAssets/export|import|importPreview`, plus
  `parseFilters`/`stringifyFilters`/`parseDate`/`stringifyDate` — useful if a CLI wants to
  round-trip saved queries.
- **Saved queries/charts/dashboards**: `api/userQueries/forQuery/{queryKey}`,
  `api/userChart/forQuery/{queryKey}`, `api/dashboard/home`, `POST api/dashboard/get`.
- **Culture**: `GET api/culture/cultures`, `GET api/culture/currentCulture`,
  `POST api/culture/setCurrentCulture` — all **anonymous**.
- **Health checks** (anonymous): `api/{asyncEmailSender,processes,scheduler,workflow}/healthCheck`,
  `api/userQueries/healthCheck/{id}`.
- **Rest API keys**: `GET api/restApiKey/generate`, `GET api/restApiKey/current`.
- **Tree entities**: `POST api/tree/findNodes/{typeName}`, `POST api/tree/getNode/{typeName}`,
  `GET api/tree/findLiteLikeByName/{typeName}/{subString}/{count}`.
- **Omnibox** (single search box → mixed results): `POST api/omnibox`.
- ⚠ `POST api/cache/invalidateAll`, `POST api/cache/invalidateTable` are marked
  `SignumAllowAnonymous` — unauthenticated cache invalidation
  (`Extensions/Signum.Caching/CacheController.cs:54,63`).

### 1.7 Global filters, error shape, response headers

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/SignumServer.cs:177-193`:

```csharp
public static MvcOptions AddSignumGlobalFilters(this MvcOptions options)
{
    options.Filters.Add(new SignumInitializeFilterAttribute());
    options.Filters.Add(new SignumExceptionFilterAttribute());
    options.Filters.Add(new CleanThreadContextAndAssertFilter());
    options.Filters.Add(new SignumEnableBufferingFilter());
    options.Filters.Add(new SignumCurrentContextFilter());
    options.Filters.Add(new SignumTimesTrackerFilter());
    options.Filters.Add(new SignumHeavyProfilerFilter());
    options.Filters.Add(new SignumHeavyProfilerResultFilter());
    options.Filters.Add(new SignumHeavyProfilerActionFilter());
    options.Filters.Add(new SignumAuthenticationFilter());
    options.Filters.Add(new SignumCultureSelectorFilter());
    options.Filters.Add(new VersionFilterAttribute());
    return options;
}
```

Error body is `HttpError` (`Signum/API/Filters/SignumExceptionFilterAttribute.cs:151-177`),
camelCased: `exceptionType`, `exceptionMessage`, `exceptionId`, `stackTrace`, `model`,
`innerException`. The TS mirror is authoritative for a CLI:

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Services.ts:381-388
export interface WebApiHttpError {
  exceptionType: string;
  exceptionMessage: string | null;
  stackTrace: string | null;
  exceptionId: string | null;
  model?: ModelEntity;
  innerException: WebApiHttpError | null;
}
```

Status-code mapping the client relies on (`Services.ts:248-253`):

- `400` **without** `exceptionType` ⇒ ModelState validation map `{ field: string[] }` → `ValidationError`.
- any error **with** `model` ⇒ `ModelRequestedError` (server is asking the UI to fill in a
  model entity and retry — e.g. an operation that needs extra input).
- otherwise ⇒ `ServiceError`.
- `AuthenticationException` and `UnauthorizedAccessException` both map to **403, not 401**
  (deliberate: `SignumExceptionFilterAttribute.cs:136-137` — *"Unauthorized produces Login
  Password dialog in Mixed mode"*).

Response headers every client should read
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Filters/VersionFilterAttribute.cs:24-27`):
`X-App-Version`, `X-App-BuildTime`. Plus `New_Token` from the auth filter (§1.8).

### 1.8 Authentication & authorization — how a headless client logs in

**Schemes available** (chain-of-responsibility over a static mutable list;
`Signum/API/Filters/SignumFilters.cs:39-68`):

```csharp
public class SignumAuthenticationFilter : SignumDisposableResourceFilter
{
    public const string Signum_User_Holder_Key = "Signum_User_Holder";
    public static readonly IList<Func<FilterContext, SignumAuthenticationResult?>> Authenticators = new List<...>();
    private static SignumAuthenticationResult? Authenticate(ResourceExecutingContext actionContext)
    {
        foreach (var item in Authenticators) { var result = item(actionContext); if (result != null) return result; }
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

Effective order (Signum.Rest inserts at index 0, `Extensions/Signum.Rest/RestApiKeyServer.cs:19`;
auth token appends, `Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs:27-30`):

1. `ApiKeyAuthenticator` — header `X-ApiKey` or query `?apiKey=`
2. `TokenAuthenticator` — header `Authorization: Bearer <token>`
3. `AnonymousUserAuthenticator` — if the app configures `AuthLogic.AnonymousUser`
4. `AllowAnonymousAuthenticator` — endpoints marked `[SignumAllowAnonymous]`
5. `InvalidAuthenticator` — unconditionally throws `AuthenticationException` ⇒ **403**

#### Option A — username/password → bearer token (recommended default)

```
POST {base}/api/auth/login
Content-Type: application/json
Accept: application/json

{ "userName": "...", "password": "...", "rememberMe": false }
```

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Authorization/AuthController.cs:12-70 (abridged)
[HttpPost("api/auth/login"), SignumAllowAnonymous]
public ActionResult<LoginResponse> Login([Required, FromBody] LoginRequest data)
{
    if (string.IsNullOrEmpty(data.userName)) return ModelError("userName", ...);
    if (string.IsNullOrEmpty(data.password)) return ModelError("password", ...);
    UserEntity user = AuthLogic.Authorizer == null
        ? AuthLogic.Login(data.userName, data.password, out authenticationType)
        : AuthLogic.Authorizer.Login(data.userName, data.password, out authenticationType);
    AuthServer.OnUserPreLogin(ControllerContext, user);
    AuthServer.AddUserSession(ControllerContext, user);
    user.FillTypeConditions();
    if (data.rememberMe == true) UserTicketServer.OnSaveCookie(ControllerContext);
    var token = AuthTokenServer.CreateToken(user);
    return new LoginResponse { userEntity = user, token = token, authenticationType = authenticationType };
}
```

DTOs (`AuthController.cs:167-197`):

```csharp
public class LoginRequest  { public string userName; public string password; public bool? rememberMe; }
public class LoginResponse { public string authenticationType; public string token; public UserEntity userEntity; }
public class ChangePasswordRequest { public string oldPassword; public string newPassword; }
```

`authenticationType` observed values: `"database"`, `"resetPassword"`, `"changePassword"`,
`"api-key"`, `"azureAD"`, `"cookie"`, `"windows"`, `"relogin"`.
(TS union at `Extensions/Signum.Authorization/AuthClient.tsx:278` is missing `"relogin"`.)

Then on **every** subsequent request:

```
Authorization: Bearer <token>
```

**Token internals** — not a JWT.
`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Authorization/AuthToken/AuthTokensServer.cs`:
`AuthToken { Lite<IUserEntity> User, Dictionary<string,object?> Claims, byte[]? PasswordHash, DateTime CreationDate }`
→ `System.Text.Json` → Deflate → AES-256-CBC/PKCS7 with a 16-byte random IV prepended
→ Base64 (`:205-261`). The key is `MD5(authTokenEncryptionKey)` (`:24-25`). Opaque and
unforgeable client-side; treat it as a bearer blob.

**Refresh protocol — must be implemented.** `AuthTokensServer.cs:66-102`:

```csharp
public static SignumAuthenticationResult? TokenAuthenticator(FilterContext ctx)
{
    var authHeader = ctx.HttpContext.Request.Headers[AuthHeader].FirstOrDefault();
    if (authHeader == null || !AuthenticateHeader(authHeader)) return null;
    var token = DeserializeAuthHeaderToken(authHeader);
    ...
    bool requiresRefresh =
        token.CreationDate < AuthTokenServer.GetTokenLimitDate() ||
        conf.RefreshAnyTokenPreviousTo.HasValue && token.CreationDate < conf.RefreshAnyTokenPreviousTo ||
        ctx.HttpContext.Request.Query.ContainsKey("refreshToken");
    if (requiresRefresh) {
        ctx.HttpContext.Response.Headers["New_Token"] = RefreshToken(token, out var newUserWithClaims);
        return new SignumAuthenticationResult { UserWithClaims = newUserWithClaims };
    }
    ...
}
```

- Header name is `AuthTokenServer.AuthHeader` = `"Authorization"` (`:57`), value parsed with
  `authHeader.After("Bearer ")` (`:144`). Under Windows auth it becomes
  `Signum_Authorization` (`:59-62`).
- No hard expiry; `AuthTokenConfigurationEmbedded.RefreshTokenEvery` defaults to **30 min**,
  after which the server transparently re-issues and hands you the new value in the
  **`New_Token` response header** (raw, no `Bearer ` prefix). Adopt it.
- Refresh re-validates: user still exists, `State == Active`, `ToString()` unchanged,
  `PasswordHash` byte-equal (`RefreshToken` `:104-137`) ⇒ **a password change invalidates
  every outstanding token**.

Client-side reference implementation of exactly this loop
(`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Authorization/AuthClient.tsx:153-186`):

```tsx
export function addAuthToken(options: Services.AjaxOptions, makeCall: () => Promise<Response>): Promise<Response> {
  const token = getAuthToken();
  if (!token) return makeCall();
  if (options.headers == undefined) options.headers = {};
  options.headers[Options.AuthHeader] = "Bearer " + token;      // Options.AuthHeader === "Authorization"
  return makeCall().then(r => {
      var newToken = r.headers.get("New_Token");
      if (newToken) {
        setAuthToken(newToken, getAuthenticationType());
        API.fetchCurrentUser().then(cu => setCurrentUser(cu));
      }
      return r;
    }, ifError<ServiceError, Response>(ServiceError, e => {
      if (e.httpError.exceptionType?.endsWith(".AuthenticationException")) {
        setAuthToken(undefined, undefined);
        setCurrentUser(undefined);
        AppContext.resetUI(); AppContext.navigate("/auth/login");
      }
      throw e;
    }));
}
```

Note the browser stores the token in **`sessionStorage`, not a cookie**
(`AuthClient.tsx:188-200`), so there is no cookie/CSRF machinery to emulate — and indeed
**no anti-forgery token exists anywhere in the framework** (`grep -rn "AntiForgery|XSRF"` ⇒ 0 C# hits).
Cookies are used only for the optional "remember me" *user ticket* (`sfUser`,
`Extensions/Signum.Authorization/UserTicket/UserTicketServer.cs:10`, set without
`HttpOnly`/`Secure`/`SameSite`).

#### Option B — API key (simplest for a CLI, if ops will provision one)

`Extensions/Signum.Rest/RestApiKeyLogic.cs:9-10`:

```csharp
public readonly static string ApiKeyQueryParameter = "apiKey";
public readonly static string ApiKeyHeader = "X-ApiKey";
```

`Extensions/Signum.Rest/RestApiKeyServer.cs:23-44`:

```csharp
public static SignumAuthenticationResult? ApiKeyAuthenticator(HttpContext httpCtx)
{
    httpCtx.Request.Query.TryGetValue(RestApiKeyLogic.ApiKeyQueryParameter, out var val);
    httpCtx.Request.Headers.TryGetValue(RestApiKeyLogic.ApiKeyHeader, out var headerKeys);
    var keys = val.Distinct().Union(headerKeys.Distinct()).NotNull().ToList()!;
    if (keys.Count == 1)
        using (AuthLogic.Disable())
        {
            var user = RestApiKeyLogic.RestApiKeyCache.Value
                .GetOrThrow(keys.Single(), $"Could not authenticate with the API Key {keys.Single()}.")
                .User.RetrieveAndRemember();
            return new SignumAuthenticationResult { UserWithClaims = new UserWithClaims(user) };
        }
    else if (keys.Count() > 1)
        throw new AuthenticationException("Request contains multiple API Keys. ...");
    return null;
}
```

Send `X-ApiKey: <key>` on any endpoint — **no login call at all**. Because it is registered
at index 0, an API key *overrides* a `Bearer` header on the same request. `RestApiKeyEntity`
= `Lite<UserEntity> User` + `string ApiKey` (min 20 / max 100 chars, unique index),
**stored in cleartext**, and `?apiKey=` in a URL is captured into `RestLogEntity.QueryString`
and web-server logs — prefer the header. `GET api/auth/loginFromApiKey?apiKey=` trades a key
for a normal bearer token (note: the `apiKey` method parameter is unused; the filter reads it,
so it must be in the query string or `X-ApiKey`).

Requires the app to have started `Signum.Rest`; the framework's core does **not** include
API-key auth on its own.

#### Option C — federated / cookie (not for CLIs)

`POST api/auth/loginWithAzureAD`, `POST api/auth/loginWithOpenID`,
`POST api/auth/loginWindowsAuthentication`, `POST api/auth/loginFromCookie` — all return the
same `LoginResponse` shape. `GET api/auth/openIDEndpoints` discovers OIDC config.

#### Session-management endpoints

| Verb | Route | Notes |
|---|---|---|
| GET | `api/auth/currentUser?refreshToken=true` | validate/keep-alive; `?refreshToken` forces a `New_Token` |
| GET | `api/auth/relogin` | returns a whole new `LoginResponse` |
| POST | `api/auth/logout` | clears the `sfUser` cookie; the bearer token is stateless so **it stays valid** |
| POST | `api/auth/ChangePassword` | `{ oldPassword, newPassword }` → new `LoginResponse` (invalidates old tokens) |
| POST | `api/auth/forgotPasswordEmail` / `resetPassword` / `requestNewLink` | anonymous |

#### Authorization

Coarse-grained checks happen *inside* the generic endpoints, not as route-level policies:

- Type/property/query/operation/permission rules live in
  `Extensions/Signum.Authorization/` and are enforced by
  `OperationLogic.AssertOperationAllowed` (per operation),
  `Schema.Current.IsAllowed` (per type), and the JSON converter's
  `CanReadPropertyRoute` / `CanWritePropertyRoute` hooks (per property — see §1.9).
- Denials surface as `UnauthorizedAccessException` ⇒ **403** with
  `exceptionType` ending in `.UnauthorizedAccessException`.
- Metadata is **role-filtered**: with Authorization installed, the reflection cache key
  becomes culture + role (`Extensions/Signum.Authorization/AuthServer.cs:32-36`), so
  `api/reflection/types` returns *only what the caller may see*. A CLI therefore gets
  automatic capability discovery — if a type/operation isn't in the metadata, you can't use it.
- Rule administration: `api/authAdmin/{permission,type,operation,property,query}Rules[/...]`
  (GET to read, POST to write), plus `GET api/authAdmin/downloadAuthRules`.

**CORS is not configured by default** — only an optional upgrade adds an `AllowAnyOrigin`
policy scoped to health checks (`Signum.Upgrade/Upgrades/Upgrade_20241203_CorsHealthCheck.cs`).
Irrelevant for a non-browser client.

### 1.9 JSON serialization conventions

Registration — `/home/patrick.maue/git/sfcl/signum-framework/Signum/API/SignumServer.cs:160-175`:

```csharp
public static JsonSerializerOptions AddSignumJsonConverters(this JsonSerializerOptions jso)
{
    jso.IncludeFields = true;
    jso.WriteIndented = true;
    jso.Converters.Add(WebEntityJsonConverterFactory);
    jso.Converters.Add(new LiteJsonConverterFactory());
    jso.Converters.Add(new MListJsonConverterFactory((pr, root, metadata) => WebEntityJsonConverterFactory.AssertCanWrite(pr, root as ModifiableEntity, metadata)));
    jso.Converters.Add(new JsonStringEnumConverter());
    jso.Converters.Add(new ResultTableConverter());
    jso.Converters.Add(new TimeSpanConverter());
    jso.Converters.Add(new DateOnlyConverter());
    jso.Converters.Add(new TimeOnlyConverter());
    return jso;
}
```

Naming policy is camelCase (`EntityJsonContext.cs:15`), fields are included, and **enums are
serialized as strings** (`JsonStringEnumConverter`).

#### Entity wire format

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/EntityJsonConverter.cs:249-355`
(`EntityJsonConverter<T>.Write`), abridged:

```csharp
writer.WriteStartObject();
if (mod is Entity entity)
{
    writer.WriteString("Type", TypeLogic.TryGetCleanName(mod.GetType()));
    writer.WritePropertyName("id");
    JsonSerializer.Serialize(writer, entity.IdOrNull?.Object, ..., options);
    if (entity.IsNew) writer.WriteBoolean("isNew", true);
    var table = Schema.Current.Table(entity.GetType());
    if (table.PartitionId != null && entity.PartitionId != null) writer.WriteNumber("partitionId", entity.PartitionId!.Value);
    if (table.Ticks != null) writer.WriteString("ticks", entity.Ticks.ToString());   // string, not number!
}
else
    writer.WriteString("Type", ReflectionServer.GetTypeName(mod.GetType()));

if (!(mod is MixinEntity)) writer.WriteString("toStr", mod.ToString());
writer.WriteBoolean("modified", mod.Modified == ModifiedState.Modified || mod.Modified == ModifiedState.SelfModified);

foreach (var kvp in Factory.GetPropertyConverters(mod.GetType()))
    WriteJsonProperty(writer, options, mod, kvp.Key, kvp.Value, tup.pr, tup.metadata);
// ... then "propsMeta" and "mixins"
```

Key facts:

- `Type` is **PascalCase and holds the *clean* type name** (`Role`, not `RoleEntity`).
  It is the discriminator, and it also appears on embeddeds/models/mixins.
- `ticks` (row version / optimistic concurrency) is a **string** carrying an int64.
- `modified` is a boolean derived from `ModifiedState`; the server uses it together with
  `ticks` to raise `ConcurrencyException` (`EntityJsonConverter.cs:646-651`).
- `propsMeta: string[]` lists readonly (`"prop"`) and hidden (`"!prop"`) properties
  (`:326-332`); it is **read and discarded** on the way in (`:441-445`).
- `mixins: { MixinTypeName: {...} }` keyed by the **CLR type name** (not clean name), `:333-350`.
- Property names are the camelCase C# property names; entity properties are only written if
  `CanReadPropertyRoute` allows it (`:375-378`) — so a low-privilege caller silently sees
  *fewer keys*, not an error.
- **Round-trip constraint:** on read, the "special" props must come **first** in the object:

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/EntityJsonConverter.cs:769
static readonly string[] specialProps = new string[] { "toStr", "id", "isNew", "Type", "ticks", "modified", "temporalId" };
// :455-456
if (specialProps.Contains(propertyName))
    throw new InvalidOperationException($"Property '{propertyName}' is a special property like ..., and they can only be at the beginning of the Json object for performance reasons");
```

  and any unknown property is a hard `KeyNotFoundException` (`:458`) — the deserialiser is
  **strict**. A CLI must emit `Type`/`id`/`isNew`/`ticks`/`modified`/`toStr` before regular
  properties, and must not invent keys.
- On read with `EntityJsonConverterStrategy.WebAPI`, a non-new entity is **re-retrieved from
  the database** and the posted properties are applied on top (`:661-676`) — you may send a
  partial entity graph for a save, but concurrency is checked via `ticks`.

#### `Lite<T>` wire format

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/LiteJsonConverter.cs:23-68`:

```csharp
writer.WriteStartObject();
writer.WriteString("EntityType", TypeLogic.GetCleanName(lite.EntityType));
if (lite.ModelType != Lite.DefaultModelType(lite.EntityType))
    writer.WriteString("ModelType", Lite.ModelTypeToString(lite.ModelType));
writer.WritePropertyName("id");
JsonSerializer.Serialize(writer, lite.IdOrNull?.Object, ..., options);
if (value.PartitionId != null) { writer.WritePropertyName("partitionId"); writer.WriteNumberValue(value.PartitionId.Value); }
if (lite.Model != null) { /* string -> "model": "...", else nested ModelEntity */ }
if (lite.EntityOrNull != null) { writer.WritePropertyName("entity"); JsonSerializer.Serialize(writer, lite.Entity, options); }
writer.WriteEndObject();
```

**Lite uses `EntityType`; full entities use `Type`.** Mixing them is explicitly rejected:

```csharp
// LiteJsonConverter.cs:136
case "Type": throw new JsonException($"Unexpected property 'Type' in Lite JSON. Use 'EntityType' instead (Lite uses 'EntityType', full entities use 'Type').");
```

Unknown properties in a Lite are also fatal (`:137`). Accepted set:
`EntityType`, `id`, `ModelType`, `model`, `partitionId`, `entity`.
`model` is normally the display string (`toStr` equivalent); it can be a full `ModelEntity`
for types with a custom lite model.

TS mirror (`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Signum.Entities.ts:79-96`):

```ts
export interface Lite<T extends Entity> {
  EntityType: string;
  id?: number | string;
  model?: unknown;
  partitionId?: number;
  ModelType?: string;
  entity?: T;
}
export interface ModelState { [field: string]: string[]; }
export interface EntityPack<T extends ModifiableEntity> {
  readonly entity: T
  readonly canExecute: { [key: string]: string };
}
```

and the compact string form used in URLs / filter query strings
(`Signum.Entities.ts:255-276`): `liteKey` = `` `${EntityType};${id}` ``,
`liteKeyLong` = `` `${EntityType};${id};${toStr}` ``, with `parseLite` reversing it.

#### `MList<T>` wire format

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/Json/MListJsonConverter.cs:65-89`:

```csharp
writer.WriteStartArray();
foreach (var item in ((IMListPrivate<T>)value).InnerList)
{
    writer.WriteStartObject();
    writer.WritePropertyName("rowId");
    JsonSerializer.Serialize(writer, item.RowId?.Object, ..., options);
    writer.WritePropertyName("element");
    using (EntityJsonContext.AddSerializationStep(new (elementPr, item.Element as ModifiableEntity, rowId: item.RowId)))
        JsonSerializer.Serialize(writer, item.Element, item.Element?.GetType() ?? typeof(T), options);
    writer.WriteEndObject();
}
writer.WriteEndArray();
```

So an MList is **never a plain array of values** — it is an array of
`{ rowId, element }` envelopes; `rowId: null` means "new row". `rowId` must be the first
property of each envelope (`MListJsonConverter.cs:116-117` hard-checks it). TS mirror
(`Signum.Entities.ts:59-68`):

```ts
export type MList<T> = Array<MListElement<T>>;
export interface MListElement<T> { rowId: number | string | null; element: T; }
export function newMListElement<T>(element: T): MListElement<T> { return { rowId: null, element }; }
```

#### Scalar conventions

- `DateOnly` → `"yyyy-MM-dd"` (`Signum/API/Json/DateOnlyConverter.cs`),
  `TimeOnly` / `TimeSpan` → ISO-ish strings (`TimeOnlyConverter.cs`, `TimeSpanConverter.cs`).
- `DateTime` uses default `System.Text.Json` ISO-8601; the *query filter* path additionally
  coerces to the token's `DateTimeKind`.
- Enums are strings. `PrimaryKey` ids serialise as their underlying value (int → number,
  Guid/string → string), so a CLI must accept `number | string` for every `id`.

#### Realistic examples

A full entity as returned by `GET api/entity/Auth.User/2`:

```json
{
  "Type": "Auth.User",
  "id": 2,
  "ticks": "638562881230000000",
  "toStr": "john.doe",
  "modified": false,
  "userName": "john.doe",
  "passwordHash": null,
  "email": "john.doe@example.com",
  "role": {
    "EntityType": "Role",
    "id": 3,
    "model": "Administrator"
  },
  "state": "Active",
  "cultureInfo": null,
  "disabledOn": null,
  "loginFailedCounter": 0,
  "propsMeta": ["!passwordHash", "loginFailedCounter"],
  "mixins": {
    "CorruptMixin": { "Type": "CorruptMixin", "modified": false, "corrupt": false }
  }
}
```

The same user as a `Lite`:

```json
{ "EntityType": "Auth.User", "id": 2, "model": "john.doe" }
```

An `EntityPackTS` (`GET api/entityPack/Role/3`):

```json
{
  "entity": {
    "Type": "Role",
    "id": 3,
    "ticks": "638562881230000000",
    "toStr": "Administrator",
    "modified": false,
    "name": "Administrator",
    "mergeStrategy": "Union",
    "isTrivialMerge": false,
    "inheritsFrom": [
      { "rowId": 17, "element": { "EntityType": "Role", "id": 1, "model": "User" } }
    ]
  },
  "canExecute": {
    "RoleOperation.Save": null,
    "RoleOperation.Delete": "Role is in use by 4 users"
  }
}
```

A `POST api/query/executeQuery/Auth.User` body and response:

```json
{
  "queryKey": "Auth.User",
  "groupResults": false,
  "filters": [
    { "token": "Entity.State", "operation": "EqualTo", "value": "Active" },
    { "groupOperation": "Or", "filters": [
        { "token": "Entity.UserName", "operation": "Contains", "value": "doe" },
        { "token": "Entity.Email",    "operation": "Contains", "value": "doe" } ] }
  ],
  "orders":  [ { "token": "Entity.UserName", "orderType": "Ascending" } ],
  "columns": [ { "token": "Entity.UserName" }, { "token": "Entity.Role" } ],
  "pagination": { "mode": "Paginate", "elementsPerPage": 20, "currentPage": 1 }
}
```

```json
{
  "columns": ["Entity.UserName", "Entity.Role"],
  "uniqueValues": { "Entity.Role": [ { "EntityType": "Role", "id": 3, "model": "Administrator" } ] },
  "pagination": { "mode": "Paginate", "elementsPerPage": 20, "currentPage": 1 },
  "totalElements": 1,
  "rows": [
    { "entity": { "EntityType": "Auth.User", "id": 2, "model": "john.doe" },
      "columns": ["john.doe", 0] }
  ]
}
```

Note `"columns": ["john.doe", 0]` — the `0` is an **index into
`uniqueValues["Entity.Role"]`**, not a value.

An operation call, `POST api/operation/executeEntity/RoleOperation.Save`:

```json
{
  "entity": { "Type": "Role", "id": 3, "ticks": "638562881230000000", "modified": true,
              "name": "Administrators", "mergeStrategy": "Union", "isTrivialMerge": false,
              "inheritsFrom": [ { "rowId": 17, "element": { "EntityType": "Role", "id": 1 } } ] },
  "args": null
}
```

### 1.10 `ReflectionServer` — the type-metadata endpoint

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/ReflectionServer.cs` (636 lines) is
the single most important endpoint for a CLI: it is the schema.

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum/API/Controllers/ReflectionController.cs:14-27
[HttpGet("api/reflection/types"), SignumAllowAnonymous]
public ActionResult<Dictionary<string, TypeInfoTS>> Types()
{
    this.Response.GetTypedHeaders().LastModified = ReflectionServer.LastModified;
    var requestHeaders = this.Request.GetTypedHeaders();
    if (requestHeaders.IfModifiedSince.HasValue &&
        (ReflectionServer.LastModified - requestHeaders.IfModifiedSince.Value).TotalSeconds < 1)
        return this.StatusCode(StatusCodes.Status304NotModified);
    return ReflectionServer.GetTypeInfoTS();
}
```

Caching and context (`ReflectionServer.cs:15-30`, `:87-91`, `:161-186`): the payload is
memoised per `GetContext()`, which by default is the current *valid* culture (walking parents
until a translation file exists, falling back to `en`), and with Authorization installed
becomes `{ Culture, Role }` (`Extensions/Signum.Authorization/AuthServer.cs:32-36`).
`DescriptionManager.Invalidated`, schema events, and `AuthLogic.OnRulesChanged` all call
`InvalidateCache()`, which bumps `LastModified` — so `If-Modified-Since` is a real
optimisation for a long-lived CLI.

Wire shape (`ReflectionServer.cs:462-530`):

```csharp
public class TypeInfoTS
{
    public KindOfType Kind { get; set; }                 // Entity | Enum | Message | Query | SymbolContainer
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
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, MemberInfoTS> Members { get; set; } = null!;
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, CustomLiteModelTS>? CustomLiteModels { get; set; }
    [JsonIgnore(...WhenWritingDefault)] public bool HasConstructorOperation { get; set; }
    [JsonIgnore(...WhenWritingNull)] public Dictionary<string, OperationInfoTS>? Operations { get; set; }
    [JsonExtensionData] public Dictionary<string, object> Extension { get; set; } = new();
}
```

`MemberInfoTS` (`:495-516`) carries everything the UI needs to render a field without extra
round-trips: `Type` (a `TypeReferenceTS`), `NiceName`, `IsReadOnly`, `Required`, `Unit`,
`Format`, `IsIgnoredEnum`, `IsVirtualMList`, `MaxLength`, `IsMultiline`, `PreserveOrder`,
`AvoidDuplicates`, `Id` (for symbols), `IsPhone`, `IsMail`, `HasFullTextIndex`.

`OperationInfoTS` (`:517-530`): `OperationType`, `CanBeNew`, `CanBeModified`,
`ForReadonlyEntity`, `ResultIsSaved`, `HasCanExecute`, `HasCanExecuteExpression`, `HasStates`.
`CanBeModified` is what tells the client whether to call the `…Entity` or the `…Lite` variant
of an operation endpoint (§2.7).

Nice names come from the C# side:
- entities: `GetEntityTypeInfo` (`ReflectionServer.cs:240-315`) walks
  `PropertyRoute.GenerateRoutes(type)` and sets `NiceName = pr.PropertyInfo!.NiceName()`;
- enums/messages/queries: `GetEnumTypeInfo` (`:331-360`), with `Kind` decided by name suffix
  (`…Query` → Query, `…Message` → Message, else Enum);
- symbol containers: `GetSymbolContainerTypeInfo` (`:363-386`) also emits each symbol's
  database `Id`.

Both `TypeInfoTS`, `MemberInfoTS` and `OperationInfoTS` have `[JsonExtensionData]` bags, so
extensions add fields freely — a CLI must be tolerant.

Everything is `WhenWritingNull/WhenWritingDefault`-suppressed, so **absent means default**
(`false`, `null`) — do not treat a missing key as an error.

---

## 2. Client architecture (`Signum/React/`)

Scale: ~574 `.tsx` + ~164 `.ts`. `Signum/React/` is the framework core (~40 top-level files
plus the `Lines/`, `SearchControl/`, `Frames/`, `Basics/`, `Components/`, `Modals/`,
`Operations/`, `Exceptions/` folders); each `Extensions/Signum.*/` is a peer package that
imports the core through the `@framework/*` path alias.

### 2.1 Subsystem map

| Subsystem | Entry file | Responsibility |
|---|---|---|
| **Reflection** | `Signum/React/Reflection.ts` (2595 ln) | Runtime type registry: `TypeInfo`, `Type<T>`, `EnumType<T>`, `MessageKey`, `QueryKey`, `PropertyRoute`, `Binding`, `GraphExplorer`, `registerSymbol`, `setTypes`/`reloadTypes` |
| **Entity mirrors** | `Signum/React/Signum.Entities.ts` + `Signum.Basics.ts`, `Signum.Operations.ts`, `Signum.Security.ts`, `Signum.DynamicQuery*.ts`, `Signum.External.ts`, `Signum.Entities.Validation.ts` | Generated TS interfaces/`Type<T>` registrations + hand-written runtime helpers (`toLite`, `liteKey`, `getToString`, `getMixin`, `MList`) |
| **Services** | `Signum/React/Services.ts` (514 ln) | `ajaxGet`/`ajaxPost`, filter pipeline, error classes |
| **Finder** | `Signum/React/Finder.tsx` (2569 ln), `FindOptions.ts` (564 ln), `QueryToken.ts` (370 ln) | DynamicQuery client: find options ↔ URL ↔ `QueryRequest`, token cache, formatters |
| **SearchControl** | `Signum/React/SearchControl/` (28 files), barrel `Search.tsx` | The grid: `SearchControl`, `SearchControlLoaded`, `FilterBuilder`, `QueryTokenBuilder`, `ColumnEditor`, `PaginationSelector`, `SearchModal`, `SearchPage`, `SearchValueLine` |
| **Navigator** | `Signum/React/Navigator.tsx` (1338 ln) | `EntitySettings`, view registration/`ViewPromise`, routing, `view()`/`navigate()`, creatable/viewable/findable policy |
| **Operations** | `Signum/React/Operations.tsx` (1029 ln) + `Operations/` | `OperationSettings`, `EntityOperationContext`, button-bar + contextual-menu + cell integration, default click handlers |
| **TypeContext / Lines** | `Signum/React/TypeContext.ts` (561 ln), `Lines.tsx` barrel, `Lines/` (37 files) | Form-binding model and the widget library |
| **Frames** | `Signum/React/Frames/` | `FramePage` (full page), `FrameModal` (popup), `ButtonBar`, `ValidationErrors`, `Widgets`, `Notify`, `VersionChangedAlert` |
| **Hooks** | `Signum/React/Hooks.ts` | `useAPI`, `useAPIWithReload`, `useForceUpdate`, `useThrottle`, `useLock`, `useSize`, `useBreakpoint`, … |
| **AppContext** | `Signum/React/AppContext.tsx` | current user/culture, router history, `toAbsoluteUrl`, `resetUI`, `clearSettingsActions` |
| **Misc** | `Constructor.tsx`, `Modals.tsx`, `SelectorModal.tsx`, `QuickLinkClient.tsx`, `AutoLineModal.tsx`, `useSignalR.tsx`, `Cookies.ts`, `QueryString.ts`, `Globals.ts` (prototype extensions) | |

A cross-cutting convention: nearly every subsystem exposes
`export namespace X { export function start(...) }` plus a mutable registry
(`entitySettings`, `operationSettings`, `formatRules`, `onContextualItems`,
`addContextHeaders`, `clearSettingsActions`) — the framework is configured by *pushing into
arrays* at app boot, not by DI.

### 2.2 Generated `*.ts` entity mirrors (TSGenerator)

`Signum.TSGenerator` is a standalone .NET 10 **exe** (`/home/patrick.maue/git/sfcl/signum-framework/Signum.TSGenerator/Signum.TSGenerator.csproj:1-25`)
that reflects the *just-compiled intermediate assembly* with **Mono.Cecil** (no assembly
loading) and, for each C# namespace, emits `<Namespace>.ts` next to a hand-written
`<Namespace>.t4s`.

There is **no template language**: the `.t4s` is a plain TypeScript fragment concatenated
verbatim, and the `//////` block is just an "auto-generated" banner.
`/home/patrick.maue/git/sfcl/signum-framework/Signum.TSGenerator/EntityDeclarationGenerator.cs:182-220`:

```csharp
StringBuilder sb = new StringBuilder();
sb.AppendLine(@"//////////////////////////////////");
sb.AppendLine(@"//Auto-generated. Do NOT modify!//");
sb.AppendLine(@"//////////////////////////////////");
sb.AppendLine();
var path = namespacesReferences.GetOrThrow("Signum").GetOrThrow("Signum.Entities").FullPath.Replace("Signum.Entities.ts", "Reflection.ts");
sb.AppendLine($"import {{ MessageKey, QueryKey, Type, EnumType, registerSymbol }} from '{RelativePath(path, templateFileName)}'");

foreach (var assRef in namespacesReferences.Values)
    foreach (var nsRef in assRef.Values)
        sb.AppendLine($"import * as {nsRef.VariableName} from '{RelativePath(nsRef.FullPath, templateFileName)}'");

sb.AppendLine();
sb.AppendLine(File.ReadAllText(templateFileName));   // the whole .t4s, verbatim

foreach (var t in texts.OrderBy(a => a.Name))        // generated declarations, alphabetical
{ sb.Append(t.Text); sb.AppendLine(); }
```

Eight buckets are reflected (`EntityDeclarationGenerator.cs:72-172`): entities, interfaces,
enums, `*Message` enums, `*Query` enums, static classes with `[AutoInit]`
(symbol containers), plus external/`[ImportInTypeScript]` types. `CleanTypeName`
(`:434-450`) strips the `Entity`/`Model`/`Symbol` suffix — which is exactly the wire
`Type`/`EntityType` value.

Concrete output patterns:

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Signum.Entities.ts:347-356
export const BigStringEmbedded: Type<BigStringEmbedded> = new Type<BigStringEmbedded>("BigStringEmbedded");
export interface BigStringEmbedded extends EmbeddedEntity {
  Type: "BigStringEmbedded";
  text: string | null;
}

export const BooleanEnum: EnumType<BooleanEnum> = new EnumType<BooleanEnum>("BooleanEnum");
export type BooleanEnum =
  "False" |
  "True";
```

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Signum.Entities.ts:675-679
export namespace SearchMessage {
  export const ChooseTheDisplayNameOfTheNewColumn: MessageKey = new MessageKey("SearchMessage", "ChooseTheDisplayNameOfTheNewColumn");
  export const Field: MessageKey = new MessageKey("SearchMessage", "Field");
  ...
```

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Authorization/Signum.Authorization.ts:108-111
export namespace RoleOperation {
  export const Save : Operations.ExecuteSymbol<RoleEntity> = registerSymbol("Operation", "RoleOperation.Save");
  export const Delete : Operations.DeleteSymbol<RoleEntity> = registerSymbol("Operation", "RoleOperation.Delete");
}
```

The `Type<T>` object is the client's handle for everything typed:
`RoleEntity.typeName`, `.niceName()`, `.nicePluralName()`, `.nicePropertyName(a => a.name)`,
`.token(a => a.name)` (builds a `QueryTokenString`), `.New()`.
Both the `.t4s` and the generated `.ts` are committed to git; only `ts_out/` is ignored
(`.gitignore:41`). Hand-written augmentation is done by TypeScript **declaration merging**,
e.g. `Extensions/Signum.Authorization/Signum.Authorization.t4s:1-3`:

```ts
export interface UserEntity {
    newPassword: string;
}
```

which merges onto the generated `UserEntity` interface — that's how the write-only
`newPassword` pseudo-property (added server-side in
`Extensions/Signum.Authorization/AuthServer.cs:306-332`) becomes typed on the client.

**Invocation** (`Signum.TSGenerator/Signum.TSGenerator.targets:1-20`): the NuGet package
injects itself into `BuildDependsOn` as `GenerateSignumTS` → `TSC_BuildAll`, and runs
`dotnet Signum.TSGenerator.dll <IntermediateAssembly> SignumReferences.txt SignumContent.txt`.
Guarded by `TSGeneratorDisabled` (the framework's `Signum/Signum.csproj:10` sets it to
`false` explicitly; apps run it on demand). Up-to-date checking is timestamp-based over the
assembly + `.t4s` files (`Program.cs:37-48`), and a namespace with exports but no `.t4s`
gets a **0-byte `.t4s` silently created in the source tree** (`Program.cs:100-115`).

### 2.3 `TypeContext` and the `Lines` — the form-binding model

`TypeContext<T>` is a *lens*: it pairs a **`PropertyRoute`** (schema position) with an
**`IBinding<T>`** (get/set into the live entity graph) and inherits presentation options
from a `StyleContext` parent chain.

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/TypeContext.ts:253-296 (abridged)
export class TypeContext<T> extends StyleContext {
  propertyRoute: PropertyRoute | undefined;
  binding: IBinding<T>;
  previousVersion?: { value: T, oldIndex?: number, isMoved?: boolean }; // Time Machine
  prefix: string;

  get value() { return this.binding.getValue(); }
  set value(val: T) { this.binding.setValue(val); }
  get error() { return this.binding.getError(); }
  set error(val: string | undefined) { this.binding.setError(val); }

  static root<T extends ModifiableEntity>(value: T, styleOptions?: StyleOptions, parent?: StyleContext): TypeContext<T> {
    return new TypeContext(parent, styleOptions, PropertyRoute.root(value.Type), new ReadonlyBinding<T>(value, ""));
  }

  constructor(parent: StyleContext | undefined, styleOptions: StyleOptions | undefined,
              propertyRoute: PropertyRoute | undefined, binding: IBinding<T>, prefix?: string) { ... }
```

Navigation is via `subCtx`, overloaded on a **lambda member path**, a mixin `Type<M>`, a
string field name, or just style options (`TypeContext.ts:299-326`):

```ts
subCtx(styleOptions: StyleOptions): TypeContext<T>
subCtx<R>(property: (val: T) => R, styleOptions?: StyleOptions): TypeContext<R>
subCtx<M extends MixinEntity>(mixin: Type<M>, styleOptions?: StyleOptions): TypeContext<M>
subCtx(field: string, styleOptions?: StyleOptions): TypeContext<any>
subCtx(arg: ((val: T) => any) | IType | string | StyleOptions, styleOptions?: StyleOptions): TypeContext<any> {
  ...
  const lambdaMembers =
    typeof arg == "function" ? getLambdaMembers(arg) :
      isType(arg) ? [{ type: "Mixin", name: arg.typeName } as LambdaMember] :
        getFieldMembers(arg);
  const subRoute = lambdaMembers.reduce<PropertyRoute | undefined>((pr, m) => pr && pr.tryAddLambdaMember(m), this.propertyRoute);
  const binding = createBinding(this.value, lambdaMembers);
  const result = new TypeContext<any>(this, styleOptions, subRoute, binding);
  ...
}
```

`getLambdaMembers(a => a.role.entity.name)` **parses the arrow function's source text** to
recover the member path — that is how `ctx.subCtx(a => a.userName)` yields both a runtime
binding and a compile-time-checked `PropertyRoute`. Collections expand via
`mlistItemContext` (`TypeContext.ts:524-561`), which creates one child context per row using
`MListElementBinding` (indexing into `MList<T>`'s `{rowId, element}` envelopes) and also
diffs against `previousVersion` for the Time-Machine (system-versioned) UI.

`ctx.prefix` accumulates the binding suffixes and becomes the DOM `id`/`name` prefix — and
crucially it is the key used to map server `ModelState` paths back onto individual inputs
(`frame.setError(e.modelState, "entity")`).

**Lines** are React components taking `ctx` plus presentation props:

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Lines/LineBase.tsx:14-33
export interface LineBaseProps<V = unknown> extends StyleOptions {
  ctx: TypeContext<V>;
  unit?: string;
  format?: string;
  type?: TypeReference;
  label?: React.ReactNode;
  labelIcon?: React.ReactNode;
  visible?: boolean;
  hideIfNull?: boolean;
  onChange?: (e: ChangeEvent) => void;
  error?: string | null;
  resetValidationError?: (val: any) => string | undefined;
  extraButtons?: (c: LineBaseController<any, V>) => React.ReactNode;
  ...
  mandatory?: boolean | "warning";
}
```

Each line is a function component + a `…Controller` class instantiated by
`useController` (`LineBase.tsx:35-40`), which is how Signum keeps class-style
inheritance (`EntityBaseController` → `EntityListBaseController` → `EntityStripController`…)
inside hooks-based components.

The catalogue (barrel: `/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Lines.tsx`):
value lines `TextBoxLine`, `PasswordLine`, `ColorLine`, `GuidLine`, `NumberLine`,
`TextAreaLine`, `CheckboxLine`, `EnumLine`, `DateTimeLine`, `DateTimeSplittedLine`,
`TimeLine`, `MultiValueLine`; entity lines `EntityLine`, `EntityCombo`, `EntityDetail`,
`EntityList`, `EntityRepeater`, `EntityAccordion`, `EntityTabRepeater`, `EntityStrip`,
`EntityMultiSelect`, `EntityCheckboxList`, `EntityRadioButtonList`, `EnumCheckboxList`,
`EntityTable`; plus `FormGroup`, `FormControlReadonly`, `RenderEntity`,
`FetchInState`/`FetchAndRemember`.

Note: the historical `ValueLine` is **gone**; the modern replacement is `AutoLine`, which
*chooses* the widget from the `TypeReference` in the metadata:

```tsx
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Lines/AutoLine.tsx:41-90 (abridged)
export function getComponentFactory(tr: TypeReference, pr?: PropertyRoute, options?: {...}): (props: AutoLineProps) => React.ReactElement {
  const customs = customTypeComponent[tr.name]?.map(rule => rule.factory(tr, pr)).notNull().first();
  if (customs != null) return customs
  let tis = tryGetTypeInfos(tr).notNull();
  if (tr.isCollection) {
    if (tr.name == IsByAll) return p => <EntityStrip {...p} />;
    if (tis.length) {
      if (tis.length == 1 && tis.first().kind == "Enum") return p => <EnumCheckboxList {...p} />;
      if (tis.length == 1 && (tis.first().entityKind == "Part" || tis.first().entityKind == "SharedPart" || isTypeModel(tis.first())) && !tr.isLite)
        return p => <EntityTable {...p} />;
      if (tis.every(t => t.entityKind == "Part" || t.entityKind == "SharedPart")) return p => <EntityRepeater {...p} />;
      if (tis.every(t => t.isLowPopulation == true)) return p => <EntityCheckboxList {...p} />;
      return p => <EntityStrip {...p} />;
    }
    if (tr.isEmbedded) return p => <EntityTable {...p} />;
    return p => <MultiValueLine {...p} />;
  } else {
    if (tr.name == IsByAll) return p => <EntityLine {...p} />;
    if (tis.length) {
      if (tis.length == 1 && tis.first().kind == "Enum") return p => <EnumLine {...p} />;
      if (tis.every(t => t.entityKind == "Part" || t.entityKind == "SharedPart") && !tr.isLite) return p => <EntityDetail {...p} />;
      if (tis.every(t => t.isLowPopulation == true)) return p => <EntityCombo {...p} />;
      return p => <EntityLine {...p} />;
    ...
```

That decision table is pure metadata: `entityKind` (`Part`/`SharedPart` ⇒ owned, so inline),
`isLowPopulation` (⇒ a combo is viable), `isLite`, `isCollection`, `isEmbedded`.
`AutoLine.registerComponent(typeName, factory)` lets extensions override per type.

A canonical view (`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Authorization/Templates/Role.tsx:36-45`, abridged):

```tsx
export default function Role(p: { ctx: TypeContext<RoleEntity> }): React.JSX.Element {
  const forceUpdate = useForceUpdate();
  const allRoles = Navigator.useFetchAll(RoleEntity);
  ...
```

— i.e. a view is a **default-exported function component taking `{ ctx }`**, which is what
`ViewPromise` resolves to (§2.6).

### 2.4 `Services.ts` — the HTTP client layer

These are the signatures a CLI must match.

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Services.ts:7-55
export interface AjaxOptions {
  url: string;
  avoidNotifyPendingRequests?: boolean;
  avoidThrowError?: boolean;
  avoidRetry?: boolean;
  avoidGraphExplorer?: boolean;
  avoidAuthToken?: boolean;
  avoidVersionCheck?: boolean;
  avoidContextHeaders?: boolean;

  headers?: { [index: string]: string };
  mode?: string;
  credentials?: RequestCredentials;
  cache?: string;
  signal?: AbortSignal;
}

export function ajaxGet<T>(options: AjaxOptions): Promise<T>;
export function ajaxGetRaw(options: AjaxOptions): Promise<Response>;
export function ajaxPost<T>(options: AjaxOptions, data: any): Promise<T>;
export function ajaxPostRaw(options: AjaxOptions, data: any): Promise<Response>;
export function ajaxPostUpload<T>(options: AjaxOptions, blob: Blob): Promise<T>;
export function wrapRequest(options: AjaxOptions, makeCall: () => Promise<Response>): Promise<Response>;
export function saveFile(response: Response, overrideFileName?: string): Promise<void>;
export function getFileName(response: Response): string;
export function saveFileBlob(blob: Blob, fileName: string): void;
export function b64toBlob(b64Data: string, contentType?: string, sliceSize?: number): Blob;
```

Implementations, verbatim (note the exact headers, credentials and cache defaults):

```ts
// Services.ts:24-49
export function ajaxGet<T>(options: AjaxOptions): Promise<T> {
  return ajaxGetRaw(options)
    .then(res => res.text())
    .then(text => text.length ? JSON.parse(text) : null);
}

export function ajaxGetRaw(options: AjaxOptions): Promise<Response> {
  return wrapRequest(options, () => {
    const headers = Dic.simplify({ 'Accept': 'application/json', ...options.headers } as any);
    return fetch(toAbsoluteUrl(options.url, window.__baseNameAPI), {
      method: "GET",
      headers: headers,
      mode: options.mode,
      credentials: options.credentials || "same-origin",
      cache: options.cache || 'no-store',
      signal: options.signal
    } as RequestInit);
  });
}

// Services.ts:51-86
export function ajaxPost<T>(options: AjaxOptions, data: any): Promise<T> {
  return ajaxPostRaw(options, data)
    .then(res => res.text())
    .then(text => text.length ? JSON.parse(text) : null);
}

export function ajaxPostRaw(options: AjaxOptions, data: any): Promise<Response> {
  if (!options.avoidGraphExplorer) {
    GraphExplorer.propagateAll(data);
  }
  return wrapRequest(options, () => {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...options.headers } as any;
    const isFormData = data instanceof FormData;
    if (isFormData) delete headers['Content-Type'];
    return fetch(toAbsoluteUrl(options.url, window.__baseNameAPI), {
      method: "POST",
      credentials: options.credentials || "same-origin",
      headers: headers,
      mode: options.mode,
      cache: options.cache || 'no-store',
      body: isFormData ? data : JSON.stringify(data),
      signal: options.signal
    } as RequestInit);
  });
}
```

Two things a reimplementation must not miss:

1. **`GraphExplorer.propagateAll(data)` runs before every POST.** It walks the entity graph
   and recomputes each `ModifiableEntity.modified` flag bottom-up. Without it the server
   sees `modified: false` and skips writes (and skips concurrency checks). A CLI that
   constructs payloads by hand must set `modified: true` on every entity/embedded it has
   actually changed, on the whole path from the root.
2. **The filter pipeline** — `wrapRequest` composes decorators inner→outer
   (`Services.ts:121-159`):

```ts
export function wrapRequest(options: AjaxOptions, makeCall: () => Promise<Response>): Promise<Response> {
  if (!options.avoidContextHeaders && addContextHeaders.length > 0) addContextHeaders.forEach(f => f(options));
  if (!options.avoidRetry)        { const call = makeCall; makeCall = () => RetryFilter.retryFilter(call); }
  if (!options.avoidVersionCheck) { const call = makeCall; makeCall = () => VersionFilter.onVersionFilter(call); }
  if (!options.avoidThrowError)   { const call = makeCall; makeCall = () => ThrowErrorFilter.throwError(call, options.url); }
  if (!options.avoidAuthToken && AuthTokenFilter.Options.addAuthToken) { let call = makeCall; makeCall = () => AuthTokenFilter.Options.addAuthToken!(options, call); }
  if (!options.avoidNotifyPendingRequests) { let call = makeCall; makeCall = () => NotifyPendingFilter.onPendingRequest(call); }
  const promise = makeCall();
  ...
}
```

   Order: retry → version → throwError → **authToken** → notifyPending.
   `AuthTokenFilter.Options.addAuthToken` is an empty extension point in the core
   (`Services.ts:167-171`) filled in by `AuthClient` (§1.8) — the framework core has **no
   knowledge of auth**. `VersionFilter` reads `X-App-Version` / `X-App-BuildTime` and fires
   `Options.versionHasChanged()` when the server is redeployed (`Services.ts:186-210`).
   `addContextHeaders` (`Services.ts:115-119`) is how extensions (e.g. isolation/tenant,
   concurrent-user) inject request headers globally — a CLI talking to such an app may need
   to replicate them.

Error translation (`ThrowErrorFilter.throwError`, `Services.ts:227-268`) yields
`ValidationError` (400 without `exceptionType`), `ModelRequestedError` (has `model`), or
`ServiceError`. `AbortableRequest<Q,A>` (`Services.ts:464-514`) is the auto-cancelling
wrapper used by autocompletes and the search grid.

### 2.5 `Finder` / `SearchControl` — DynamicQuery on the client

Three layers:

1. **`FindOptions`** — the authoring/serializable form (partial, human-friendly,
   `token` may be a `QueryTokenString` lambda-built path, `value` may be an entity):

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/FindOptions.ts:40-61
export interface FindOptions {
  queryName: PseudoType | QueryKey;
  groupResults?: boolean;
  includeDefaultFilters?: boolean;
  filterOptions?: (FilterOption | null | undefined)[];
  orderOptions?: (OrderOption | null | undefined)[];
  columnOptionsMode?: ColumnOptionsMode;      // Add | Replace | Remove | InsertStart
  columnOptions?: (ColumnOption | null | undefined)[];
  pagination?: Pagination;
  systemTime?: SystemTime;
}

export interface FindOptionsParsed {
  queryKey: string;
  groupResults: boolean;
  filterOptions: FilterOptionParsed[];        // tokens resolved to QueryToken objects
  orderOptions: OrderOptionParsed[];
  columnOptions: ColumnOptionParsed[];
  pagination: Pagination;
  systemTime?: SystemTime;
}
```

2. **`FindOptionsParsed`** — every token string has been resolved into a full `QueryToken`
   (via `api/query/parseTokens`, cached) and every filter value parsed into the right runtime
   type. `Finder.parseFindOptions` does this; `Finder.parseFilterValues` fills lite models.
3. **`QueryRequest`** — the wire DTO (identical to `QueryRequestTS`, §1.3), produced by
   `Finder.getQueryRequest(fop)`.

The token cache and the two token endpoints
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Finder.tsx:1555-1561`):

```ts
private static API_parseTokens(queryKey: string, tokens: string[]): Promise<QueryToken[]> {
  return ajaxPost({ url: "/api/query/parseTokens" }, { queryKey, tokens });
}

private static API_getSubTokens(queryKey: string, token: string): Promise<QueryTokenWithoutParent[]> {
  return ajaxPost({ url: "/api/query/subTokens" }, { queryKey, token: token });
}
```

Client API surface (`Finder.tsx:2028-2150`), all of it thin wrappers:

```ts
export namespace API {
  export function fetchQueryDescription(queryKey: string): Promise<QueryDescriptionDTO>   // GET  api/query/description/{queryKey}
  export function fetchQueryEntity(queryKey: string): Promise<QueryEntity>                // GET  api/query/queryEntity/{queryKey}
  export function executeQuery(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable>
  export function executeQuerySplitTimeSeries(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable>
  export function queryValue(request: QueryValueRequest, avoidNotifyPendingRequest?: boolean, signal?: AbortSignal): Promise<any>
  export function fetchLites(request: QueryEntitiesRequest): Promise<Lite<Entity>[]>
  export function fetchEntities(request: QueryEntitiesRequest): Promise<Entity[]>
  export function fetchAllLites(request: { types: string }): Promise<Lite<Entity>[]>
  export function findTypeLike(request: { subString: string, count: number }): Promise<Lite<TypeEntity>[]>
  export function findLiteLike(request: AutocompleteRequest, signal?: AbortSignal): Promise<Lite<Entity>[]>
  export interface AutocompleteRequest { types: string; subString: string; count: number; }
}
```

```ts
// Finder.tsx:2107-2118
export function executeQuery(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable> {
  if (request.systemTime?.mode == "TimeSeries" && request.systemTime.splitQueries) {
    return executeQuerySplitTimeSeries(request, signal);
  }
  return ajaxPost<ResultTable>({ url: "/api/query/executeQuery/" + request.queryKey, signal }, request)
    .then(rt => decompress(rt));
}

export function queryValue(request: QueryValueRequest, avoidNotifyPendingRequest: boolean | undefined = undefined, signal?: AbortSignal): Promise<any> {
  return ajaxPost({ url: "/api/query/queryValue/" + request.queryKey, avoidNotifyPendingRequests: avoidNotifyPendingRequest, signal }, request);
}
```

Note `findTypeLike` calls `GET api/query/findTypeLike` — a route that does **not** exist in
the framework's `QueryController`; it must be supplied by an app/extension. Also
`executeQuerySplitTimeSeries` (`Finder.tsx:2039-2104`) is a purely client-side loop issuing
one `AsOf` query per time step and stitching a synthetic `ResultTable` — a CLI would
reimplement or just avoid `TimeSeries` mode.

**URL encoding of find options.** `Finder.Encoder` (`Finder.tsx:2158-2246`) serialises
filters/orders/columns into flat, tilde-delimited query-string params, which is what makes
search URLs shareable and is also the format used by saved user queries:

```ts
// Finder.tsx:2172-2200 (abridged)
query[(prefix ?? "") + "filter" + index + identSuffix] = fo.token + "~" + (fo.operation ?? "EqualTo") + "~" + (ignoreValues ? "" : stringValue(fo.value));
// groups:
query[... "filter" + index + identSuffix] = (fo.token ?? "") + "~" + (fo.groupOperation) + "~" + ...;   // children get identation+1
query[... "order" + i]  = (oo.orderType == "Descending" ? "-" : "") + oo.token;
query[... "column" + i] = co.token + (displayName ? ("~" + displayName) : "");
```

with `stringValue` collapsing entities to `liteKey` and escaping `~` as `#|#`
(`Finder.tsx:2229-2246`). Nesting depth is encoded as a `_<n>` suffix on the parameter name.
The hidden-column marker is `"__"` (`Finder.tsx:2251`).

**`SearchControl`** (`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/SearchControl/SearchControl.tsx:20-80+`)
is a thin shell that resolves the `QueryDescription` then renders `SearchControlLoaded`
(the ~3000-line workhorse). Its props are the framework's biggest configuration surface —
`findOptions`, `formatters`, `entityFormatter`, `extraButtons`, `allowSelection`,
`showHeader`, `showFilters`, `allowChangeColumns`, `create`/`view`, `onSearch`, `onResult`,
`customRequest`, `mobileOptions`, `onDrilldown`, … Supporting components:
`FilterBuilder` (+`PinnedFilterBuilder`), `QueryTokenBuilder` (cascading token combos driven
by `subTokens`), `ColumnEditor`, `PaginationSelector`, `ContextMenu`+`ContextualItems`
(the extension point where operations, quick links, charts inject menu entries),
`SearchValue`/`SearchValueLine` (single aggregate value via `queryValue`),
`SearchModal` (find-in-popup), `SearchPage` (`/find/:queryName` route),
`SystemTimeEditor`.

Presentation rules are registry-based: `Finder.formatRules`, `Finder.entityFormatRules`,
`Finder.registerPropertyFormatter` (see `Signum/React/FinderRules.tsx`), e.g. Operations
registers a `CellOperation` formatter at `Operations.tsx:57-66`.

### 2.6 `Navigator` — entity settings, view registration, routing

`EntitySettings<T>` is the per-type client configuration record
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Navigator.tsx:1113-1181`, abridged):

```ts
export class EntitySettings<T extends ModifiableEntity> {
  typeName: string;
  getViewPromise?: (entity: T) => ViewPromise<T>;
  viewOverrides?: Array<ViewOverride<T>>;
  isCreable?: EntityWhen;          // "Always" | "IsSearch" | "IsLine" | "Never"
  isFindable?: boolean;
  isViewable?: EntityWhen;
  isViewableLite?: (lite: Lite<T & Entity>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isViewableEntityPack?: (entityPack: EntityPack<T>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isReadOnly?: boolean;
  avoidPopup!: boolean;
  modalSize?: BsSize; modalMaxWidth?: boolean; modalFullScreen?: boolean;
  autocomplete?: (fo: FindOptions | undefined, showType: boolean) => AutocompleteConfig<any> | undefined | null;
  autocompleteDelay?: number;
  defaultFindOptions?: FindOptions;
  onView?: (entityOrPack: Lite<Entity & T> | T | EntityPack<T>, viewOptions?: Navigator.ViewOptions<T>) => Promise<T | undefined>;
  onNavigateRoute?: (typeName: string, id: string | number, viewName?: string) => string;
  namedViews?: { [viewName: string]: NamedViewSettings<T> };
  renderLite?: (lite: Lite<T & Entity>, hl: TextHighlighter) => React.ReactElement | string;
  renderEntity?: (entity: T, hl: TextHighlighter) => React.ReactElement | string;
  extraToolbarButtons?: (ctx: ButtonsContext) => (ButtonBarElement | undefined)[];

  constructor(type: Type<T> | string, getViewModule?: (entity: T) => Promise<ViewModule<T>>, options?: EntitySettingsOptions<T>) {
    this.typeName = (type as Type<T>).typeName ?? type as string;
    this.getViewPromise = getViewModule && (entity => new ViewPromise(getViewModule(entity)));
    ...
  }
  overrideView(override: (replacer: ViewReplacer<T>) => void, viewName?: string): void { ... }
}
```

Registration is a flat dictionary keyed by clean type name
(`Navigator.tsx:250-266`): `Navigator.entitySettings`, `addSettings(...)`, `getSettings(type)`.
The canonical app-startup idiom is

```ts
Navigator.addSettings(new EntitySettings(RoleEntity, e => import('./Templates/Role')));
```

— the second argument is a **lazy dynamic import** wrapped in `ViewPromise`
(`Navigator.tsx:1213+`), whose module `default` export is the `{ ctx }` component from §2.3.
`ViewPromise` also supports `.withProps()` and composition, and `overrideView` +
`ViewReplacer` (`Signum/React/Frames/ViewOverrider.tsx`) let an extension surgically insert
or wrap JSX inside *someone else's* view without forking it — this is the framework's main
customisation mechanism.

Routing (`Navigator.tsx:36-51`) contributes exactly two routes and otherwise cooperates with
the host app's react-router 7 route array:

```tsx
export function start(options: { routes: RouteObject[] }): void {
  options.routes.push({ path: "/view/:type/:id", element: <ImportComponent onImport={() => getFramePage()} /> });
  options.routes.push({ path: "/create/:type", element: <ImportComponent onImport={() => getFramePage()} /> });

  AppContext.clearSettingsActions.push(clearEntitySettings);
  AppContext.clearSettingsActions.push(clearWidgets)
  AppContext.clearSettingsActions.push(ButtonBarManager.clearButtonBarRenderer);
  AppContext.clearSettingsActions.push(Constructor.clearCustomConstructors);
  ...
  ErrorModalOptions.getExceptionUrl = exceptionId => navigateRoute(newLite(ExceptionEntity, exceptionId));
  ErrorModalOptions.isExceptionViewable = () => isViewable(ExceptionEntity);
}
```

So the canonical entity URL is `/view/{cleanTypeName}/{id}` (`navigateRoute`,
`Navigator.tsx:149-178`) and search URLs are `/find/{queryKey}?…` (from `Finder`).
Public policy helpers: `isCreable` (`:391`), `isFindable` (`:533`), `isViewable` (`:599`),
`createNavigateOrTab` (`:771`), plus `Navigator.view(...)` (modal or page),
`raiseEntityChanged`/`useEntityChanged` (`:54-59`, `:27-48`) for cross-component invalidation.

Navigator's HTTP surface (`Navigator.tsx:925-1025`) is exactly the entity endpoints of §1.2:

```ts
export namespace API {
  export function fillLiteModels(...lites: (Lite<Entity> | null | undefined)[]): Promise<void>
  export function fillLiteModelsArray(lites: Lite<Entity>[], force?: boolean): Promise<void>   // POST api/liteModels
  export function fetchAll<T extends Entity>(type: Type<T>): Promise<Array<T>>                // GET  api/fetchAll/{typeName}
  export function fetchAndRemember<T extends Entity>(lite: Lite<T>): Promise<T>
  export function fetch<T extends Entity>(lite: Lite<T>): Promise<T>
  export function fetchEntity<T extends Entity>(type: Type<T>, id: any, partitionId?: number): Promise<T>   // GET api/entity/{type}/{id}
  export function exists(type: PseudoType, id: number | string): Promise<boolean>              // GET  api/exists/{type}/{id}
  export function fetchEntityPack<T extends Entity>(lite: Lite<T>): Promise<EntityPack<T>>     // GET  api/entityPack/{type}/{id}
  export function fetchEntityPackEntity<T extends Entity>(entity: T): Promise<EntityPack<T>>   // POST api/entityPackEntity
  export function validateEntity(entity: ModifiableEntity): Promise<void>                      // POST api/validateEntity
  export function getType(typeName: string): Promise<TypeEntity | null>                        // GET  api/reflection/typeEntity/{typeName}
  export function getEnumEntities(type: string | EnumType<string>): Promise<EnumConverter<string>> // GET api/reflection/enumEntities/{typeName}
}
```

with `fillLiteModelsArray` showing the batching pattern a CLI should copy:

```ts
// Navigator.tsx:931-945
export function fillLiteModelsArray(lites: Lite<Entity>[], force?: boolean): Promise<void> {
  if (force) lites.forEach(a => a.ModelType = a.ModelType ?? (isModifiableEntity(a.model) ? a.model.Type : "string"));
  const realLites = force ? lites : lites.filter(a => a.model == undefined && a.entity == undefined);
  if (!realLites.length) return Promise.resolve();
  return ajaxPost<unknown[]>({ url: "/api/liteModels" }, realLites).then(models => {
    realLites.forEach((l, i) => l.model = models[i]);
  });
}
```

### 2.7 `Operations` — buttons ↔ operation API

Client-side operation config is again a flat registry
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Operations.tsx:70-115`):

```ts
export const operationSettings: { [operationKey: string]: OperationSettings } = {};
export function addSettings(...settings: OperationSettings[]): void {
  settings.forEach(s => Dic.addOrThrow(operationSettings, s.operationSymbol, s));
}
export function getSettings(operation: OperationSymbol | string): OperationSettings | undefined {
  const operationKey = (operation as OperationSymbol).key || operation as string;
  return operationSettings[operationKey];
}
export function operationInfos(ti: TypeInfo): OperationInfo[] { return Dic.getValues(ti.operations!); }
```

Integration is by pushing renderers into global hooks at `start()`
(`Operations.tsx:37-68`):

```ts
export function start(): void {
  DeleteErrorModal.register();
  ButtonBarManager.onButtonBarRender.push(EntityOperations.getEntityOperationButtons);
  ContextualItems.onContextualItems.push(ContextualOperations.getOperationsContextualItems);
  AppContext.clearSettingsActions.push(clearOperationSettings);
  QuickLinkClient.registerGlobalQuickLink(entityType => ... OperationLogEntity ...);
  Finder.formatRules.push({ name: "CellOperation", ... });
}
```

Four surfaces per operation, each with its own settings class:
`EntityOperationSettings` (button bar) with nested `contextual`
(`ContextualOperationSettings`, single row in a grid context menu),
`contextualFromMany` (multi-selection), and `cell` (`CellOperationSettings`, a button
rendered inside a result cell). Plus `ConstructorOperationSettings` for `Constructor`-type
operations (`Operations.tsx:411`).

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Operations.tsx:956-993
export class EntityOperationSettings<T extends Entity> extends OperationSettings {
  contextual?: ContextualOperationSettings<T>;
  contextualFromMany?: ContextualOperationSettings<T>;
  cell?: CellOperationSettings<T>;

  text?: (coc: EntityOperationContext<T>) => string;
  isVisible?: (eoc: EntityOperationContext<T>) => boolean;
  isVisibleOnlyType?: (typeName: string) => boolean;
  confirmMessage?: (eoc: EntityOperationContext<T>) => React.ReactElement | string | undefined | null | true;
  overrideCanExecute?: (ctx: EntityOperationContext<T>) => string | undefined | null;
  onClick?: (eoc: EntityOperationContext<T>) => Promise<void>;
  commonOnClick?: (oc: EntityOperationContext<T> | ContextualOperationContext<T> | CellOperationContext<T>) => Promise<void>;
  createButton?: (eoc: EntityOperationContext<T>, group?: EntityOperationGroup) => ButtonBarElement[];
  hideOnCanExecute?: boolean;
  showOnReadOnly?: boolean;
  group?: EntityOperationGroup | null;
  order?: number;
  color?: BsColor;
  icon?: IconProp | React.ReactElement;
  keyboardShortcut?: KeyboardShortcut | null;
  alternatives?: (ctx: EntityOperationContext<T>) => AlternativeOperationSetting<T>[];
  ...
}
```

`EntityOperationContext<T>` is the per-click bundle
(`Operations.tsx:752-871`, abridged):

```ts
export class EntityOperationContext<T extends Entity> {
  static fromEntityPack<T extends Entity>(frame: EntityFrame<any>, pack: EntityPack<T>, operation: ...): EntityOperationContext<T> | undefined {
    const operationKey = (operation as OperationSymbol).key || operation as string;
    const oi = getTypeInfo(pack.entity.Type).operations![operationKey];
    if (oi == null) return undefined;
    const result = new EntityOperationContext<T>(frame, pack.entity, oi);
    result.settings = Operations.getSettings(operationKey) as EntityOperationSettings<T>;
    result.canExecute = (pack?.canExecute && pack.canExecute[operationKey])
      ?? (pack.entity.isNew && !oi.canBeNew ? EngineMessage.TheEntity0IsNew.niceToString(getToString(pack.entity)) : undefined);
    result.complete();
    return result;
  }
  frame: EntityFrame; entity: T; operationInfo: OperationInfo; settings?: EntityOperationSettings<T>;
  canExecute?: string;
  onExecuteSuccess_Default = async (pack: EntityPack<T>): Promise<void> => {
    this.frame.onReload(pack);
    if (pack?.entity.id != null) Navigator.raiseEntityChanged(pack.entity);
    Operations.notifySuccess();
  }
  ...
}
```

Button generation reads **`EntityPack.canExecute` + `TypeInfo.operations`** and nothing else
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Operations/EntityOperations.tsx:20-45`):

```tsx
export function getEntityOperationButtons(ctx: ButtonsContext): Array<ButtonBarElement | undefined> | undefined {
  const ti = tryGetTypeInfo(ctx.pack.entity.Type);
  if (ti == undefined) return undefined;

  const operations = Operations.operationInfos(ti)
    .filter(oi => Operations.isEntityOperation(oi.operationType) && (oi.canBeNew || !ctx.pack.entity.isNew))
    .filter(oi => ctx.pack.entity.isNew || oi.key in ctx.pack.canExecute)
    .map(oi => {
      const eos = Operations.getSettings(oi.key) as EntityOperationSettings<Entity>;
      const eoc = new EntityOperationContext<Entity>(ctx.frame, ctx.pack.entity as Entity, oi);
      eoc.tag = ctx.tag;
      eoc.canExecute = ctx.pack.canExecute[oi.key];
      eoc.settings = eos;
      return eoc;
    })
    .filter(eoc => eoc.isVisibleInButtonBar(ctx));
  ...
```

The **endpoint choice** is driven purely by `OperationInfo.operationType` and
`canBeModified` (`EntityOperations.tsx:133-149`) — this is the mapping a CLI needs:

```ts
export function defaultOnClick<T extends Entity>(eoc: EntityOperationContext<T>, ...args: any[]): Promise<void> {
  if (!eoc.operationInfo.canBeModified) {
    switch (eoc.operationInfo.operationType) {
      case "ConstructorFrom": return defaultConstructFromLite(eoc, ...args);
      case "Execute":         return defaultExecuteLite(eoc, ...args);
      case "Delete":          return defaultDeleteLite(eoc, ...args);
    }
  } else {
    switch (eoc.operationInfo.operationType) {
      case "ConstructorFrom": return defaultConstructFromEntity(eoc, ...args);
      case "Execute":         return defaultExecuteEntity(eoc, ...args);
      case "Delete":          return defaultDeleteEntity(eoc, ...args);
    }
  }
  throw new Error("Unexpected OperationType");
}
```

i.e. **`canBeModified: true` ⇒ POST the full entity (`…Entity` route); otherwise POST just
the `Lite` (`…Lite` route)**. `Save`-style operations are `Execute` + `canBeModified`, hence
`api/operation/executeEntity/RoleOperation.Save` with the whole graph.

The handlers wrap confirm-dialog + success + validation-error routing
(`EntityOperations.tsx:176-186`):

```ts
export function defaultExecuteEntity<T extends Entity>(eoc: EntityOperationContext<T>, ...args: any[]): Promise<void | undefined> {
  return confirmInNecessary(eoc).then(conf => {
    if (!conf) return;
    return Operations.API.executeEntity(eoc.entity, eoc.operationInfo.key, ...args)
      .then(eoc.onExecuteSuccess ?? eoc.onExecuteSuccess_Default)
      .catch(ifError(ValidationError, e => eoc.frame.setError(e.modelState, "entity")));
  });
}
```

And the API namespace (`Operations.tsx:230-320`) — note how `args` becomes a rest parameter
serialised into the `args` array, and how the multi-variants stream through modals:

```ts
export namespace API {
  export function construct<T extends Entity>(type: string | Type<T>, operationKey: string | ConstructSymbol_Simple<T>, ...args: any[]): Promise<EntityPack<T> | undefined> {
    return ajaxPost({ url: "/api/operation/construct/" + getOperationKey(operationKey) }, { args, type: getTypeName(type) });
  }
  export function executeEntity<T extends Entity>(entity: T, operationKey: string | ExecuteSymbol<T>, ...args: any[]): Promise<EntityPack<T>> {
    GraphExplorer.propagateAll(entity, args);
    return ajaxPost({ url: "/api/operation/executeEntity/" + getOperationKey(operationKey) }, { entity: entity, args: args } as EntityOperationRequest);
  }
  export function executeLite<T extends Entity>(lite: Lite<T>, operationKey: string | ExecuteSymbol<T>, ...args: any[]): Promise<EntityPack<T>> {
    GraphExplorer.propagateAll(lite, args);
    return ajaxPost({ url: "/api/operation/executeLite/" + getOperationKey(operationKey) }, { lite: lite, args: args } as LiteOperationRequest);
  }
  export function executeMultiple<T extends Entity>(lites: Lite<T>[], operationKey: string | ExecuteSymbol<T>, options: MultiOperationOptions, ...args: any[]): Promise<ErrorReport> {
    GraphExplorer.propagateAll(lites, args);
    var abortController = options.abortController ?? new AbortController();
    return MultiOperationProgressModal.show(lites, operationKey, options.progressModal, abortController,
      () => ajaxPostRaw({ url: "/api/operation/executeMultiple/" + getOperationKey(operationKey), signal: abortController.signal },
                        { lites: lites, setters: options.setters, args: args } as MultiOperationRequest));
  }
  export interface ErrorReport { errors: { [liteKey: string]: string | null; } }
  export interface OperationResult { entity: Lite<Entity>; error?: string; }
}
```

`MultiOperationProgressModal`/`ProgressModal` are the NDJSON consumers — they read the
response body incrementally and update a progress bar, collecting per-item errors into
`ErrorReport`.

---

## 3. Build / tooling for TypeScript

### 3.1 This repo is not standalone

Verified by `find -maxdepth 3`: there is **no root `package.json`, no `yarn.lock`, no
`.yarnrc.yml`, no `node_modules`, no `vite.config.*`, and no `Directory.Build.props/targets`**
in `/home/patrick.maue/git/sfcl/signum-framework`. The framework is designed to be checked
out as `Framework/` **inside an application repo** (the reference app is Southwind), and that
outer repo owns the yarn workspace root, the lockfile, the Vite config and the shared MSBuild
props.

Evidence — the upgrade script that creates the app-root workspace
(`/home/patrick.maue/git/sfcl/signum-framework/Signum.Upgrade/Upgrades/Upgrade_20230426_ProjectRevolution_MoveFiles.cs:226-240`):

```csharp
uctx.CreateCodeFile("package.json",
    $$"""
    {
      "private": true,
      "resolutions": { "@types/react": "18.0.35" },
      "workspaces": [
        "Framework/Signum",
        "Framework/Extensions/*",
        "{{uctx.ApplicationName}}"
      ]
    }
    """);
```

The same file (`:180-222`) creates the app-root `Directory.Build.props`
(`TypeScriptCompileBlocked`, `AccelerateBuildsInVisualStudio`) and
`Directory.Build.targets`, which removes `ts_out/**` from all item groups, sets
`CopyToOutputDirectory Never` for `package.json`/`tsconfig.json`, and `PreserveNewest` for
`Translations\*.xml` (that last one matters — see §4).

So `/home/patrick.maue/git/sfcl/signum-framework/Signum/package.json` is a **workspace member
manifest with dependencies only and no `scripts`**: react 19.1.2, react-dom 19.1.2,
react-router(+dom) 7.7.0, bootstrap 5.3.7, react-bootstrap 2.10.10, react-widgets-up 6.0.14,
d3 7.9.0 + d3-scale-chromatic, luxon 3.7.1, `@microsoft/signalr` 10.0.0,
FontAwesome 6.7.2 (+ `@fortawesome/react-fontawesome` 3.0.0), react-markdown 10.1.0,
popper.js. The `Extensions/*` packages have `tsconfig.json` but **no** `package.json` in this
clone, so extension-only npm deps come from the app root.

### 3.2 tsconfig graph (53 tsconfigs)

`/home/patrick.maue/git/sfcl/signum-framework/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "isolatedDeclarations": true,
    "isolatedModules": true,
    "sourceMap": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "jsx": "react-jsx",
    "incremental": true,
    "composite": true,
    "emitDeclarationOnly": true,
    "strict": true,
    "noImplicitOverride": true,
    "declarationMap": true,
    "noUncheckedSideEffectImports": false,
    "lib": [ "ESNext", "dom" ],
    "types": [ "node", "google.maps" ]
  }
}
```

`/home/patrick.maue/git/sfcl/signum-framework/Signum/tsconfig.json` is just
`{ "extends": "../tsconfig.base.json", "compilerOptions": { "outDir": "./ts_out" } }`.

Two consequences worth calling out:

- **`emitDeclarationOnly: true`** — `tsc`/`tsgo` only *type-checks* and emits `.d.ts` into
  `ts_out/`. The actual JS transpile is done by **Vite/esbuild** at bundle time. So "building
  TypeScript" here means "type-checking", and a broken type never blocks the JS bundle.
- **`isolatedDeclarations: true`** — every exported symbol needs an explicit type annotation.
  That is why generated code carries redundant-looking annotations
  (`export const Save : Operations.ExecuteSymbol<RoleEntity> = registerSymbol(...)`) and why
  `AGENTS.md:56` insists on explicitly typed props/exports.

Each extension adds the `@framework/*` alias and project references, e.g.
`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Chart/tsconfig.json:1-17`:

```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./ts_out", "paths": { "@framework/*": [ "../../Signum/React/*" ] }, "types": ["node","google.maps"] },
  "references": [ {"path":"../../Signum"}, {"path":"../Signum.UserAssets"}, {"path":"../Signum.Omnibox"}, {"path":"../Signum.UserQueries"}, {"path":"../Signum.Dashboard"} ] }
```

That `references` graph is exactly what `tsc -b` / `tsgo -b` walks.

### 3.3 The actual command chain

TS compilation is **driven from MSBuild**, keyed on the consuming csproj's `TSC_Build`
property (`/home/patrick.maue/git/sfcl/signum-framework/Signum.TSGenerator/Signum.TSGenerator.targets:1-41`):

```xml
<PropertyGroup Condition="'$(CompileTypeScriptDependsOn)' == ''">
  <BuildDependsOn>
    $(BuildDependsOn);
    GenerateSignumTS;
    TSC_BuildAll;
  </BuildDependsOn>
</PropertyGroup>

<Target Name="GenerateSignumTS" Condition="'$(TSGeneratorDisabled)' != 'true'">
  <WriteLinesToFile File="$(BaseIntermediateOutputPath)SignumReferences.txt" Lines="@(ReferencePath)" Overwrite="true" Encoding="Unicode" />
  <Exec command="dotnet &quot;$(MSBuildThisFileDirectory)Signum.TSGenerator.dll&quot; &quot;@(IntermediateAssembly)&quot; ..." ConsoleToMSBuild="true">
...
<Target Name="TSC_BuildAll" ...>
  <Exec Condition="'$(TSC_Build)' == 'true'"  Command="yarn tsc  -b $(MSBuildProjectDirectory)/tsconfig.json --pretty false" IgnoreExitCode="true">
  <Exec Condition="'$(TSC_Build)' == 'tsgo'"  Command="yarn tsgo -b $(MSBuildProjectDirectory)/tsconfig.json --pretty false" IgnoreExitCode="true">
```

Framework/extension projects leave `TSC_Build` off (e.g.
`Extensions/Signum.Authorization/Signum.Authorization.csproj:9` has it commented out); only
the app's `*.Server` csproj sets it. So **one `dotnet build` of the Server project both
regenerates the TS mirrors and type-checks the whole project-reference graph**.

Practical commands (from `/home/patrick.maue/git/sfcl/signum-framework/AGENTS.md:43-52`):

- Package manager is **yarn only, never npm**: `yarn install`, `yarn add`, `yarn <script>`.
- Type-check a slice: `yarn tsgo --build` (or `yarn tsc -b <dir>/tsconfig.json`) for the
  affected tsconfig only.
- Regenerate TS after a C# change: just compile the csproj
  (`dotnet build`, or `dotnet build -p:TSGeneratorDisabled=false` to force it).

### 3.4 `tsgo` — current status

`tsgo` is the CLI of `@typescript/native-preview` (the Go port of tsc). Signum **adopted then
reverted** it:

- `Signum.Upgrade/Upgrades/Upgrade_20251208_TypeScriptNative.cs:21-33` sets
  `<TSC_Build>tsgo</TSC_Build>` and `"@typescript/native-preview": "7.0.0-dev.20251206.1"`.
- `/home/patrick.maue/git/sfcl/signum-framework/Signum.Upgrade/Upgrades/Upgrade_20260710_TypeScript7Stable.cs:9-21`
  reverts to stable TypeScript 7:

```csharp
uctx.ChangeCodeFile("Southwind.Server/Southwind.Server.csproj", file => {
    file.ReplaceLine(a => a.Contains("TSC_Build"), "<TSC_Build>true</TSC_Build>"); });
uctx.ChangeCodeFile("Southwind.Server/package.json", file => {
    file.ReplaceLine(a => a.Contains("@typescript/native-preview"), "\"typescript\": \"7.0.2\","); });
```

Both toolchains remain supported by the targets file and by the VSIX.

### 3.5 `Signum.TSCBuild` is a Visual Studio extension, not a compiler

`/home/patrick.maue/git/sfcl/signum-framework/Signum.TSCBuild/` is a VS 2022+ VSIX
(`source.extension.vsixmanifest:4-6`, InstallationTarget `[17.0, 19.0)`) adding two
Solution-Explorer commands on a csproj (`SignumTSCBuildPackage.vsct:23,32`):
**"Build TypeScript"** and **"Run TSGenerator (C# → TS)"**. It shells out rather than
embedding anything:

```csharp
// /home/patrick.maue/git/sfcl/signum-framework/Signum.TSCBuild/CompileTypeScript.cs:223-233
string toolName = "tsc"; // default
var nodeModules = FindClosestNodeModules(projectDir);
if (nodeModules != null)
{
    if (Directory.Exists(Path.Combine(nodeModules, "typescript")))
        toolName = "tsc";
    else if (Directory.Exists(Path.Combine(nodeModules, "@typescript", "native-preview")))
        toolName = "tsgo";
}
```

then runs `yarn <tool> -b <projectDir>/tsconfig.json -v` (`:290-296`) and parses the output
into the VS Error List. `FindClosestNodeModules` (`:160-174`) walks up until it finds a
`node_modules` whose directory also contains `yarn.lock`/`package-lock.json` — i.e. the
workspace root. `RunTSGenerator.cs:120-126` runs
`dotnet build -p:TSGeneratorDisabled=false`.

### 3.6 `ViteAssets.cs` — the server↔Vite bridge

`/home/patrick.maue/git/sfcl/signum-framework/Signum/API/ViteAssets.cs:7-34`:

```csharp
public class ViteAssets
{
    public string MainJs { get; set; } = string.Empty;
    public HashSet<string> PreloadJs { get; set; } = new();
    public HashSet<string> Css { get; set; } = new();

    public static ViteAssets FromViteServerUrl(string mainJsUrl) => new ViteAssets { MainJs = mainJsUrl };

    public static ViteAssets FromManifestFile(string manifestFilePath, string mainEntry)
    {
        var manifest = JsonDocument.Parse(System.IO.File.ReadAllText(manifestFilePath));
        if (!manifest.RootElement.TryGetProperty(mainEntry, out var entry))
            throw new InvalidOperationException($"Entry {mainEntry} not found in manifest.");
        var assets = new ViteAssets { MainJs = "~/dist/" + entry.GetProperty("file").GetString() };
        assets.CollectAssets(entry, manifest);
        return assets;
    }
```

`CollectAssets` (`:36-64`) recursively harvests `css` → `<link rel=stylesheet>` and
`imports` → `<link rel=modulepreload>`; `GetHtmlString(IUrlHelper)` (`:66-118`) emits the
loader script; `LoadViteReactRefresh(vitePort)` (`:120-132`) injects `@vite/client` +
`@react-refresh` for HMR. Usage in the app's Razor page
(`Signum.Upgrade/Upgrades/Upgrade_20250824_React19Router7.cs:118-130`):

```csharp
int? vitePort = Configuration.GetValue<int?>("ViteDevServerPort");
var viteAssets = vitePort != null
    ? ViteAssets.FromViteServerUrl($"http://localhost:{vitePort}/dist/main.tsx")
    : ViteAssets.FromManifestFile(Path.Combine(hostingEnv.WebRootPath, "dist/.vite/manifest.json"), "main.tsx");
```

So: dev = Vite dev server + HMR; prod = read `dist/.vite/manifest.json` and emit hashed asset
tags. Current stack is Vite 8 with `@vitejs/plugin-react` 6
(`Signum.Upgrade/Upgrades/Upgrade_20260602_Vite8AndOptions.cs:15-20`).

### 3.7 Tooling gotchas

1. `TSC_BuildAll` uses `IgnoreExitCode="true"` (`Signum.TSGenerator.targets:38`) — **TypeScript
   errors never fail `dotnet build`**. CI must run `tsc -b`/`tsgo -b` separately to gate.
2. TSGenerator's up-to-date check covers only the intermediate assembly + `.t4s` timestamps
   (`Signum.TSGenerator/Program.cs:37-48`); touching a *referenced* project's `.t4s` without
   recompiling this project can leave stale `.ts`.
3. A namespace exporting types with no matching `.t4s` gets a **0-byte `.t4s` silently created
   in the source tree** (`Program.cs:100-115`) — a build that writes to your working copy.
4. `Signum.MSBuildTask` is a *different*, earlier IL rewriter (`AfterTargets="AfterCompile"`,
   `Signum.MSBuildTask/Signum.MSBuildTask.targets:2-7`) doing `FieldAutoInitiaizer`,
   `ExpressionFieldGenerator`, `AutoPropertyConverter`. TSGenerator runs later and depends on
   it (symbol fields are initialised by `AutoInitAttribute` handling).

---

## 4. Localization on the client

### 4.1 The pipeline

Generated TS holds **only keys**:
`new MessageKey("SearchMessage","AddColumn")`. The strings arrive with the type metadata.

```
[Description] attrs + Translations/<Assembly>.<culture>.xml
      → DescriptionManager (NiceName/NiceToString, culture fallback chain)
      → ReflectionServer.GetTypeInfoTS()  (cached per culture [+ role])
      → GET api/reflection/types
      → Reflection.setTypes()   (_types dictionary, lower-cased keys)
      → MessageKey.niceToString() / Type.niceName() / EnumType.niceToString(v)
```

### 4.2 Fetch and store

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Reflection.ts:730-742
export function reloadTypes(): Promise<void> {
  return ajaxGet<TypeInfoDictionary>({
    url: "/api/reflection/types?" + QueryString.stringify({
      user: AppContext.currentUser?.id,
      userTicks: AppContext.currentUser?.ticks,
      culture: AppContext.currentCulture
    })
  })
    .then(types => { setTypes(types); onReloadTypes(); });
}
```

The `user`/`userTicks`/`culture` params are pure **cache-busters** — the controller ignores
them; the server keys its own cache on culture (+ role). `setTypes`
(`Reflection.ts:787-842`) denormalises the payload: writes `name` onto each `TypeInfo`/
`MemberInfo`, builds `membersById` for enums, computes `requiresSaveOperation`, **re-keys
`_types` by lower-cased type name** (`:804`), copies operation `niceName`s from the matching
symbol-container members (`:806-826`), builds `_queryNames`, and back-fills symbols
registered before the metadata arrived:

```ts
// Reflection.ts:835-841
missingSymbols = missingSymbols.filter(s => {
  const m = getSymbolMember(s.key);
  if (m) s.id = m.id;
  return s.id == null;
});
```

Culture switching re-fetches everything
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Basics/CultureClient.ts:33-41`):

```ts
export function changeCurrentCulture(newCulture: Lite<CultureInfoEntity>): void {
  const previousCulture = currentCulture;
  API.setCurrentCulture(newCulture)
    .then(() => loadCurrentCulture())
    .then(() => document.documentElement.setAttribute("lang", currentCulture.name ?? "en"))
    .then(() => reloadTypes())
    .then(() => AppContext.resetUI())
    .then(() => onCultureChanged(toLite(previousCulture), newCulture));
}
```

`onReloadTypesActions` lets consumers invalidate derived caches (e.g.
`Signum/React/Finder.tsx:75` pushes `clearQueryDescriptionCache`).

### 4.3 The key classes

```ts
// /home/patrick.maue/git/sfcl/signum-framework/Signum/React/Reflection.ts:1813-1852
function getMemberInfo(ti: TypeInfo, memberName: string) {
  var member = ti.members[memberName];
  if (member == null) throw new Error(`Member ${memberName} not found on type ${ti.name}`);
  return member;
}

export class MessageKey {
  constructor(public type: string, public name: string) { }
  memberInfo(): MemberInfo { var ti = getTypeInfo(this.type); return getMemberInfo(ti, this.name) }
  niceToString(...args: any[]): string {
    const msg = this.memberInfo().niceName;
    return args.length ? msg.formatWith(...args) : msg;
  }
}

export class QueryKey {
  constructor(public type: string, public name: string) { }
  memberInfo(): MemberInfo { return getMemberInfo(getTypeInfo(this.type), this.name) }
  niceName(): string { return this.memberInfo().niceName; }
}
```

- `EnumType<T>.niceToString(value)` → `getMemberInfo(this.typeInfo(), value).niceName`
  (`:1808-1810`).
- `Type<T>.niceName()/nicePluralName()/niceCount(n)/nicePropertyName(a => a.x)`
  (`:1494-1531`) read `TypeInfo.niceName` / `MemberInfo.niceName`, throwing
  `no niceName found for ...` when the server suppressed it.
- `registerSymbol(type, key)` (`:1907-1921`) runs at **module load, before metadata arrives**,
  so it parks unresolved symbols in `missingSymbols`. `symbolNiceName` (`:1878-1892`) resolves
  via `_types[key.before(".")].members[key.after(".")]`.
- Lookups are case-insensitive (`getTypeInfo`, `:515-525`) and the failure messages are
  actionable: `Type not found: X`,
  `No TypeInfo for "X" found. Consider calling ReflectionServer.RegisterLike on the server side.`
- Placeholder substitution is `String.prototype.formatWith`
  (`/home/patrick.maue/git/sfcl/signum-framework/Signum/React/Globals.ts:944`) and gender/plural
  expansion is `forGenderAndNumber` (`:987-1010`), which expands `[..|..]` brackets — that is
  the `_N` / `_G` message-name convention, e.g. `Signum/React/Signum.Entities.t4s:116`:
  `FrameMessage.New0_G.niceToString().forGenderAndNumber(ti.gender).formatWith(ti.niceName)`.

### 4.4 Server side: `DescriptionManager` + `.xml` files

`/home/patrick.maue/git/sfcl/signum-framework/Signum.Utilities/DescriptionManager.cs`:

- `:132` — `TranslationDirectory` = `<dir of Signum.Utilities.dll>/Translations`, i.e. lookup
  is **next to the DLL at runtime**, not in the source tree.
- `:395` — file naming: `"{AssemblyName}.{culture}.xml"` → `Signum.de.xml`,
  `Signum.Authorization.pt.xml`.
- `:303-328` — per-(culture, assembly) cache over `LocalizedAssembly.ImportXml`; a missing file
  for a non-default culture returns `null` so the fallback chain applies.
- `:150-179` — fallback: current culture → parent → the assembly's `[DefaultAssemblyCulture]`.
  Every framework/extension assembly declares `en`
  (`/home/patrick.maue/git/sfcl/signum-framework/Signum/Properties/Attributes.cs:3`).
- **There is no `*.en.xml`.** English comes from code (`:368-378`):

```csharp
internal static string DefaultTypeDescription(Type type)
    => type.GetCustomAttribute<DescriptionAttribute>()?.Description ?? DescriptionManager.CleanTypeName(type).SpacePascal();
internal static string DefaultMemberDescription(MemberInfo m)
    => m.GetCustomAttribute<DescriptionAttribute>()?.Description ?? m.Name.SpacePascalOrUnderscores();
```

  so `AddColumn` becomes "Add column" for free, and `[Description("Add column")]` overrides it.
- `:361-367` — `Invalidate()` raises `Invalidated`, wired to `ReflectionServer.InvalidateCache`
  (`Signum/API/ReflectionServer.cs:69-72`), which bumps `LastModified` so clients pick up new
  strings on the next `reloadTypes()`.

Source location of translations: `<Project>/Translations/<Assembly>.<culture>.xml` — e.g.
`/home/patrick.maue/git/sfcl/signum-framework/Signum/Translations/` (de, es, fa, fr, it, pt),
`/home/patrick.maue/git/sfcl/signum-framework/Signum.Utilities/Translations/`, and ~40
`Extensions/*/Translations/` folders. Format
(`/home/patrick.maue/git/sfcl/signum-framework/Signum/Translations/Signum.de.xml:1-8, 671-683`):

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Translations>
  <Type Name="AggregateFunction">
    <Member Name="Average" Description="Durchschnitt" />
...
  <Type Name="SearchMessage">
    <Member Name="_01of2Results_N" Description="{0} - {1} von {2} Ergebnis[sen]." />
    <Member Name="_0Results_N" Description="{0} Ergebnis[se]." />
    <Member Name="AddColumn" Description="Spalte hinzufügen" />
```

`<Type>` may also carry `Description`, `PluralDescription` and `Gender` attributes. They reach
`bin/Translations/` via the app-root `Directory.Build.targets`
(`<None Update="Translations\*.xml"><CopyToOutputDirectory>PreserveNewest</...>`), and
`TranslationLogic.CopyTranslations()`
(`/home/patrick.maue/git/sfcl/signum-framework/Extensions/Signum.Translation/TranslationLogic.cs:167-204`,
terminal command `"CT"`) copies edited files from `bin/` back next to the right csproj.

Authoring rules the repo itself documents
(`/home/patrick.maue/git/sfcl/signum-framework/Skills/Localization.md`): in C# use
`typeof(X).NiceName()`, `pi.NiceName()`, `LabelState.Active.NiceToString()`; in TS use
`LabelEntity.niceName()`, `LabelEntity.nicePropertyName(a => a.name)`,
`LabelState.niceToString("Active")`, `YourMessage.MyFavoriteFoodIs0.niceToString("Tom Yum Soup")`;
and **define the `Message` enum in C# first, recompile, then use it** — the TS side cannot
introduce a new message.

### 4.5 Implication for a CLI

If your CLI prints labels, `GET api/reflection/types` is your only string source, and the
culture is decided **server-side** by `Accept-Language` / the culture endpoints, not by a
request parameter. `POST api/culture/setCurrentCulture` (anonymous) sets it for the session;
otherwise the server walks the culture parent chain and falls back to `en`
(`ReflectionServer.cs:17-25`). Message placeholders are .NET-style `{0}` with optional
`[singular|plural]` bracket segments you must expand yourself if you want parity.

---

## 5. Consolidated notes for a headless client

**Minimum viable CLI (10 calls).**

1. `POST api/auth/login` → keep `token`; or just send `X-ApiKey`.
2. `GET api/reflection/types` (send `If-Modified-Since`; cache the payload) → discovery of
   every type, property, enum, message and operation you are allowed to touch.
3. `GET api/query/description/{queryKey}` → available columns/tokens for a query.
4. `POST api/query/subTokens` / `parseTokens` → explore/validate deeper tokens.
5. `POST api/query/executeQuery/{queryKey}` → rows (remember `uniqueValues` decompression).
6. `POST api/query/lites/{queryKey}` / `entities/{queryKey}` → bulk fetch without paging.
7. `POST api/query/queryValue/{queryKey}` → aggregates/counts.
8. `GET api/entityPack/{type}/{id}` → entity + `canExecute` (your permission oracle).
9. `POST api/operation/execute{Entity|Lite}/{operationKey}` → writes.
10. `POST api/validateEntity` → dry-run validation before an operation.

**Header checklist per request.**
`Accept: application/json`; `Content-Type: application/json` on POST;
`Authorization: Bearer <token>` **or** `X-ApiKey: <key>`; read back `New_Token`,
`X-App-Version`, `X-App-BuildTime`.

**Serialisation checklist.**
camelCase everywhere; `Type` (clean name) on entities and `EntityType` on Lites — never mix;
special props (`Type`,`id`,`isNew`,`ticks`,`modified`,`toStr`,`temporalId`) **first** in the
object; unknown properties are rejected; `ticks` is a string; `MList` is
`[{rowId, element}]`; enums are strings; `modified: true` on every changed entity along the
path to the root (the browser gets this from `GraphExplorer.propagateAll`).

**Error checklist.**
`400` without `exceptionType` = ModelState `{field: [msg]}` (bad credentials, validation);
`400` `ValidationProblemDetails` from `executeEntity` = entity validation;
`403` + `.AuthenticationException` = re-login; `403` + `UnauthorizedAccessException` =
insufficient rights; response body with `model` = the server wants extra input;
bulk operations return `200` with per-line `error` in an NDJSON stream.

**Things that will bite.**

- `ResultTable` column compression (indices, not values).
- `queryKey` duplicated in route *and* body, asserted equal.
- `args` coercion: numbers → `decimal`, ISO-looking strings → `DateTime`.
- `POST api/auth/logout` does **not** invalidate a bearer token (stateless); only a password
  change or `RefreshAnyTokenPreviousTo` does.
- Endpoint availability depends on which extensions the app started — `Signum.Rest`
  (API keys), `Signum.Excel`, `Signum.Files`, `Signum.UserQueries`, … are all optional.
- Some anonymous endpoints are surprising and security-relevant:
  `POST api/cache/invalidateAll`, `POST api/cache/invalidateTable`
  (`Extensions/Signum.Caching/CacheController.cs:54,63`).
- API keys are stored **unhashed** in `RestApiKeyEntity`, and `?apiKey=` lands in
  `RestLogEntity.QueryString` and web-server access logs — always use the `X-ApiKey` header.
- There is no anti-forgery/CSRF machinery and no default CORS policy; do not assume either.
