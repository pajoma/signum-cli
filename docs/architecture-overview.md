# Signum Framework — Architecture Overview

Orientation for building `signum-cli`. Written against `pajoma/signum-framework` at
`74bd24693d` (master, 2026-07). Deep per-area reports live in [`reference/`](reference/).

Every `file:line` below was read from source. Where a claim is inferred rather than read,
it says so.

---

## 1. What Signum is

A full-stack framework for data-centric business applications: you model entities in C#,
and the framework derives the SQL schema, the LINQ-to-SQL provider, a string-addressable
query language, an operation/command layer, a REST API, and a React admin UI from those
entity classes. The entity classes are the single source of truth — schema, TypeScript
mirrors, UI metadata and API surface are all generated from them.

Scale: 2,958 tracked files — 1,425 `.cs`, 574 `.tsx`, 164 `.ts`, 132 `.md`, 85 `.t4s`.

**Not a package you install.** The framework is consumed as a **git submodule named
`Framework/`** inside an application repo. `Signum.Upgrade/UpgradeContext.cs:34-45` finds
the app root by walking up until it sees a directory called `Framework`. Only three NuGet
packages ship (`Signum.TSGenerator` 10.0.3, `Signum.MSBuildTask` 10.0.0,
`Signum.Analyzer` 3.2.0); nothing is published to npm. Everything else is source.

Expected on-disk layout of a real application:

```
MyApp/                     ← entities (the domain)
MyApp.Server/              ← ASP.NET Core host + Vite
MyApp.Terminal/            ← console host: schema sync, load, codegen
MyApp.Test.{Logic,React,Environment}/
Framework/                 ← this framework, as a submodule
```

**Southwind** is the reference application and project template. It is also the codebase
that all ~223 `Signum.Upgrade` scripts are authored against — upgrades are diffs of
Southwind, replayed onto your app. Creating a new app means duplicating Southwind, not
running a generator.

---

## 2. Project map

| Project | Role |
|---|---|
| `Signum.Utilities` | Dependency-light helpers. `net10.0`, **one** NuGet dep, **zero** project refs. |
| `Signum` | The runtime: entities, ORM, LINQ provider, operations, DynamicQuery, HTTP API. Refs `Microsoft.AspNetCore.App`. |
| `Signum.TSGenerator` | Exe. Mono.Cecil. C# entity assembly → `.ts` mirrors. |
| `Signum.MSBuildTask` | Post-compile **IL weaving** (see §6). |
| `Signum.Test` | xUnit v3, 669 tests. |
| `Signum.Analyzer` | 8 Roslyn diagnostics, satellite solution. |
| `Signum.Upgrade` | Exe. Source-code migration engine (see §8). |
| `Signum.TSCBuild`, `Signum.VSIX` | Visual Studio integration. Windows-only. |
| `Extensions/` | **57** optional vertical modules. |

`Signum.Framework.sln` contains only the first five. The 57 `Extensions/*.csproj` are in
**no solution in this repo** — they join the *application's* solution.

---

## 3. Entity model

Hierarchy (`Signum/Entities/Entity.cs:11`):

```
Modifiable
├── ModifiableEntity
│   ├── EmbeddedEntity      ← value-object, stored inline as columns
│   ├── ModelEntity         ← DTO for UI/operations, never persisted
│   ├── MixinEntity         ← bolt-on fields for an existing entity
│   └── Entity              ← has identity: id, ticks, ToStr, partitionId
├── MList<T>
└── LiteImp<T,M>
```

- **Identity** is `(Type, Id)`. Unsaved entities hash on a per-instance `temporalId`, so
  **a new entity's hash code changes when it is saved** — never key a dictionary on an
  unsaved entity across a save.
- **`Lite<T>`** is an *interface* (for covariance); the only implementation is
  `LiteImp<T,M>`. It carries a *model* (`ModelType`/`Model`/`GetModel<M>()`), not merely a
  display string. On the wire it is `"Album;3"` — `TypeName;id`.
- **`ModifiedState`** ∈ `SelfModified | Clean | Modified | Sealed`. `Sealed` is the
  mechanism that makes symbol singletons immutable.
- **`[EntityKind]`** is *not* UI advice. `RequiresSaveOperation` is enforced by a global
  `Saving` hook that throws, and is re-validated at `SchemaCompleted`.

> **Documentation drift.** The in-repo `.md` files are older than the code:
> `[Serializable]` is gone, `SqlDbTypeAttribute` → `DbTypeAttribute`, `NotNullable` →
> `ForceNotNullable`, and `ModelEntity` derives from `ModifiableEntity` (not
> `EmbeddedEntity`) as the docs claim. **Trust the source over the sibling `.md`.**

---

## 4. ORM and schema

`SchemaBuilder.Include<T>()` produces a `Table` of `Field` subclasses that themselves
implement `IColumn`. `id`, `ticks`, `ToStr`, `partitionId` are `[Ignore]`d on the class and
synthesized as columns by the builder.

Inheritance is polymorphic-FK only — there is no discriminator column:

| Attribute | Storage |
|---|---|
| `[ImplementedBy(typeof(A), typeof(B))]` | one nullable FK column per implementation |
| `[ImplementedByAll]` | `(TypeId, id)` column pair |

Two backends (SQL Server, PostgreSQL) behind a ~15-member capability block on `Connector`.
Postgres emulates temporal tables with a shipped PL/pgSQL trigger and does full-text search
via a computed `tsvector` column.

The **synchronizer** reads the live database *through Signum's own LINQ provider over
`sys.*` / `pg_*` catalog views*, diffs against the derived schema, and asks interactively
about renames using weighted Levenshtein. In non-interactive mode it **throws rather than
guess** — relevant if a CLI ever drives it (pre-seed `Replacements.AutoReplacement`).

---

## 5. LINQ provider

`Database.Query<T>()` returns a `SignumTable<T>` whose expression root is a
`ConstantExpression` of itself. `DbQueryProvider.Translate` runs **18 ordered visitor
stages** to produce SQL text plus a compiled materializer that calls into `IRetriever`
(identity map + batched requests).

Entity projection is **eager**: all columns and transitive joins, cycle-guarded.
`ImplementedBy` equality uses explicit three-valued SQL logic so it survives negation.

---

## 6. The two IL-weaving tricks

`Signum.MSBuildTask` rewrites assemblies **after compile** (Mono.Cecil). Two consequences
that look like magic if you don't know:

1. **`[AutoExpressionField]`** — you write a property/method body as
   `As.Expression(() => …)`; the task generates the static `Expression<…>` field and
   prepends a `.cctor` call. `As.Expression` throws if ever actually invoked at runtime.
   This is how the LINQ provider inlines otherwise-opaque members.
2. **`[AutoInit]`** — symbol static fields are initialized by the weaver.

Also: auto-properties on entities are rewritten to `ModifiableEntity.Get/Set` for change
tracking.

**Trap:** an entity assembly compiled *without* `Signum.MSBuildTask` yields **null symbol
fields** and no change tracking.

---

## 7. Operations — the command layer

There is **no generic save endpoint**. Every mutation is an *operation*.

Five nested kinds under `Graph<T>` (`Execute`, `Delete`, `Construct`, `ConstructFrom`,
`ConstructFromMany`), registered into a
`Polymorphic<Dictionary<OperationSymbol, IOperation>>`. Current member names are
`CanBeNew` / `CanBeModified` (the docs say `AllowNew` / `Lite`).

**Symbol keys** (`Signum/Basics/Symbol.cs:22`) — verified:

```csharp
this.Key = declaringType.Name + "." + fieldName;
```

So the key is `UserOperation.Save` — **the container class name plus field name, not
namespace-qualified**. Symbols are compared **by `Key`, not by `Id`**, and have no `Id`
at all before `Schema.Initialize()`.

---

## 8. Registration and startup

No DI container for domain logic — `AGENTS.md:38` is explicit: prefer static classes.
Each module exposes a static `Start`, made idempotent by a guard:

```csharp
public static void Start(SchemaBuilder sb)
{
    if (sb.AlreadyDefined(MethodInfo.GetCurrentMethod()))
        return;

    sb.Include<RestApiKeyEntity>()
        .WithSave(RestApiKeyOperation.Save)
        .WithDelete(RestApiKeyOperation.Delete)
        .WithQuery(() => e => new { Entity = e, e.Id, e.User, e.ApiKey });
    …
}
```
*(`Extensions/Signum.Rest/RestApiKeyLogic.cs:16-39`, verbatim)*

The application's host calls these `Start` methods in dependency order. That ordered list
*is* the application's composition root.

---

## 9. DynamicQuery — the string-addressable query language

This is the most important subsystem for a CLI, because a query is **pure data**:
a `queryKey`, dotted token strings, filter-operation names, orders, and a pagination
record — already exposed as JSON at `api/query/*`.

Token separator is `.`, but only dots **outside** brackets
(`Signum/DynamicQuery/QueryUtils.cs:370`) — verified:

```csharp
public static readonly Regex SplitRegex = new Regex(@"(?<!\[[^\]]*)\.(?![^\[]*\])");
```

Segment forms: plain (`Name`, `Id`, `Count`, `Year`, `MonthStart`, `Length`), bracketed
(`[Operations]`, `[EntityType]`), parenthesised cast (`(Order)`). Collections expose
`Element`, `Any`/`All`/`NotAny`/`NotAll`, `Count`, `RowId`, `RowOrder`. Aggregates:
`Count`, `Sum`, `Min`, `Max`, `Average`, `CountDistinct`, `CountNull`, `CountNotNull`,
`CountTrue`. `Entity` is just a column of type `Lite<T>` that you keep dotting through.

Operations encode their own dot as `#`: `Entity.[Operations].Order#Save`.

Full grammar, filter operations, pagination and `ResultTable` shape:
[`reference/wire-protocol-and-auth.md`](reference/wire-protocol-and-auth.md).

---

## 10. The HTTP API

~25 **generic** endpoints under `Signum/API/Controllers/`. Generic is the key word: the API
is driven by type *names* and token *strings*, so one client works against any Signum app
without compiled knowledge of its domain. See
[`http-api.md`](http-api.md) for the endpoint table and auth.

Client metadata comes from `GET api/reflection/types` — **anonymous**, with
`Last-Modified`/304 caching. That single document is the CLI's map of the target app.

---

## 11. Extensions — 57 vertical modules

No plugin runtime. Each is a plain `net10.0` class library whose entities are the source of
truth, wired in by an explicit static `Start` call.

Dependency layering (fan-in in brackets):

```
Authorization[36]
└── Files[14] · DiffLog[3] · HtmlEditor[4] · Markdown · CodeMirror · ViewLog
    └── Eval[3] · UserAssets[17]
        └── Omnibox[6] · Scheduler[10] · Templating[4]
            └── Toolbar[4] · Map[3]
                └── Dashboard[5] · Caching[4] · Isolation
                    └── UserQueries[6] · Processes[7]
                        └── Chart[5] · Mailing[10] · SMS · Tree
                            └── Alerts · Excel · Dynamic · Agent
                                └── Workflow · Word · Translation
                                    └── WorkflowDynamic
```

`Authorization` is effectively mandatory. Surprises: `Caching → Map`, and
`Chart`/`UserQueries` sit *above* `Dashboard`.

**`Extensions/Signum.Agent`** deserves note: it is a full agentic layer that also exposes a
real **MCP server** (`AgentLogic.cs:269`). Skills pair an `.md` prompt with a `.cs` tool
class by filename; `[McpServerTool]` methods are reflected into `AIFunction`s using the
Signum JSON converters, so entities and `Lite<T>` round-trip natively. It has lazy tool
disclosure, auto-compaction, streaming, and `[UITool]` human-in-the-loop round-trips. **A
CLI should interoperate with this rather than duplicate it** — see
[`decisions/0002-mcp-vs-http.md`](decisions/0002-mcp-vs-http.md).

Three modules that model migration-ish concerns, often confused:

| | What it is |
|---|---|
| `SchemaSynchronizer` (core) | diff engine: derived schema vs. live DB |
| `Signum.Migrations` | a **ledger only** — version + comment; scripts live in git |
| `Signum.Upgrade` | **source-code** rewriter; state in `SignumUpgrade.txt` |

---

## 12. Client stack

`Signum/React/`: `Services.ts` (`ajaxGet`/`ajaxPost` behind a filter chain —
retry → version → throwError → authToken → notifyPending), `Reflection.ts` (runtime
`TypeInfo` registry hydrated from `api/reflection/types`), `TypeContext` (a
PropertyRoute + Binding lens; `subCtx(a => a.field)` parses lambda *source text*),
`Lines/` (37 widgets; `AutoLine` picks one from metadata), `Finder`/`SearchControl`,
`Navigator` (`EntitySettings` + lazy `ViewPromise`), `Operations`.

Build chain: TSGenerator emits `.ts` from `.t4s` fragments during `dotnet build`;
`tsc -b`/`tsgo -b` only type-checks (`emitDeclarationOnly`); **Vite** does the bundling.
TypeScript errors do **not** fail `dotnet build` (`IgnoreExitCode="true"`).

Localization: generated TS holds only `MessageKey(type, name)`; the strings arrive over
`api/reflection/types` from `DescriptionManager` plus
`Translations/<Assembly>.<culture>.xml`. There is no `*.en.xml` — English comes from
`[Description]` attributes and PascalCase splitting.

---

## 13. Prerequisites and hard rules

**Toolchain:** .NET SDK **10.x**, Node **22**, **yarn** (npm is forbidden), PostgreSQL with
`ltree` + `pgvector` (or SQL Server). Windows-only: `Signum.TSCBuild`, `Signum.VSIX`.
Linux-only development is viable.

**Hard rules** (sources cited in
[`reference/build-test-dev-workflow.md`](reference/build-test-dev-workflow.md)):

- Nullable reference types on, `WarningsAsErrors=nullable`; `NoWarn 8618` for DTOs.
- No EF, no raw SQL — Signum LINQ only.
- Static logic over DI; DI only where ASP.NET forces it.
- Synchronous logic in operations and processes.
- **All user-facing text localized** — never a bare string literal.
- `yarn`, never `npm`.
- Never hand-edit generated `.ts` or `*.Terminal/Migrations/*.sql`.
- Analyzer errors **SF0033/SF0034** (`Lite` ↔ `Entity` `==`) and **SF0004** (Lite/Entity
  casts) are build-breaking.
- LF line endings (`.gitattributes`: `* text=auto eol=lf`).
- Never modify the `Framework/` submodule from inside an application repo.

**No CI exists in this repo** — no `.github/`, no pipelines, no Dockerfile, no
`Directory.Build.props`. NuGet versions are duplicated across ~60 csproj files and synced
by hand-written upgrade scripts.

---

## 14. Security findings (upstream, pre-existing)

Surfaced during analysis. **Not introduced by this project** — recorded so the CLI never
exposes them casually and so they can be raised upstream.

| Severity | Finding |
|---|---|
| High | `Signum.Dynamic` exposes three `api/dynamic/*/test` endpoints that compile **and execute** posted C# with **no permission assert**. |
| High | `Signum.Dynamic` has an unguarded `GET api/dynamic/clients` whose payload is `eval`'d in every browser. |
| High | `Signum.Eval` has no sandbox — a Roslyn reference allow-list that includes `System.IO`, `System.Net`, `System.Reflection`, loaded into the non-collectible default ALC. |
| Medium | REST API keys are 32 random bytes but **stored in plaintext** and cached keyed by the plaintext (`Extensions/Signum.Rest/RestApiKeyLogic.cs:31-34`). |
| Medium | The auth token is not a JWT: Deflate + AES-CBC with the key derived as **MD5 of the app secret, no HMAC** — unauthenticated encryption. |
| Medium | In `Signum.Agent`, prompt injection reaches the destructive `OperationSkill` write path; `ConfirmUISkill` is advisory only. |
| **High** | The **global exception filter persists the entire request body** on any throw. A login that raises server-side therefore persists the submitted **password in cleartext** in the app's log tables. Found during the auth spike. |
| **Medium** | An **unknown API key returns HTTP 500 whose `KeyNotFoundException` message echoes the submitted key**. Combined with the row above, a mistyped key is written to the database and may reach client logs. |
| **Medium** | **Deactivating a user does not revoke their API key** — `ApiKeyAuthenticator` never checks `State`. Keys have no expiry, rotation, revocation, or scoping, and are stored in plaintext. Deleting the `RestApiKeyEntity` is the only revocation path. |
| **Medium** | Provisioning an API key is governed only by ordinary type/operation auth on `RestApiKeyEntity` — there is **no dedicated permission** — so whether users can self-provision full-identity credentials depends entirely on role configuration. |
| Medium | **PKCE is not implemented** in `Signum.Authorization.OpenID` (zero repo-wide hits for `code_verifier`/`code_challenge`), and the redirect URI is forwarded to the IdP with no server-side validation. Public clients therefore rely solely on the IdP for redirect containment. |
| Low | The bearer token has **no MAC** — AES-CBC only — so tampering is detected only incidentally by failed decryption, and a bad token **degrades silently to anonymous** rather than erroring. |
| Low | Auth failures return **403, never 401**, which breaks conventional client retry logic. |

**Operational consequence for the CLI:** never place the API key in a query string.
`RestLogFilter.cs:36-38` persists the entire query string into `RestLogEntity.QueryString`,
as does the global exception logger. Header only.

---

## 15. Bugs noticed in passing

Found while reading, not fixed, not ours to fix:

- `Signum.Upgrade/Program.cs:8` accepts `args` and **ignores them entirely**.
- `ApplicationRenamer.RenameApplication` has **zero callers** and contains a bodyless `if`.
- `newLog` is discarded in four `catch` blocks in the operations layer.
- An always-false `&&` in `TypeOperationsAndConstructors`.
- `AllowOperation` is last-subscriber-wins.
- `CodeGenerator.GetSolutionInfo`'s regex is Windows-only.
- `.Nested` tokens are discoverable via `subTokens` but **unusable** in `executeQuery`
  (`CanNested` is never passed).
