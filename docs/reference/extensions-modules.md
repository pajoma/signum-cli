# Signum Framework — `Extensions/` Deep Architecture Analysis

Repo: `/home/patrick.maue/git/sfcl/signum-framework` @ `74bd246` (2026-07-16, branch `master`-ish)
Scope: `Extensions/` — 57 reusable vertical modules (often quoted as "~58"). Read-only analysis.

---

## 0. Executive orientation

`Extensions/` is not a plugin system in the runtime sense. Each extension is a plain **.NET class library** (`net10.0`) that:

1. Declares C# **entities** (POCOs deriving `Entity` / `EmbeddedEntity` / `Symbol` / `SemiSymbol`).
2. Has a static **`XxxLogic.Start(SchemaBuilder sb, …)`** method that *imperatively registers* those entities into the schema, plus their operations, LINQ expressions, queries and permissions.
3. Ships a co-located **React/TypeScript** half with a **`XxxClient.start(options)`** entry point that registers `EntitySettings`, routes, operation settings, quicklinks, omnibox actions.
4. Gets an **auto-generated `Xxx.ts`** file mirroring the C# entities (via the `Signum.TSGenerator` MSBuild task, triggered by a `.t4s` marker file).

The host application (e.g. Southwind, not in this repo) *chooses* which modules to `Start()`. There is no discovery/DI container — wiring is explicit static calls, and `AGENTS.md:38` states this as policy: *"Prefer static classes for logic over dependency injection. … Avoid dependency injection unless ASP.Net extensibility requires it."*

Idempotency is achieved by a guard at the top of every `Start`:

```csharp
if (sb.AlreadyDefined(MethodInfo.GetCurrentMethod()))
    return;
```

(`Extensions/Signum.Notes/NoteLogic.cs:17-18`; identical in every module. Web-side equivalent: `wsb.AlreadyDefined(MethodBase.GetCurrentMethod())`, `Signum/API/SignumServer.cs:232`.)

---

## 1. The canonical anatomy of a Signum extension

I reverse-engineered three modules of increasing complexity:

| | Simple | Mid | Complex |
|---|---|---|---|
| module | `Signum.Notes` (16 files) | `Signum.Scheduler` (33 files) | `Signum.Authorization` (86 files) / `Signum.Workflow` (97 files) |
| deps | Signum, Signum.Utilities, Signum.Authorization | + Signum.UserAssets | Authorization: only Signum core. Workflow: 10 extension deps |

### 1.1 Standard file/folder layout

Empirically verified across all 57 modules (convention matrix in §1.8). The canonical shape:

```
Extensions/Signum.<Name>/
├── Signum.<Name>.csproj          # required
├── Signum.<Name>.t4s             # required (empty marker file → drives TS codegen)
├── Signum.<Name>.ts              # GENERATED, "Auto-generated. Do NOT modify!"
├── package.json                  # yarn workspace member (usually empty deps)
├── tsconfig.json                 # extends ../../tsconfig.base.json
├── Properties/
│   ├── Attributes.cs             # [assembly: DefaultAssemblyCulture("en")]
│   │                             # [assembly: AssemblySchemaName("notes")]   ← DB schema name!
│   └── GlobalUsings.cs           # ~19 global usings; boilerplate, copy verbatim
├── <Entity>.cs                   # entity + operation symbols + message enum, one file per aggregate
├── <Name>Logic.cs                # SERVER entry point: static Start(SchemaBuilder sb, …)
├── <Name>Server.cs               # optional: WebServerBuilder wiring (SignalR hubs, lifetime hooks)
├── <Name>Controller.cs           # optional: ASP.NET Core controller for module-specific REST
├── <Name>Client.tsx              # CLIENT entry point: export namespace XClient { start(options) }
├── <Name>*.css                   # optional module CSS, imported from the .tsx
├── Changelog.ts                  # optional; ChangeLogDic consumed by ChangeLogClient
├── Templates/                    # React entity views, one .tsx per entity, default-exported
│   └── <Entity>.tsx
└── Translations/
    ├── Signum.<Name>.de.xml      # de / es / fr / it / pt (+ nl in Authorization)
    └── …                          # English lives in C# [Description] attributes, NOT here
```

Bigger modules add **sub-namespace folders**, and each folder that declares C# types in its own namespace gets **its own `.t4s`/`.ts` pair**:

```
Signum.Authorization/
├── Signum.Authorization.t4s / .ts                     (namespace Signum.Authorization)
├── Signum.Authorization.BaseAD.t4s / .ts
├── AuthToken/    Signum.Authorization.AuthToken.t4s / .ts
├── Rules/        Signum.Authorization.Rules.t4s / .ts     (TypeAuthLogic, QueryAuthLogic, …)
├── SessionLog/   Signum.Authorization.SessionLog.t4s / .ts
├── UserTicket/   Signum.Authorization.UserTicket.t4s / .ts
├── BaseAD/       ActiveDirectoryClient.tsx, ActiveDirectoryController.cs
├── Login/        LoginPage.tsx, ChangePasswordPage.tsx, LoginDropdown.tsx, Login.css
└── Templates/    User.tsx, Role.tsx, ProfilePhoto.tsx, UserCircle.tsx, DoublePassword.tsx
```

Workflow uses the same idea with **feature folders**: `Bpmn/` (bpmn-js integration: `CustomRenderer.ts`, `BpmnModelerComponent.tsx`), `Case/` (inbox/case UI), `Workflow/` (designer models), `ActivityMonitor/`, `ImportExport/`.

### 1.2 The `.t4s` mechanism (why the `.ts` file is "free")

`Signum.<Name>.t4s` is a **zero-byte marker file** (verified: `Extensions/Signum.Notes/Signum.Notes.t4s` is empty). The `Signum.TSGenerator` MSBuild task (`PackageReference Include="Signum.TSGenerator" Version="10.0.3"`) scans the compiled assembly, finds each namespace that exports entity types, locates the matching `<Namespace>.t4s` (`Signum.TSGenerator/EntityDeclarationGenerator.cs:738-743`, `Signum.TSGenerator/Program.cs:108-121`), and writes `<Namespace>.ts` next to it. If a namespace has no `.t4s`, the build **errors** telling you to create one; if a `.t4s` exists for a namespace with no exported types, you get `STSG0002: t4s file not needed` (`Signum.TSGenerator/Program.cs:96`).

Result for `Signum.Notes.ts` (generated, `Extensions/Signum.Notes/Signum.Notes.ts:12-46`):

```ts
export const NoteEntity: Type<NoteEntity> = new Type<NoteEntity>("Note");
export interface NoteEntity extends Entities.Entity {
  Type: "Note";
  title: string | null;
  target: Entities.Lite<Entities.Entity>;
  creationDate: string /*DateTime*/;
  text: string;
  createdBy: Entities.Lite<Security.IUserEntity>;
  noteType: NoteTypeSymbol | null;
}
export namespace NoteOperation {
  export const CreateNoteFromEntity : Operations.ConstructSymbol_From<NoteEntity, Entities.Entity>
    = registerSymbol("Operation", "NoteOperation.CreateNoteFromEntity");
  export const Save : Operations.ExecuteSymbol<NoteEntity> = registerSymbol("Operation", "NoteOperation.Save");
}
```

**This is the TS↔C# pairing**: the C# entity is the single source of truth; property names camelCase automatically; `MessageKey`/`QueryKey`/`Type`/`EnumType` wrappers give type-safe localization and query tokens on the client. `AGENTS.md:52`: *"If you change code in C#, you can regenerate the TypeScript definitions just compiling the csproj."*

### 1.3 The entity file — `Extensions/Signum.Notes/Note.cs`

One file holds the **entity + its operation symbols + its message enum**:

```csharp
// Note.cs:6-28
[EntityKind(EntityKind.Main, EntityData.Transactional)]
public class NoteEntity : Entity
{
    [StringLengthValidator(Max = 100)]        public string? Title { get; set; }
    [ImplementedByAll]                       public Lite<Entity> Target { get; set; }
                                             public DateTime CreationDate { get; set; } = Clock.Now;
    [StringLengthValidator(Min = 1, MultiLine = true)] public string Text { get; set; }
                                             public Lite<IUserEntity> CreatedBy { get; set; } = UserHolder.Current.User;
    public override string ToString() => " - ".Combine(Title, Text.FirstNonEmptyLine()).Etc(100);
    public NoteTypeSymbol? NoteType { get; set; }
}

// Note.cs:31-36  — operations are *symbols*, auto-initialized by field name
[AutoInit]
public static class NoteOperation
{
    public static ConstructSymbol<NoteEntity>.From<Entity> CreateNoteFromEntity;
    public static ExecuteSymbol<NoteEntity> Save;
}

// Note.cs:38-52 — user-facing strings; English in [Description], other langs in Translations/*.xml
public enum NoteMessage { [Description("New Note")] NewNote, /* … */ ViewNotes }

// Note.cs:54-64 — extensible enum stored in DB (app can register more note types)
[EntityKind(EntityKind.String, EntityData.Master, IsLowPopulation = true)]
public class NoteTypeSymbol : SemiSymbol { … }
```

Key conventions:
- `[EntityKind(kind, data)]` classifies the entity (Main / String / System / SystemString / Part / Shared / Relational) and drives default UI + save-operation requirements. Enforced by the `Signum.Analyzer` Roslyn analyzer (`PackageReference Signum.Analyzer 3.2.0`).
- Validation is **attribute-based on the entity** (`StringLengthValidator`) so it runs identically on server and (via generated metadata) on the client.
- `Symbol` / `SemiSymbol` = strongly-typed rows synchronized between code and DB (operations, permissions, note types, task types). `SemiSymbol` allows DB-only additions.

### 1.4 Server entry point — a **real** `Start`

`Extensions/Signum.Notes/NoteLogic.cs:15-58` (whole method):

```csharp
public static void Start(SchemaBuilder sb, params Type[] registerExpressionsFor)
{
    if (sb.AlreadyDefined(MethodInfo.GetCurrentMethod()))
        return;

    sb.Include<NoteEntity>()                            // ① register table
        .WithSave(NoteOperation.Save)                   // ② default Save operation
        .WithQuery(() => n => new                       // ③ default query / columns
        {
            Entity = n, n.Id, n.CreatedBy, n.CreationDate, n.Title,
            Text = n.Text.Etc(100), n.Target
        });

    new Graph<NoteEntity>.ConstructFrom<Entity>(NoteOperation.CreateNoteFromEntity)   // ④ custom op
    {
        Construct = (a, _) => new NoteEntity { CreationDate = Clock.Now, Target = a.ToLite() }
    }.Register();

    sb.Include<NoteTypeSymbol>().WithSave(NoteTypeOperation.Save).WithQuery(() => t => new { … });

    SemiSymbolLogic<NoteTypeSymbol>.Start(sb, () => SystemNoteTypes);                 // ⑤ symbol sync

    if (registerExpressionsFor != null)                                               // ⑥ opt-in per-type
    {                                                                                //    "Notes" tab
        var exp = Signum.Utilities.ExpressionTrees.Linq.Expr((Entity ident) => ident.Notes());
        foreach (var type in registerExpressionsFor)
            QueryLogic.Expressions.Register(new ExtensionInfo(type, exp, exp.Body.Type, "Notes",
                () => typeof(NoteEntity).NicePluralName()));
    }
    started = true;
}
```

The six numbered concerns above are *the* recurring vocabulary of a Signum `Start`. Two more appear in bigger modules:

- **Permissions**: `PermissionLogic.RegisterPermissions(SchedulerPermission.ViewSchedulerPanel);` — `Extensions/Signum.Scheduler/SchedulerLogic.cs:57`; or `PermissionLogic.RegisterTypes(typeof(ChatbotPermission));` — `Extensions/Signum.Agent/ChatbotLogic.cs:90`.
- **Cross-module assertions / cascading Start**: `Extensions/Signum.Scheduler/SchedulerLogic.cs:47-61`

```csharp
HolidayCalendarLogic.Start(sb);
AuthLogic.AssertStarted(sb);
OperationLogic.AssertStarted(sb);
…
SimpleTaskLogic.Start(sb);
```

- **Computed LINQ expressions** as `[AutoExpressionField]` extension methods, which become both C# helpers and server-side SQL-translatable query tokens (`Extensions/Signum.Scheduler/SchedulerLogic.cs:9-33`, `Extensions/Signum.Processes/ProcessLogic.cs:14-55`, `Extensions/Signum.Agent/ChatbotLogic.cs:13-36`):

```csharp
[AutoExpressionField]
public static IQueryable<ScheduledTaskLogEntity> Executions(this ITaskEntity t) =>
    As.Expression(() => Database.Query<ScheduledTaskLogEntity>().Where(a => a.Task == t));
```

- **Global caches** with declarative invalidation: `sb.GlobalLazy(… , new InvalidateWith(typeof(RoleEntity)))` (`Extensions/Signum.Authorization/AuthLogic.cs:~130`), also `ResetLazy<>` fields.
- **Schema lifecycle hooks** for code↔DB sync: `sb.Schema.Generating += …; sb.Schema.Synchronizing += …;` (`Extensions/Signum.Agent/SkillCodeLogic.cs:34-35`, implementations at `:74-93` using `Synchronizer.SynchronizeScript`).
- **Type conditions** (row-level security hooks a module offers the app): `NoteLogic.RegisterUserTypeCondition` (`Extensions/Signum.Notes/NoteLogic.cs:84-90`).

Complex modules split `Start` into a **starter facade** — `Extensions/Signum.Workflow/WorkflowLogicStarter.cs:8-14`:

```csharp
public static void Start(SchemaBuilder sb, Func<WorkflowConfigurationEmbedded> getConfiguration)
{
    TypeHelpLogic.Start(sb);        // from Signum.Eval
    WorkflowLogic.Start(sb, getConfiguration);
    CaseActivityLogic.Start(sb);
    WorkflowEventTaskLogic.Start(sb);
}
```

`Signum.Authorization` has **11 separate `Start` methods** (`AuthLogic.Start(sb, systemUserName, anonymousUserName)` at `AuthLogic.cs:77`, plus `TypeAuthLogic`, `QueryAuthLogic`, `PropertyAuthLogic`, `OperationAuthLogic`, `PermissionAuthLogic`, `TypeConditionLogic`, `SessionLogLogic`, `UserTicketLogic`) and a convenience aggregator `AuthLogic.StartAllModules(SchemaBuilder sb, Func<AuthTokenConfigurationEmbedded>? tokenConfig)` at `AuthLogic.cs:504`. **Configuration is passed as `Func<TConfigEmbedded>`**, not injected — a recurring signature (`ChatbotLogic.Start(sb, Func<ChatbotConfigurationEmbedded> config)`, `WorkflowLogicStarter.Start(sb, Func<WorkflowConfigurationEmbedded>)`).

### 1.5 The `*Server.cs` / `*Controller.cs` split

- `*Logic.cs` = pure engine, no ASP.NET dependency (works in console/process hosts).
- `*Server.cs` = ASP.NET wiring against `WebServerBuilder` (`Signum/API/SignumServer.cs:224`). Example, `Extensions/Signum.Scheduler/SchedulerServer.cs:7-19`:

```csharp
public static void Start(WebServerBuilder wsb)
{
    if (wsb.AlreadyDefined(MethodBase.GetCurrentMethod()))
        return;
    wsb.WebApplication.Lifetime.ApplicationStopping.Register(() =>
    {
        if (ScheduleTaskRunner.Running) ScheduleTaskRunner.StopScheduledTasks();
        ScheduleTaskRunner.StopRunningTasks();
    });
}
```
`Signum.Alerts` additionally registers a SignalR hub (`Extensions/Signum.Alerts/AlertsHub.cs`, `AlertsServer.cs`).
- `*Controller.cs` = module-specific REST beyond the generic entity/query API (`Extensions/Signum.Scheduler/SchedulerController.cs`, `Extensions/Signum.Agent/ChatbotController.cs`).

Only 33 of 57 modules have a `*Server.cs`; **all** entity-bearing modules have `*Logic.cs`.

### 1.6 Client entry point — a **real** `*Client.tsx`

`Extensions/Signum.Notes/NotesClient.tsx` (entire file, 33 lines):

```tsx
import { RouteObject } from 'react-router'
import { Navigator, EntitySettings } from '@framework/Navigator'
import { Operations, EntityOperationSettings } from '@framework/Operations'
import { NoteEntity, NoteOperation } from './Signum.Notes'
import { QuickLinkClient, QuickLinkExplore } from '@framework/QuickLinkClient'

export namespace NotesClient {
  export function start(options: { routes: RouteObject[], couldHaveNotes?: (typeName: string) => boolean }): void {
    Navigator.addSettings(new EntitySettings(NoteEntity, e => import('./Templates/Note')));   // ① view

    const couldHaveNotes = options.couldHaveNotes ?? (typeName => true);

    Operations.addSettings(new EntityOperationSettings(NoteOperation.CreateNoteFromEntity, {  // ② op UI
      isVisible: eoc => couldHaveNotes!(eoc.entity.Type),
      icon: "note-sticky", iconColor: "#0e4f8c", color: "info",
      contextual: { isVisible: ctx => couldHaveNotes(ctx.context.lites[0].EntityType) }
    }));

    if (Navigator.isViewable(NoteEntity)) {                                                   // ③ quicklink
      QuickLinkClient.registerGlobalQuickLink(entityType => Promise.resolve([
        new QuickLinkExplore(NoteEntity, ctx => ({ queryName: NoteEntity,
          filterOptions: [{ token: NoteEntity.token(e => e.target), value: ctx.lite }] }),
          { isVisible: couldHaveNotes(entityType), icon: "note-sticky", iconColor: "#337ab7" })
      ]));
    }
  }
}
```

Signature is always `export namespace XxxClient { export function start(options: { routes: RouteObject[], …moduleSpecificHooks }): void }`.

`Extensions/Signum.Scheduler/SchedulerClient.tsx:26-73` shows the fuller repertoire:

```tsx
ChangeLogClient.registerChangeLogModule("Signum.Scheduler", () => import("./Changelog"));      // changelog
options.routes.push({ path: "/scheduler/view",                                                 // route
  element: <ImportComponent onImport={() => import("./SchedulerPanelPage")} /> });
Navigator.addSettings(new EntitySettings(ScheduledTaskEntity, e => import('./Templates/ScheduledTask')));
Constructor.registerConstructor(ScheduleRuleWeekDaysEntity, async props => { … });              // ctor hook
Operations.addSettings(new EntityOperationSettings(ITaskOperation.ExecuteSync, { icon: "bolt", group }));
OmniboxSpecialAction.registerSpecialAction({                                                    // omnibox
  allowed: () => isPermissionAuthorized(SchedulerPermission.ViewSchedulerPanel),
  key: "SchedulerPanel", onClick: () => Promise.resolve("/scheduler/view") });
var es = new EntitySettings(ScheduledTaskLogEntity, undefined);
es.overrideView(vr => vr.insertAfterLine(a => a.exception, ctx => [ <SearchValueLine … /> ]));   // view patch
Navigator.addSettings(es);
HolidayCalendarClient.start(options);                                                            // sub-client
Finder.formatRules.push({ name: "ScheduledTaskLogDates", isApplicable: …, formatter: … });        // cell format
```

Nested clients are the client-side mirror of cascading `Start` (Scheduler→HolidayCalendar, Agent→LanguageModel).

### 1.7 Entity views — `Templates/*.tsx`

One default-exported function component per entity, receiving a `TypeContext<T>` (`Extensions/Signum.Notes/Templates/Note.tsx`):

```tsx
export default function Note(p: { ctx: TypeContext<NoteEntity> }): React.JSX.Element {
  const ec = p.ctx.subCtx({ labelColumns: { sm: 2 } });
  return (<div>
      <EntityLine ctx={ec.subCtx(n => n.target)} readOnly={true} />
      <AutoLine ctx={ec.subCtx(n => n.title)} />
      <EntityCombo ctx={ec.subCtx(n => n.noteType)} remove={true} />
      <TextAreaLine ctx={ec.subCtx(n => n.text)} valueHtmlAttributes={{ style: { height: "180px" } }} />
  </div>);
}
```

`ctx.subCtx(lambda)` is the typed binding — property route, label, validation and read-only state all derive from the C# entity metadata. `Lines` components: `AutoLine`, `EntityLine`, `EntityCombo`, `TextAreaLine`, `EntityTable`, `EntityRepeater`, `EntityStrip`, …

### 1.8 `.csproj` conventions

Every extension `.csproj` is nearly identical. `Extensions/Signum.Notes/Signum.Notes.csproj` in full:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <WarningsAsErrors>nullable</WarningsAsErrors>
    <OutputType>Library</OutputType>
    <NoWarn>8618</NoWarn>            <!-- non-nullable field must contain non-null: entities are DB-filled -->
  </PropertyGroup>
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Signum.Analyzer"   Version="3.2.0" />    <!-- Roslyn conventions analyzer -->
    <PackageReference Include="Signum.MSBuildTask" Version="10.0.0" />  <!-- IL rewriting for entities -->
    <PackageReference Include="Signum.TSGenerator" Version="10.0.3" />  <!-- .t4s → .ts codegen -->
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\Signum.Utilities\Signum.Utilities.csproj" />
    <ProjectReference Include="..\..\Signum\Signum.csproj" />
    <ProjectReference Include="..\Signum.Authorization\Signum.Authorization.csproj" />
  </ItemGroup>
</Project>
```

The three `PackageReference`s are the **mandatory triad**. `Signum.Utilities` + `Signum` are the mandatory core references. Everything else is a `ProjectReference` to sibling extensions (never `PackageReference` — this is a monorepo with `Signum.Framework.sln`).

`tsconfig.json` mirrors the C# dependency graph as **TS project references**:

```jsonc
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./ts_out", "paths": { "@framework/*": [ "../../Signum/React/*" ] } },
  "references": [ { "path": "../../Signum" }, { "path": "../Signum.Authorization" } ] }
```

`package.json` exists mainly so the module is a yarn-workspace member; `dependencies` is usually empty (npm deps like `bpmn-js`, `codemirror`, `luxon` are declared only where actually needed — `Signum.Workflow`, `Signum.CodeMirror`, `Signum.HtmlEditor`, `Signum.Chart`).

Modules that ship non-code content must copy it: `Extensions/Signum.Agent/Signum.Agent.csproj:45-49`

```xml
<ItemGroup>
  <None Update="Skills\*.md"><CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory></None>
</ItemGroup>
```

### 1.9 Localization / strings

Three-tier, per `Skills/Localization.md`:

1. **English source of truth = C# attributes.** `[Description("New Note")]` on enum members; entity/property names derived from identifier names; `AssemblySchemaName`/`DefaultAssemblyCulture("en")` in `Properties/Attributes.cs`.
2. **Other languages = `Translations/Signum.<Name>.<culture>.xml`** in the module. Structure (`Extensions/Signum.Notes/Translations/Signum.Notes.de.xml`):

```xml
<Translations>
  <Type Name="NoteEntity" Description="Notiz" PluralDescription="Notizen" Gender="f">
    <Member Name="CreatedBy"    Description="Erstellt von" />
    <Member Name="CreationDate" Description="Erstellungsdatum" />
  </Type>
  <Type Name="NoteMessage">
    <Member Name="CreateNote" Description="Notiz erstellen" /> …
  </Type>
</Translations>
```
Shipped cultures: `de, es, fr, it, pt` (+ `nl` for Authorization only). `Signum.Translation` is the extension that provides the in-app UI (and LLM-assisted translation) to edit these files.
3. **Client consumption**: generated `MessageKey`s → `NoteMessage.CreateNote.niceToString()`, `NoteEntity.nicePropertyName(a => a.title)`. No separate i18n JSON — the reflection payload carries the translations to the browser.

### 1.10 Convention matrix (all 57 modules)

`Logic`/`Client`/`Server`/`Ctrl` = file counts; `t4s` = number of `.t4s` files (≈ number of TS namespaces); `Trans` = translation XML count.

| Module | t4s | Logic | Client | Server | Ctrl | Trans | Templates | Changelog |
|---|---|---|---|---|---|---|---|---|
| Signum.Agent | 1 | 4 | 3 | 0 | 2 | 0 | y | – |
| Signum.Alerts | 1 | 1 | 1 | 1 | 1 | 5 | y | y |
| Signum.Authorization | 6 | 9 | 3 | 1 | 3 | 6 | y | y |
| Signum.Authorization.AzureAD | 2 | 2 | 1 | 1 | 2 | 4 | – | y |
| Signum.Authorization.OpenID | 1 | 1 | 2 | 1 | 1 | 1 | – | – |
| Signum.Authorization.ResetPassword | 1 | 1 | 1 | 0 | 1 | 5 | – | y |
| Signum.Authorization.WindowsAD | 1 | 1 | 1 | 1 | 1 | 4 | – | y |
| Signum.Caching | 2 | 1 | 1 | 1 | 2 | 5 | – | y |
| Signum.Calendar | 1 | 1 | **0** | 0 | 0 | 4 | – | – |
| Signum.Chart | 3 | 4 | 3 | 1 | 3 | 7 | y | y |
| Signum.CodeMirror | **0** | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.ConcurrentUser | 1 | 1 | 1 | 1 | 1 | 3 | – | y |
| Signum.Dashboard | 1 | 1 | 1 | 1 | 1 | 5 | – | y |
| Signum.DiffLog | 1 | 1 | 1 | 1 | 1 | 5 | y | y |
| Signum.Disconnected | 1 | 1 | 1 | 1 | 0 | 5 | – | – |
| Signum.Dynamic | **11** | 12 | 10 | 1 | 7 | 4 | – | – |
| Signum.Eval | 2 | 2 | 2 | 0 | 2 | 4 | – | y |
| Signum.Excel | 1 | 2 | 1 | 1 | 1 | 5 | y | y |
| Signum.Extensions.Test | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.Files | 1 | 5 | 1 | 1 | 1 | 5 | – | y |
| Signum.Files.AzureBlobs | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.Files.S3 | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.Help | 1 | 2 | 1 | 0 | 1 | 7 | – | y |
| Signum.HtmlEditor | 0 | **0** | 1 | 0 | 0 | 0 | – | – |
| Signum.Isolation | 1 | 1 | 1 | 1 | 1 | 5 | – | – |
| Signum.MachineLearning | 1 | 3 | 1 | 1 | 1 | 3 | y | – |
| Signum.Mailing | 5 | 10 | 4 | 1 | 1 | 5 | y | y |
| Signum.Mailing.ExchangeWS | 2 | 1 | 1 | 1 | 0 | 3 | y | – |
| Signum.Mailing.MicrosoftGraph | 2 | 2 | 2 | 0 | 1 | 3 | y | y |
| Signum.Mailing.Pop3 | 1 | 1 | 1 | 0 | 0 | 0 | – | – |
| Signum.Map | 1 | 1 | 1 | 1 | 1 | 4 | – | y |
| Signum.Markdown | 0 | **0** | 1 | 0 | 0 | 0 | – | – |
| Signum.Migrations | 1 | 1 | **0** | 0 | 0 | 4 | – | – |
| Signum.Notes | 1 | 1 | 1 | 0 | 0 | 5 | y | – |
| Signum.Omnibox | 1 | 1 | 1 | 1 | 1 | 5 | – | y |
| Signum.Playwright | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.Playwright.Workflow | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.Printing | 1 | 1 | 1 | 0 | 1 | 3 | y | – |
| Signum.Processes | 1 | 2 | 1 | 0 | 1 | 5 | y | y |
| Signum.Profiler | 1 | 1 | 1 | 1 | 2 | 5 | – | – |
| Signum.Rest | 1 | 2 | 2 | 1 | 2 | 4 | y | – |
| Signum.Scheduler | 1 | 3 | 2 | 1 | 2 | 5 | y | y |
| Signum.Selenium | 0 | 0 | 0 | 0 | 0 | 0 | – | – |
| Signum.SMS | 1 | 3 | 1 | 1 | 1 | 5 | y | – |
| Signum.Templating | 1 | 1 | **0** | 1 | 1 | 4 | y | – |
| Signum.TimeMachine | 1 | 1 | 1 | 1 | 1 | 4 | – | y |
| Signum.Toolbar | 1 | 1 | 2 | 0 | 1 | 4 | y | y |
| Signum.Tour | 1 | 1 | 1 | 0 | 1 | 1 | y | – |
| Signum.Translation | 2 | 3 | 2 | 1 | 2 | 5 | – | y |
| Signum.Tree | 1 | 2 | 1 | 1 | 1 | 4 | y | – |
| Signum.UserAssets | 3 | 1 | 1 | 1 | 1 | 5 | y | y |
| Signum.UserQueries | 1 | 1 | 2 | 1 | 1 | 5 | y | y |
| Signum.ViewLog | 1 | 1 | 1 | 0 | 0 | 5 | – | y |
| Signum.WhatsNew | 1 | 1 | 1 | 0 | 1 | 3 | y | y |
| Signum.Word | 1 | 3 | 1 | 1 | 1 | 4 | y | y |
| Signum.Workflow | 1 | 5 | 1 | 0 | 1 | 4 | – | – |
| Signum.WorkflowDynamic | 1 | 1 | 1 | 0 | 0 | 0 | – | – |

Notable outliers:
- **No `.csproj`-less modules**: all 57 are real projects.
- **Client-only (no entities, no `.t4s`)**: `Signum.CodeMirror`, `Signum.HtmlEditor`, `Signum.Markdown` — pure React widget wrappers (`HtmlEditor` still ships 4 hand-written `.ts` files).
- **Server-only (no `*Client.tsx`)**: `Signum.Calendar`, `Signum.Migrations`, `Signum.Templating` (its UI lives inside consumer modules Word/Mailing), plus the provider adapters `Signum.Files.AzureBlobs`, `Signum.Files.S3`, `Signum.Mailing.ExchangeWS`.
- **Test-only (no entities, no client, no translations)**: `Signum.Playwright`, `Signum.Playwright.Workflow`, `Signum.Selenium`, `Signum.Extensions.Test`.
- `Signum.Dynamic` is the extreme: 11 TS namespaces, 12 logic files, 10 clients, 7 controllers.

---

### 1.11 ✅ **THE CHECKLIST: "to create a new extension module `Signum.Foo`, you need exactly these files"**

### Tier A — mandatory scaffolding (7 files, all boilerplate)

| # | File | Content |
|---|---|---|
| 1 | `Extensions/Signum.Foo/Signum.Foo.csproj` | Copy `Signum.Notes.csproj` verbatim; adjust `ProjectReference` list. Keep the triad `Signum.Analyzer` / `Signum.MSBuildTask` / `Signum.TSGenerator` + `FrameworkReference Microsoft.AspNetCore.App`. |
| 2 | `Extensions/Signum.Foo/Signum.Foo.t4s` | **Empty file.** One per C# namespace that exports entities (add `Signum.Foo.Bar.t4s` inside `Bar/` if you add a sub-namespace). |
| 3 | `Extensions/Signum.Foo/Signum.Foo.ts` | Do **not** write — generated by the build. Commit the generated output (the repo does). |
| 4 | `Extensions/Signum.Foo/Properties/Attributes.cs` | `[assembly: DefaultAssemblyCulture("en")]` + `[assembly: AssemblySchemaName("foo")]` ← chooses the SQL schema. |
| 5 | `Extensions/Signum.Foo/Properties/GlobalUsings.cs` | Copy verbatim from `Signum.Notes/Properties/GlobalUsings.cs` (19 `global using`s). |
| 6 | `Extensions/Signum.Foo/tsconfig.json` | `extends ../../tsconfig.base.json`, `outDir ./ts_out`, `paths: {"@framework/*": ["../../Signum/React/*"]}`, `references` mirroring the csproj deps. |
| 7 | `Extensions/Signum.Foo/package.json` | `{"name": "signum-foo", "version": "1.0.0", …, "dependencies": {}}` — yarn workspace member. |

Plus: add the project to `Signum.Framework.sln`.

### Tier B — the actual module (4 files minimum)

| # | File | Must contain |
|---|---|---|
| 8 | `Foo.cs` (or `FooEntity.cs`) | `[EntityKind(…)] public class FooEntity : Entity` with validator attributes and `ToString()` override; `[AutoInit] public static class FooOperation { public static ExecuteSymbol<FooEntity> Save; }`; `public enum FooMessage { [Description("…")] … }`. |
| 9 | `FooLogic.cs` | `public static void Start(SchemaBuilder sb, …)` starting with the `sb.AlreadyDefined(MethodInfo.GetCurrentMethod())` guard; then `sb.Include<FooEntity>().WithSave(FooOperation.Save).WithQuery(() => f => new { Entity = f, f.Id, … });`; register custom `Graph<FooEntity>.Execute/ConstructFrom/Delete` operations; `PermissionLogic.RegisterPermissions(...)`; `[AutoExpressionField]` navigations; `sb.GlobalLazy(…, new InvalidateWith(typeof(FooEntity)))` caches; dependency `XLogic.AssertStarted(sb)` / `XLogic.Start(sb)` calls. |
| 10 | `FooClient.tsx` | `export namespace FooClient { export function start(options: { routes: RouteObject[] }): void { … } }` registering `Navigator.addSettings(new EntitySettings(FooEntity, e => import('./Templates/Foo')))`, `Operations.addSettings(new EntityOperationSettings(...))`, `options.routes.push(...)`, quicklinks / omnibox actions. |
| 11 | `Templates/Foo.tsx` | `export default function Foo(p: { ctx: TypeContext<FooEntity> })` using `AutoLine` / `EntityLine` / `EntityTable` with `p.ctx.subCtx(f => f.prop)`. |

### Tier C — add when the feature needs it

| File | When |
|---|---|
| `FooServer.cs` (`Start(WebServerBuilder wsb)`) | app lifetime hooks, SignalR hubs, custom middleware. Guard with `wsb.AlreadyDefined(...)`. |
| `FooController.cs` | REST beyond the generic entity/query API. Route convention `[HttpGet("api/foo/…")]`. |
| `Translations/Signum.Foo.{de,es,fr,it,pt}.xml` | any user-facing string (i.e. always, if you want the module upstream-quality). |
| `Changelog.ts` (+ `ChangeLogClient.registerChangeLogModule("Signum.Foo", …)` in the client) | user-visible release notes. |
| `Foo.css` / `Templates/*.css` | module styling, imported from the `.tsx`. |
| `FooRunner.cs` / `FooTaskRunner.cs` | background worker loop (cf. `ScheduleTaskRunner.cs`, `ProcessRunner.cs`, `WorkflowScriptRunner.cs`). |
| `<Sub>/` folder + `Signum.Foo.<Sub>.t4s`/`.ts` | when the module grows a second namespace. |
| `Foo<X>Mixin.cs` | to graft fields onto *other* modules' entities (cf. `CaseActivityMixin.cs`). |
| `SimpleTask`/`IProcessAlgorithm` registrations | to expose the module's work to Scheduler/Processes. |
| `RegisterUserTypeCondition(SchemaBuilder sb, TypeConditionSymbol tc)` static helper | to let the host app apply row-level security to your entities. |
| `<Foo>ImportExport.cs` + `IUserAssetEntity` | to make your entities XML-portable across environments (via `Signum.UserAssets`). |

### Tier D — host-app wiring (outside the module)

```csharp
// Starter.cs of the application
FooLogic.Start(sb, /* module options */);   // in dependency order
FooServer.Start(wsb);                       // if present
```
```tsx
// MainAdmin.tsx / Main.tsx of the application
FooClient.start({ routes });
```

**Anti-checklist — what you do *not* create:** no DI registration, no `IServiceCollection` extension, no plugin manifest, no separate DTO layer, no hand-written TS entity interfaces, no separate migration file per entity (schema is diffed by `SchemaSynchronizer`), no English resource file.

---

## 2. Catalogue of all 57 extensions, grouped by concern

Tier is grounded in **inbound `ProjectReference` counts** from the other 56 `.csproj` files (§3.1), corrected for modules that host apps consume directly rather than via other extensions.

### 2.1 Auth / security

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Authorization** | The auth core: `UserEntity`/`RoleEntity`, login + `AuthToken` JWT server, `UserTicket` remember-me, `SessionLogEntity`, and the whole rule engine under `Rules/` (Type/Property/Query/Operation/Permission rules with type-conditions, `AuthCache`, `QueryAuditorVisitor`) plus the admin rule-pack UI | **mandatory** | 42 cs / 25 tsx; referenced by 36 of 56 — by far the hub. Also hosts `BaseAD/` shared AD config |
| Signum.Authorization.AzureAD | Entra ID / Azure AD: MSAL login controller, `AzureADConfigurationEmbedded`, Graph user + `ADGroupEntity` sync, auto-create-user authorizer, `CachedProfilePhotoEntity` | common | Needs Files + Scheduler; `Azure.Identity`/`Microsoft.Graph` |
| Signum.Authorization.OpenID | Generic OIDC/OAuth2 authenticator (`OpenIDAuthorizer`, callback page, claims→auto-create user) | niche | Embedded config only, no tables |
| Signum.Authorization.ResetPassword | Forgot/reset-password: `ResetPasswordRequestEntity` + emailed token link + reset page | common | 5 cs; pulls in Mailing |
| Signum.Authorization.WindowsAD | On-prem Windows/LDAP auth via `System.DirectoryServices` | niche | Embedded config only |
| Signum.Isolation | Multi-tenancy: `IsolationEntity` + `IsolationMixin`, per-isolation query filter, isolation strategies per type, isolation-aware file paths, UI dropdown/colour provider | niche | 7 cs; enable only for tenant-partitioned apps |

### 2.2 UI widgets & UX

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Toolbar** | User/role-scoped navigation: `ToolbarEntity`, `ToolbarMenuEntity`, `ToolbarSwitcherEntity`, sidebar/top renderers, pluggable `ToolbarConfig` per content type | **mandatory** | 6 cs / 18 tsx — the app's nav shell |
| **Signum.Omnibox** | Ctrl-K command bar: `OmniboxParser` + pluggable result generators (query, entity, special/admin) + autocomplete UI; other modules register providers | **mandatory** | No DB entities — pure infrastructure; 6 inbound refs |
| Signum.Alerts | `AlertEntity` + `AlertTypeSymbol` notifications, dropdown widget, SignalR `AlertsHub` live push, `SendNotificationEmailTaskEntity` digest emails | common (near-mandatory) | Referenced by Workflow; needs Mailing + Templating + Scheduler |
| Signum.Notes | Per-entity user annotations: `NoteEntity` + `NoteTypeSymbol` as an entity widget | common | 4 cs — the reference "simple module" |
| Signum.ConcurrentUser | Live presence: `ConcurrentUserEntity` + SignalR hub showing who else has the entity open, warns on stale saves | common | Uses Caching for invalidation |
| **Signum.HtmlEditor** | Lexical-based rich-text editor (toolbar buttons, code-block/list extensions, `HtmlEditorLine`, `HtmlViewer`) + server-side `HtmlToPlainText` | **mandatory** | 3 cs / 30 tsx; consumed by Mailing, Dashboard, Help, Excel, WhatsNew |
| Signum.Markdown | Markdown line component + cell format rule; server-side `MarkdownToPlainText` (Markdig) | common | 3 cs / 3 tsx; used by Dashboard/Tour/Excel |
| Signum.CodeMirror | CodeMirror 5 wrappers for C#, SQL, JS, HTML, CSS, XML editing | common | No `*Client.tsx`, no entities; used by Templating and Eval/Dynamic UIs |
| Signum.Help | In-app end-user docs: `TypeHelpEntity`, `PropertyRouteHelpEmbedded`, `QueryHelpEntity`, `NamespaceHelpEntity`, `AppendixHelpEntity`, `HelpImageEntity`; auto-generated descriptions, full-text search, XML export/import, omnibox provider, help widget | common | 17 cs / 13 tsx; `HelpGenerator.cs` |
| Signum.Tour | Guided tours on `driver.js`: `TourEntity`/`TourStepEntity` with CSS selectors + trigger symbols | niche | 7 cs; auto-plays for new users |
| Signum.WhatsNew | In-app changelog: `WhatsNewEntity` (multilingual), read-tracking `WhatsNewLogEntity`, bell dropdown + news pages | niche | Uses Files for images |
| Signum.Tree | Hierarchies via SQL Server `HierarchyId`: `TreeEntity` base, move/copy ops, tree viewer/modal/page, omnibox provider, `UserTreePartEntity` dashboard part | common | 9 cs / 10 tsx |

### 2.3 Integrations / messaging

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Mailing** | Email subsystem: `EmailMessageEntity` state machine, `EmailTemplateEntity`/`EmailMasterTemplateEntity` (multi-language, attachments incl. `FileTokenAttachment`/`ImageAttachment`), `EmailModelEntity` code-defined mails, pluggable `EmailServiceEntity` senders (SMTP built-in), `AsyncEmailSender` queue, `EmailPackageEntity` bulk via Processes, `SendEmailTaskEntity`, inbound reception framework | **mandatory** | 31 cs / 27 tsx; 10 inbound refs; 11 project deps |
| Signum.Mailing.MicrosoftGraph | Graph API sender + `RemoteEmails/` — browse a live mailbox's folders/messages from the entity UI without storing them | common | Requires Authorization.AzureAD |
| Signum.Mailing.Pop3 | POP3 inbound reception via MailKit | niche | 5 cs |
| Signum.Mailing.ExchangeWS | Legacy Exchange Web Services sender | niche | 6 cs |
| Signum.SMS | SMS counterpart of Mailing: `SMSMessageEntity`, `SMSTemplateEntity`, `SMSModelEntity`, GSM charset validation, bulk send as Processes, provider hook | niche | 13 cs; referenced only by Workflow |
| Signum.Rest | Two things: `RestApiKeyEntity` (API-key auth for external callers) and `RestLogEntity` — full request/response logging with **replay-and-diff** for endpoint regression testing | common | Uses DiffLog for replay comparison |
| **Signum.Agent** | LLM/AI layer — see §4 | niche (new) | 32 cs / 17 tsx; 0 inbound refs (newest module) |

### 2.4 File storage

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Files** | File abstraction: `FileEntity`, `FileEmbedded`, `FilePathEntity`, `FilePathEmbedded`, `FileTypeSymbol` + pluggable `FileTypeAlgorithm` (filesystem default), content-type map, `BigStringMixin`, React lines (`FileLine`, `MultiFileLine`, `FileImageLine`, `ImageModal`) | **mandatory** | 19 cs / 12 tsx; 14 inbound refs |
| Signum.Files.AzureBlobs | `AzureBlobStorageFileTypeAlgorithm` backend | common | 3 cs, server-only, no entities |
| Signum.Files.S3 | `S3FileTypeAlgorithm` + `S3Configuration` (AWSSDK.S3) | common | 4 cs, server-only, no entities |

### 2.5 Reporting / BI & data viz

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Chart** | Charting engine: `ChartRequestModel`/`ChartColumnEmbedded`/`ChartParameterEmbedded`, `ChartScriptSymbol` registry, saved `UserChartEntity` (+ dashboard parts, combined-chart part), `ColorPaletteEntity` for stable per-entity colours, ~20 D3 renderers (`D3Scripts/*.tsx`) + Google Maps heat/marker maps | **mandatory** | 43 cs / 64 tsx |
| **Signum.Dashboard** | Composable dashboards: `DashboardEntity` + `PanelPartEmbedded` grid, part types (`TextPartEntity`, `ImagePartEntity`, `SeparatorPartEntity`, `ToolbarMenuPartEntity`, `HealthCheckPartEntity`, `CustomPartEntity`), cross-part filtering, `CachedQueryEntity` snapshotting | **mandatory** | 10 cs / 28 tsx; other modules plug in their own parts |
| **Signum.UserQueries** | End-user saved searches: `UserQueryEntity` (filters/columns/orders, pinned filters, `SystemTimeEmbedded`, `HealthCheckEmbedded`), dashboard parts (`UserQueryPartEntity`, `ValueUserQueryListPartEntity`, `BigValuePartEntity`), toolbar config, omnibox provider | **mandatory** | 7 cs / 16 tsx |
| **Signum.UserAssets** | The serialization/versioning backbone for all user-authored assets: `IUserAssetEntity` XML export/import with preview-and-resolve-conflicts, the reusable query DSL (`QueryTokenEmbedded`/`QueryFilterEmbedded`/`QueryColumnEmbedded`/`QueryOrderEmbedded`), filter-value converters (`CurrentUser`, `CurrentEntity`, smart dates), `TokenMigrations/` to auto-fix stored tokens after refactors | **mandatory** | 21 cs; 17 inbound refs — 2nd most referenced |
| Signum.Excel | OpenXML I/O: plain export of any search result, `ExcelReportEntity` template reports, `ExcelAttachmentEntity` for emails, `ImporterFromExcel`/`ImportExcelModel` bulk import with progress modal | mandatory-ish | `ImporterFromExcel.cs`, `PlainExcelGenerator.cs` |
| Signum.Word | Docx template reporting: `WordTemplateEntity` with its own parser/nodes/renderer, `WordModelEntity`, table binding, image replacement, HTML→Word, converter/transformer symbols, `WordAttachmentEntity` | common | 22 cs; ImageSharp + HtmlAgilityPack |
| **Signum.Templating** | The shared template language behind Email/Word/SMS: `TextTemplateParser` with value providers (`@[Query.Token]`, `@[m:ModelProp]`, globals), foreach/if blocks, `QueryModel`/`MultiEntityModel`, `ModelConverterSymbol`, applicability rules — documented in `Signum.Templating/TemplatingSyntax.md` (226 lines) | **mandatory** | Server-only (no `*Client.tsx`); 4 inbound refs |
| Signum.Printing | Print spooler: `PrintLineEntity` state machine (NewTest→ReadyToPrint→Enqueued→Printed) over generated files, `PrintPackageEntity` batches via Processes/Scheduler, admin panel | niche | 6 cs |
| Signum.MachineLearning | Predictive models over queries: `PredictorEntity` (main + sub-queries + column encodings), `PredictorAlgorithmSymbol` with a TensorFlow.Keras NN, `NeuralNetworkSettingsEntity`, epoch-progress charting, codification tables, predict modal | niche | 22 cs; TensorFlow.Keras |
| Signum.Calendar | A materialised date-dimension table: `CalendarDayEntity` (one row per `DateOnly`) + `CreateDays(start, end)`, to group reports by day without gaps | niche | 4 cs, server-only, 0 inbound refs — smallest module |

### 2.6 Workflow / process / scheduling

| Module | What it does | Tier | Notes |
|---|---|---|---|
| **Signum.Processes** | Long-running background operations: `ProcessEntity` queue + `ProcessRunner`, `ProcessAlgorithmSymbol`, `PackageEntity`/`PackageLineEntity`/`PackageOperationEntity` to apply an operation to N selected entities with per-line error capture, admin panel | **mandatory** | 8 cs; 7 inbound refs |
| **Signum.Scheduler** | Cron-like scheduling: `ScheduledTaskEntity` + `ScheduleRuleMinutely/WeekDays/Months`, `SimpleTaskSymbol`, `ScheduleTaskRunner`, `ScheduledTaskLogEntity` with exception lines, `HolidayCalendarEntity` for business-day rules, admin panel | **mandatory** | 14 cs; 10 inbound refs |
| Signum.Workflow | Full BPMN 2.0 engine: `WorkflowEntity` with pools/lanes/activities/gateways/events/connections, BPMN XML round-trip + graphical designer (bpmn-js), `CaseEntity`/`CaseActivityEntity` runtime with inbox `CaseNotificationEntity`, case tags, jumps/junctions, timers, C#-eval conditions/actions, `WorkflowScriptEntity` with retry strategies, activity monitor | common (heavy) | 34 cs / 50 tsx — biggest module; 10 extension deps |
| Signum.WorkflowDynamic | Glue between Workflow and Dynamic — see §5.3 | niche | 2 cs, no own entities |

### 2.7 Dev-tools / meta / diagnostics

| Module | What it does | Tier | Notes |
|---|---|---|---|
| Signum.Caching | Fully/semi-cached tables (`CachedTable`, `CachedTableMList`, `CachedTableLite`) with cross-server invalidation via SQL Server `SqlDependency`, Postgres LISTEN/NOTIFY, Azure Service Bus or HTTP broadcast; cache stats page + schema colour provider | common (perf foundation) | 17 cs, no entities; 4 inbound refs |
| Signum.DiffLog | Adds `DiffLogMixin` to `OperationLogEntity` storing before/after entity snapshots + a side-by-side diff viewer | mandatory-ish | 6 cs; no own entities (mixin only); enables Rest replay + TimeMachine diffs |
| Signum.ViewLog | `ViewLogEntity` — audit trail of who viewed/opened which entity and for how long | common | 4 cs; used by Dashboard/UserQueries for "most viewed" |
| Signum.TimeMachine | Browses SQL Server temporal-table history: version timeline page, compare any two versions (UI snapshot vs raw data diff), gated by `TimeMachinePermission.ShowTimeMachine` | common | 6 cs, no entities |
| Signum.Profiler | Diagnostics UI over the framework profilers: heavy-profiler entry/list pages, time-tracker page, session-timeout override — permission-gated | common | 8 cs, no entities |
| Signum.Map | Interactive visualisations of the app itself: `SchemaMap` (force-directed table graph with colour providers for cache/auth state) and `OperationMap` (state-machine graph per type), reachable from the omnibox | common | 11 cs / 12 tsx, no entities |
| Signum.Migrations | Versioned migration runners — see §6 | common | 8 cs, server-only |
| Signum.Eval | Runtime C# compilation core — see §5.1 | common | 8 cs; underpins Workflow, Dynamic, Templating |
| Signum.Dynamic | Build-the-app-at-runtime toolkit — see §5.2 | niche (opt-in architecture) | 36 cs / 52 tsx; 10 separate `*Client.tsx` entry points |
| Signum.Translation | Localisation tooling: sync/status/edit UI for code translations per namespace/type, `TranslatedInstanceEntity` for translating actual data rows, `TranslationReplacementEntity` glossary, machine-translation providers (`AzureTranslator`, `DeepLTranslator`) | common | 16 cs / 13 tsx; needs Excel for round-trip |
| Signum.Disconnected | Offline/occasionally-connected support: `DisconnectedMachineEntity`, `DisconnectedExportEntity`/`ImportEntity` with per-table strategies, `ExportManager`/`ImportManager`/`LocalBackupManager` to ship a filtered local DB out and merge changes back | niche (legacy) | 11 cs / 3 tsx |

### 2.8 Testing

| Module | What it does | Tier | Notes |
|---|---|---|---|
| Signum.Playwright | Playwright page-object library for Signum UIs: `SignumPlaywrightTestClass`, `BrowserProxy`, frame/modal proxies, typed proxies for every line control (`EntityLineProxy`, `EntityTableProxy`, `FileLineProxy`…), search-control/filter/column proxies, toolbar proxy | common (E2E teams) | 50 cs, zero tsx, no entities; successor to Selenium |
| Signum.Playwright.Workflow | Adds `CaseFrameModalProxy`/`CaseFramePageProxy` so tests can drive workflow case frames | niche | 3 cs |
| Signum.Selenium | Same page-object concept on Selenium WebDriver (legacy parallel implementation) | niche (legacy) | 48 cs, no entities |
| Signum.Extensions.Test | xUnit tests for the extensions themselves — currently only `AuthTest.cs` (type-condition / `WithConditions` rule merging) | niche | 3 cs; the only pure test project |

### 2.9 Optional vs. near-mandatory — the practical answer

**Near-mandatory (a real Signum LOB app without these is unusual):** `Authorization`, `Files`, `UserAssets`, `Templating`, `Scheduler`, `Processes`, `Omnibox`, `Toolbar`, `Dashboard`, `UserQueries`, `Chart`, `Mailing`, `HtmlEditor`, `Excel`, `DiffLog`, `Alerts`.

**Commonly-used optional:** `Notes`, `Help`, `Tree`, `Word`, `Translation`, `Caching`, `ViewLog`, `TimeMachine`, `Profiler`, `Map`, `Migrations`, `Eval`, `Rest`, `ConcurrentUser`, `Markdown`, `CodeMirror`, `Playwright`, one storage backend (`Files.AzureBlobs`/`Files.S3`), one AD/OIDC provider.

**Niche / opt-in architecture decisions:** `Workflow` (+`WorkflowDynamic`, `Playwright.Workflow`), `Dynamic`, `Isolation` (multi-tenancy), `MachineLearning`, `Disconnected` (legacy), `Selenium` (legacy), `SMS`, `Printing`, `Calendar`, `Tour`, `WhatsNew`, `Agent`.

### 2.10 Structural outliers

- **Server-only (no `*Client.tsx`)** — 10: `Calendar`, `CodeMirror`*, `Files.AzureBlobs`, `Files.S3`, `Extensions.Test`, `Migrations`, `Playwright`, `Playwright.Workflow`, `Selenium`, `Templating`*. (* CodeMirror and Templating *do* ship React components — `CodeMirrorComponent.tsx`, `TemplateControls.tsx` — but no `start()` entry point; the host wires them in manually.)
- **No persisted entities at all** — 15: `Caching`, `CodeMirror`, `Files.AzureBlobs`, `Files.S3`, `Extensions.Test`, `HtmlEditor`, `Map`, `Markdown`, `Omnibox`, `Playwright`, `Playwright.Workflow`, `Profiler`, `Selenium`, `TimeMachine`, `WorkflowDynamic`.
- **Effectively entity-less** (only a mixin / abstract base / embedded config): `DiffLog` (`DiffLogMixin`), `Eval` (abstract `EvalEmbedded<T>`), `Templating` (models + symbols), `Authorization.OpenID`, `Authorization.WindowsAD`.
- **Fully client-only** (C# is just `Properties/*.cs` + a helper): `CodeMirror` (2 cs / 7 tsx), `HtmlEditor` (3 cs / 30 tsx), `Markdown` (3 cs / 3 tsx).

---

## 3. Dependency graph

Derived mechanically from all 57 `.csproj` `ProjectReference` elements (`Signum.Utilities` and `Signum` core are omitted below — **every** module references both).

### 3.1 Fan-in (how many other extensions reference it)

```
36  Signum.Authorization      ← the universal foundation
17  Signum.UserAssets
14  Signum.Files
10  Signum.Mailing
10  Signum.Scheduler
 7  Signum.Processes
 6  Signum.Omnibox
 6  Signum.UserQueries
 5  Signum.Chart
 5  Signum.Dashboard
 4  Signum.Caching, Signum.HtmlEditor, Signum.Templating, Signum.Toolbar
 3  Signum.DiffLog, Signum.Eval, Signum.Map, Signum.Markdown
 2  Signum.Excel, Signum.Migrations, Signum.ViewLog, Signum.Workflow
 1  Signum.Alerts, Signum.Authorization.AzureAD, Signum.CodeMirror, Signum.Dynamic,
    Signum.Isolation, Signum.Playwright, Signum.SMS, Signum.Tree
 0  (28 leaf modules)
```

### 3.2 Layering (longest-path depth over the extension DAG)

```
L0  Signum.Authorization        Signum.Calendar        Signum.Migrations
L1  Signum.Files  Signum.DiffLog  Signum.HtmlEditor  Signum.Markdown  Signum.CodeMirror
    Signum.ViewLog  Signum.Profiler  Signum.Notes  Signum.Authorization.OpenID  Signum.Extensions.Test
L2  Signum.Eval  Signum.UserAssets  Signum.Rest  Signum.TimeMachine  Signum.WhatsNew
    Signum.Files.AzureBlobs  Signum.Files.S3
L3  Signum.Omnibox  Signum.Scheduler  Signum.Templating
L4  Signum.Toolbar  Signum.Map  Signum.Help
L5  Signum.Dashboard  Signum.Caching  Signum.Isolation  Signum.Disconnected
L6  Signum.UserQueries  Signum.Processes  Signum.ConcurrentUser
L7  Signum.Chart  Signum.Mailing  Signum.SMS  Signum.Tree  Signum.Printing  Signum.Tour
    Signum.Playwright  Signum.Selenium
L8  Signum.Alerts  Signum.Excel  Signum.Dynamic  Signum.MachineLearning  Signum.Agent
    Signum.Authorization.{AzureAD,ResetPassword,WindowsAD}  Signum.Mailing.{ExchangeWS,Pop3}
L9  Signum.Workflow  Signum.Word  Signum.Translation  Signum.Mailing.MicrosoftGraph
L10 Signum.WorkflowDynamic  Signum.Playwright.Workflow
```

### 3.3 ASCII dependency tree of the foundation

```
Signum + Signum.Utilities                                  (core, not an extension)
│
├── Signum.Authorization                                   [36 refs — L0, de-facto mandatory]
│   ├── Signum.Files ──────────────┐                       [14 refs]
│   │   ├── Signum.Files.AzureBlobs│                        (storage backend adapters)
│   │   └── Signum.Files.S3        │
│   ├── Signum.DiffLog             │                       [3 refs]
│   │   ├── Signum.Eval ───────────┼──┐                    [3 refs — Roslyn eval]
│   │   ├── Signum.Rest            │  │
│   │   └── Signum.TimeMachine     │  │
│   ├── Signum.HtmlEditor          │  │
│   ├── Signum.Markdown            │  │
│   ├── Signum.CodeMirror ─────────┼──┤
│   ├── Signum.ViewLog             │  │
│   ├── Signum.Profiler            │  │
│   ├── Signum.Notes               │  │
│   └── Signum.Authorization.OpenID│  │
│                                  │  │
├── Signum.Migrations ─────────────┤  │                    [2 refs — L0]
│                                  │  │
└── Signum.Calendar                │  │                    (L0, standalone)
                                   │  │
      Signum.UserAssets  ◄─────────┘  │                    [17 refs — Authorization+Files+Migrations]
        │                             │
        ├── Signum.Omnibox            │                    [6 refs]
        │     └── Signum.Map ──► (+Signum.Caching, Signum.Disconnected, Signum.Isolation)
        ├── Signum.Scheduler          │                    [10 refs]
        │     ├── Signum.Toolbar ──┐  │
        │     └── Signum.Dashboard ─┴──┼──► Signum.UserQueries ──► Signum.Chart ──► Signum.Agent
        │             (+Files, HtmlEditor, Markdown, Omnibox, ViewLog)
        └── Signum.Templating  ◄──────┘                    [4 refs — needs Eval + CodeMirror]
              ├── Signum.Mailing (+Caching, Processes, Scheduler, UserQueries)   [10 refs]
              │     ├── Signum.Mailing.Pop3 / .ExchangeWS / .MicrosoftGraph
              │     ├── Signum.Authorization.ResetPassword
              │     └── Signum.Excel ──► Signum.Translation
              ├── Signum.SMS
              └── Signum.Word (+Chart, Excel, Files, Mailing, UserAssets)

      Signum.Processes  ◄── Authorization + Caching        [7 refs]
        ├── Signum.Printing, Signum.MachineLearning, Signum.Selenium
        └── (consumed by Mailing, SMS, Alerts, Workflow)

      Signum.Workflow  ◄── Alerts+Authorization+Eval+Mailing+Processes+Scheduler+SMS+Toolbar+UserAssets
        ├── Signum.WorkflowDynamic  (+Signum.Dynamic)      [top of the DAG]
        └── Signum.Playwright.Workflow
```

### 3.4 Interpretation

**The true foundation is a 6-module core**, in this order:

1. `Signum.Authorization` — 36/56 other modules depend on it. Everything that has a "created by user", a permission, or a role-filtered query needs it. Effectively **mandatory**.
2. `Signum.Files` — `FileEmbedded`/`FilePathEmbedded` types; needed by UserAssets, Dashboard, Mailing, Excel, Word, Help, Isolation, WhatsNew.
3. `Signum.Migrations` — only 2 direct refs (UserAssets, Dynamic) but it is L0 and underlies schema-versioning.
4. `Signum.UserAssets` — XML import/export + "user asset" abstraction; the substrate for every user-configurable artifact (UserQueries, Charts, Dashboards, Toolbars, Scheduled tasks, Email templates, Workflows).
5. `Signum.Scheduler` + `Signum.Processes` — the two execution engines (cron-like and long-running/batched); 10 + 7 dependents.
6. `Signum.Eval` + `Signum.Templating` — the pair that gives runtime-authorable behaviour and text templates; needed by Mailing, SMS, Word, Workflow, Dynamic.

Cycle-freeness holds, but there are two mildly surprising edges worth noting:
- **`Signum.Caching → Signum.Map`** (`Extensions/Signum.Caching/Signum.Caching.csproj`) — Caching pulls the schema-visualization module just to render the invalidation graph. This is why `Signum.Caching` sits at L5 rather than L1.
- **`Signum.Chart → Signum.Dashboard`, `Signum.UserQueries → Signum.Dashboard`** — Dashboard is *below* Chart/UserQueries, not above; Dashboard defines the panel/part abstraction, and Chart/UserQueries register parts into it.
- **`Signum.Alerts → Signum.Chart`** and **`Signum.Agent → Signum.Chart`** — both need chart-building for their UI (alert dashboards; the chatbot's `ChartSkill`).

---

## 4. `Extensions/Signum.Agent/` — the AI-agent extension (deep dive)

**Summary.** `Signum.Agent` is a first-class, production-shaped **agentic layer over the Signum metadata model**. It gives an application a chatbot whose tools *are* the framework's query system, entity retrieval and operation graph, exposes the same tool surface as an **MCP server**, persists every conversation as entities (with token accounting and per-message cost), and — crucially — makes the *prompts themselves* database-editable business objects. 68 files, ~7000 lines.

### 4.1 Concept model: Agent / Skill / SkillCustomization

Four entities (`Extensions/Signum.Agent/SkillCustomizationEntity.cs`):

```csharp
// :3-11 — a registered C# skill class, synchronized code→DB
[EntityKind(EntityKind.SystemString, EntityData.Master), TicksColumn(false)]
public class SkillCodeEntity : Entity { [UniqueIndex] public string ClassName { get; set; } }

// :13-32 — an "agent" = a named entry point bound to a (possibly customized) skill tree
[EntityKind(EntityKind.Main, EntityData.Master, IsLowPopulation = true, RequiresSaveOperation = false)]
public class AgentSymbol : SemiSymbol
{
    public Lite<SkillCustomizationEntity>? SkillCustomization { get; set; }
}

// :40-46 — three built-in agents
[AutoInit] public static class DefaultAgent
{
    public static AgentSymbol Chatbot;
    public static AgentSymbol QuestionSummarizer;
    public static AgentSymbol ConversationSumarizer;
}

// :48-63 — the DB-editable override of a code skill
[EntityKind(EntityKind.Main, EntityData.Master)]
public class SkillCustomizationEntity : Entity
{
    public SkillCodeEntity SkillCode { get; set; }
    [StringLengthValidator(Min = 1, Max = 500)] public string? ShortDescription { get; set; }
    [StringLengthValidator(MultiLine = true)]   public string? Instructions { get; set; }   // ← the prompt
    [BindParent] public MList<SkillPropertyEmbedded> Properties { get; set; }
    [BindParent] public MList<SubSkillEmbedded>      SubSkills  { get; set; }
}

// :98-104 — a sub-skill edge: either a customized skill or a plain code skill
public class SubSkillEmbedded : EmbeddedEntity
{
    [ImplementedBy(typeof(SkillCustomizationEntity), typeof(SkillCodeEntity))] public Entity Skill { get; set; }
    public SkillActivation Activation { get; set; }   // Eager | Lazy
}
```

So the model is: **`AgentSymbol` → (optional) `SkillCustomizationEntity` tree → falls back to the code-defined `SkillCode` tree.** Resolution is a cached global lazy (`Extensions/Signum.Agent/AgentLogic.cs:93-100`):

```csharp
SkillCodeByAgent = sb.GlobalLazy(() =>
    Database.Query<AgentSymbol>()
        .Select(a => new { Agent = a, SkillCustomization = a.SkillCustomization!.Entity })
        .ToFrozenDictionary(x => x.Agent,
            x => x.SkillCustomization?.ToSkillCode() ?? RegisteredAgents.GetOrThrow(x.Agent).Invoke()),
    new InvalidateWith(typeof(SkillCustomizationEntity), typeof(AgentSymbol)));
```

Sub-skill graphs are validated against cycles on save using the framework's `DirectedGraph.FeedbackEdgeSet()` (`AgentLogic.cs:87-91`, `:128-153`).

### 4.2 The skill format: **`.md` prompt + `.cs` tools, paired by filename**

This is the crux. Each skill is a **pair of files** in `Extensions/Signum.Agent/Skills/`:

```
Skills/Search.md            ← the instructions (system-prompt fragment), 281 lines
Skills/SearchSkill.cs       ← the class: C# methods annotated [McpServerTool] = the tools
```

The pairing is by convention, resolved at runtime from the *output* directory (`Extensions/Signum.Agent/SkillCode.cs:32-40`):

```csharp
public static string SkillsDirectory = Path.Combine(
    Path.GetDirectoryName(typeof(SkillCode).Assembly.Location)!, "Skills");

public string OriginalInstructions
{
    get { return originalInstructions ??= File.ReadAllText(
        Path.Combine(SkillsDirectory, this.GetType().Name.Before("Skill") + ".md")); }
    set { originalInstructions = value; }
}
```

i.e. `SearchSkill` → `Skills/Search.md`. The `.md` files are copied to output by the csproj (`Signum.Agent.csproj:45-49`).

**11 built-in skills** (`Skills/`):

| Skill | Tools (`[McpServerTool]` methods) | Purpose |
|---|---|---|
| `IntroductionSkill` | `Describe(skillName)`, `ListSkillNames()` | root skill; progressive tool disclosure |
| `SearchSkill` (588 lines) | `ListQueryNames`, `QueryDescription`, `SubTokens`, `GetFindOptionsUrl`, `GetResultTable`, … | full query-system access |
| `RetrieveSkill` | `retrieveEntity` | fetch an entity + its `canExecute` dictionary |
| `OperationSkill` (162 lines) | `GetTypeInfo`, `Operation_Construct`, `Operation_ConstructFrom`, `Operation_Execute`, `Operation_Delete` (all `Destructive = true`) | **write path** — invoke any registered operation |
| `AutocompleteSkill` | `autoCompleteLite` | resolve names → `Lite<T>` |
| `ChartSkill` (213 lines) | `getChartScripts`, chart-URL building | data-viz answers |
| `CurrentServerContextSkill` | `GetCurrentServerContext` | date/user/role/culture/app URL |
| `EntityUrlSkill` | entity deep-links | clickable answers |
| `GetUIContextSkill` | `getUIContext` — **UI tool** | live browser state (URL, locale, current `EntityPack`/`FindOptions`) |
| `ConfirmUISkill` | `Confirm(title, message, buttons)` — **UI tool** | human-in-the-loop approval |
| `ConversationSumarizerSkill`, `QuestionSumarizerSkill` | (no tools) | pure prompts for compaction / auto-titling |

**Instruction templating.** A skill can declare `Replacements` — placeholder → live server data. `IntroductionSkill` (`Skills/IntroductionSkill.cs:15-18`) substitutes `<CurrentApplication>`; `SearchSkill` (`Skills/SearchSkill.cs:26-48`) substitutes `<LIST_ROOT_QUERIES>` with the **authorization-filtered** list of query names, grouped by namespace, with a token budget trick — only the queries the app opted into (`InlineQueryName`) are listed individually, the rest are summarized as `* Module X: 47 queries`:

```csharp
"<LIST_ROOT_QUERIES>",
obj => QueryLogic.Queries.GetAllowedQueryNames(fullScreen: true)
    .GroupBy(a => a is Type t ? t.Namespace : …)
    .ToString(gr => { … return "* Module " + gr.Key + $": {gr.Count()} queries"; }, "\n")
```

**Prompt assembly** flattens the tree, inlining eager sub-skills and stubbing lazy ones (`SkillCode.cs:70-93`):

```csharp
public string GetInstruction(object? context)
{
    var text = OriginalInstructions;
    if (!Replacements.IsNullOrEmpty())
        text = text.Replace(Replacements.SelectDictionary(k => k, v => v(context)));
    if (SubSkills.Any())
    {
        var sb = new StringBuilder(text);
        foreach (var (sub, activation) in SubSkills)
        {
            sb.AppendLineLF("# Skill " + sub.Name);
            sb.AppendLineLF("**Summary**: " + sub.ShortDescription);
            if (activation == SkillActivation.Eager)
                sb.AppendLineLF(sub.GetInstruction(null));
            else
                sb.AppendLineLF("Use the tool 'describe' to get more information about this skill and discover additional tools.");
        }
        return sb.ToString();
    }
    return text;
}
```

That is **progressive disclosure / lazy tool loading**: `SkillActivation.Lazy` sub-skills contribute only a one-line summary until the model calls `Describe(skillName)`, which then *activates* them and (over MCP) fires a `ToolListChangedNotification`.

**Skill instructions are `.md` prose written for an LLM, and they are good.** `Skills/Search.md` teaches the Signum query DSL: how to pick a root query, the `filterType`→sub-token map (`DateTime` → `Year/Month/MonthStart/…`; collections → `Count/Element/Any/All/SeparatedByComma`), the TS `FindOptions` schema, warnings about cartesian multiplication with independent `Element` joins, and the guidance to prefer entity tokens over `.Name` tokens (`Skills/Autocomplete.md:3`). `Skills/ConfirmUI.md:12`: *"Always use this tool before executing destructive operations (delete, override, send, etc.)"*.

### 4.3 Tools = reflected C# methods, via `Microsoft.Extensions.AI` + MCP

Tool discovery is pure reflection over `[McpServerTool]`-annotated methods, converted to `AIFunction`s (`Extensions/Signum.Agent/SkillCode.cs:162-184`):

```csharp
internal IEnumerable<AITool> GetTools()
{
    return (cachedTools ??= this.GetType()
        .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
        .Where(m => m.GetCustomAttribute<McpServerToolAttribute>() != null)
        .Select(m =>
        {
            Type delType = Expression.GetDelegateType(
                m.GetParameters().Select(a => a.ParameterType).And(m.ReturnType).ToArray());
            Delegate del = m.IsStatic ? Delegate.CreateDelegate(delType, m)
                                      : Delegate.CreateDelegate(delType, this, m);
            string? description = m.GetCustomAttribute<DescriptionAttribute>()?.Description;
            return (AITool)AIFunctionFactory.Create(del, m.Name, description, GetJsonSerializerOptions());
        }).ToList());
}

internal IEnumerable<McpServerTool> GetMcpServerTools() =>
    GetTools().Select(t => McpServerTool.Create((AIFunction)t, new McpServerToolCreateOptions
        { SerializerOptions = GetJsonSerializerOptions() }));
```

JSON serialization uses `.AddSignumJsonConverters()` (`SkillCode.cs:186-191`), so **entities and `Lite<T>` round-trip natively** in tool arguments and results — a tool can literally take a `JsonObject` entity and call an operation on it (`Skills/OperationSkill.cs:79-90`).

Example tool with the framework doing the authorization (`Skills/OperationSkill.cs:33-59, 61-76`):

```csharp
private static Type GetTypeWithHint(string cleanTypeName)
{
    …
    catch (Exception e)   // fuzzy-match hint via Smith-Waterman on allowed types only
    {
        var similar = from kvp in TypeLogic.NameToType
                      where s.IsAllowed(kvp.Value, inUserInterface: true) == null
                      let dist = new StringDistance().SmithWatermanScore(kvp.Key, cleanTypeName)
                      where dist > cleanTypeName.Length orderby dist descending select kvp.Key;
        if (similar.Any()) e.Data["Hint"] = $"Similar type names are {similar}";
        throw;
    }
    s.AssertAllowed(type, inUserInterface: true);     // ← authorization gate
    return type;
}

[McpServerTool(Destructive = true), Description("Construct an entity using an operation")]
public static EntityPackTS Operation_Construct(string typeName, string operationKey, CancellationToken token)
{
    var type = GetTypeWithHint(typeName);
    var operation = SymbolLogic<OperationSymbol>.ToSymbol(operationKey);
    var newEntity = OperationLogic.ServiceConstruct(type, operation);
    var canExecutes = OperationLogic.ServiceCanExecute(newEntity);
    return new EntityPackTS(newEntity, canExecutes.ToDictionary(a => a.Key.Key, a => a.Value));
}
```

Note the "hint" pattern: on failure the tool enriches `Exception.Data["Hint"]` with fuzzy-matched alternatives so the model can self-correct (also `SearchSkill.cs:98-108`).

### 4.4 MCP server exposure

`Extensions/Signum.Agent/AgentLogic.cs:267-345` — `WithSignumSkill(this IMcpServerBuilder builder, AgentSymbol useCase)` turns an agent into a **real MCP server over HTTP** (`ModelContextProtocol` + `ModelContextProtocol.AspNetCore` 1.1.0):

- `WithHttpTransport(... RunSessionHandler ...)` seeds a per-session activated-skill set from the eager tree.
- `WithListToolsHandler` returns only the tools of *currently activated* skills.
- `WithCallToolHandler` looks up the tool, runs it under `AgentLogic.IsMCP.Override(true)` (an `AsyncThreadVariable<bool>`, `AgentLogic.cs:16`, so tools can behave differently for MCP vs. in-app chat), and — when the call was `IntroductionSkill.Describe` — expands the activated set and pushes `NotificationMethods.ToolListChangedNotification`:

```csharp
if (toolName == nameof(IntroductionSkill.Describe)
    && ctx.Params.Arguments?.TryGetValue("skillName", out var je) == true
    && je.GetString() is { } skillName
    && ctx.Server.SessionId is { } sessionId)
{
    var newSkill = root.FindSkill(skillName);
    if (newSkill != null && sessionActivated.TryGetValue(sessionId, out var skills))
    {
        foreach (var s in newSkill.GetEagerSkillsRecursive()) skills.Add(s.Name);
        await ctx.Server.SendNotificationAsync(NotificationMethods.ToolListChangedNotification, ct);
    }
}
```

So the *same* skill tree serves (a) the in-app chatbot and (b) external MCP clients (Claude Desktop, Copilot, …). `MCPExceptionLoggerProvider.cs` funnels MCP-side exceptions into Signum's `ExceptionEntity` log.

Note: `WithSignumSkill` has **no call site in this repo** — the host application opts in.

### 4.5 The agent loop

`Extensions/Signum.Agent/ChatbotLogic.cs:135-294` — `RunAgentLoopAsync(ConversationHistory history, IAgentOutput output, CancellationToken ct)`. Features:

1. **Automatic context compaction.** When the last message's `InputTokens > MaxTokens * 0.8`, it finds the cut point at 50% of `MaxTokens`, summarizes everything before it with the `ConversationSumarizer` agent, and replaces history with `[systemMsg, summary, ...toKeep]` (`ChatbotLogic.cs:141-166`). The summary is persisted as a `ChatMessageEntity` with `Role = System`.
2. **Streaming with mode switching.** `client.GetStreamingResponseAsync(...)` and separate handling of `TextReasoningContent` vs `TextContent`, emitting `AssistantMode.Reasoning` / `AssistantMode.Text` transitions to the client (`:177-211`).
3. **Persistence + cost accounting.** Every assistant turn is saved with `InputTokens`, `CachedInputTokens`, `OutputTokens`, `ReasoningOutputTokens`, `Duration` and the `ToolCalls` MList; session totals are updated with an `UnsafeUpdate` (`:237-268`). Cost is a **LINQ-translatable computed expression** (`ChatbotLogic.cs:17-36`):

```csharp
[AutoExpressionField]
public static decimal? Price(this ChatMessageEntity message) => As.Expression(() => …
    ((decimal)(message.InputTokens ?? 0) * message.LanguageModel.Entity.PricePerInputToken ?? 0) + … ) / 1_000_000m);
[AutoExpressionField]
public static decimal? TotalPrice(this ChatSessionEntity session) => As.Expression(() => session.Messages().Sum(m => m.Price()));
```
…which means **you can build a UserQuery/Chart/Dashboard over LLM spend** with no extra code.
4. **UI tools (human-in-the-loop).** A tool marked `[UITool]` (`AgentLogic.cs:259-265`) is never executed server-side — its body throws. Instead the loop detects it, breaks, and the controller streams an `AssistantUITool` command; the browser renders/handles it and replies on the *next* HTTP request with `X-Chatbot-UIReply-CallId` / `-ToolId` headers (`ChatbotController.cs:103-124`). Only one UI tool per response is allowed (`ChatbotLogic.cs:246-249`). Client side (`ChatbotClient.tsx:89-95`):

```tsx
export abstract class UITool {
  abstract uiToolName: string;
  handleDirectly?(call: ToolCallEmbedded, sendToolResponse: (call, response) => void): Promise<void>;
  renderWidget?(call: ToolCallEmbedded, sendToolResponse: (call, response) => void): React.ReactElement;
}
```
`GetUIContextUITool.tsx` uses `handleDirectly` (reads `location.href`, locale, screen size, registered page state); `ConfirmUITool.tsx` uses `renderWidget` (inline buttons).
5. **Crash recovery.** `X-Chatbot-Recover: true` finds the last assistant message with a non-UI tool call that has no matching tool result and re-executes it (`ChatbotController.cs:126-142`).
6. **Auto-titling.** After the loop, if the session title is still the placeholder (`!*$`-prefixed), the `QuestionSummarizer` agent generates one (`ChatbotLogic.cs:281-294`).

Wire protocol is a hand-rolled text stream with sentinel notifications, enumerated in `Signum.Agent.ts:80-93`:
`System | SessionId | SessionTitle | QuestionId | MessageId | AssistantStarted | AssistantAnswer | AssistantReasoning | AssistantTool | AssistantUITool | Tool | Exception`. Endpoint: `POST /api/chatbot/ask` with the question as `text/plain` body (`ChatbotClient.tsx:44-69`, `ChatbotController.cs:46`).

### 4.6 LLM providers

`Extensions/Signum.Agent/LanguageModelLogic.cs:18-36` — seven chat providers and five embeddings providers behind `IChatbotModelProvider` / `IEmbeddingsProvider`, all normalized to `Microsoft.Extensions.AI.IChatClient`:

```csharp
public static Dictionary<LanguageModelProviderSymbol, IChatbotModelProvider> ChatbotModelProviders = new()
{
    { LanguageModelProviders.OpenAI, new OpenAIProvider() },        { LanguageModelProviders.Gemini, new GeminiProvider() },
    { LanguageModelProviders.Anthropic, new AnthropicProvider() },  { LanguageModelProviders.GithubModels, new GithubModelsProvider() },
    { LanguageModelProviders.Mistral, new MistralProvider() },      { LanguageModelProviders.Ollama, new OllamaProvider() },
    { LanguageModelProviders.DeepSeek, new DeepSeekProvider() },
};
```

NuGet: `Anthropic.SDK 5.10.0`, `Google_GenerativeAI.Microsoft 3.6.3`, `Microsoft.Extensions.AI.OpenAI 10.4.1`, `Mistral.SDK 2.3.1`, `OllamaSharp 5.4.24`, `OpenAI 2.9.1`, `ModelContextProtocol[.AspNetCore] 1.1.0` (`Signum.Agent.csproj:19-28`).

Providers get a `CustomizeMessagesAndOptions` hook for provider-specific behaviour. The Anthropic one implements **prompt caching** by hoisting system messages into `MessageParameters.System` with `CacheControl { Type = ephemeral }` (`Providers/AnthropicProvider.cs:26-43`) — the right move given the skill instructions are large and stable.

Models are DB rows (`ChatbotLanguageModelEntity`) with `Provider`, `Model`, `Temperature`, `MaxTokens`, `IsDefault` (unique index), and the four price-per-million fields. Model/provider becomes immutable once messages exist (`LanguageModelLogic.cs:51-59`). Embeddings use `Pgvector` (`using Pgvector;` at `LanguageModelLogic.cs:3`).

### 4.7 Admin UI

The `SkillCustomization` screen (`Templates/SkillCustomization.tsx`, 157 lines) is a **prompt-engineering IDE inside the business app**: it calls `GET /api/agentSkill/skillCodeInfo/{skillCode}` and `.../defaultAgentSkillCodeInfo/{agentName}` (`AgentClient.tsx:41-49`) to fetch `DefaultSkillCodeInfo` — the code-declared defaults plus the *reflected tool schemas* (`SkillCodeLogic.cs:99-166`: `DefaultToolInfo { McpName, Description, ReturnType, Parameters[] }`) — so an admin can see every tool signature next to the editable instructions and diff against defaults. `SkillPropertyAttribute` subclasses provide typed, validated overrides; `SkillProperty_QueryListAttribute` (`AgentLogic.cs:216-251`) validates a comma-separated query-key list against `QueryLogic.ToQueryName` and reports *"Unknown query key(s): …"*. The client can register custom editors per attribute type: `AgentClient.registerPropertyValueControl(attributeName, factory)` (`AgentClient.tsx:33-39`).

### 4.8 Security assessment of `Signum.Agent`

**What is right:**
- Tools go through the **normal authorization pipeline**, not a bypass: `Schema.Current.AssertAllowed(type, inUserInterface: true)` (`OperationSkill.cs:57`), `QueryLogic.Queries.GetAllowedQueryNames(...)` in prompt generation and in `ListQueryNames` (`SearchSkill.cs:30, 54`), `OperationLogic.ServiceConstruct/ServiceCanExecute` (which run `CanExecute` preconditions and operation-level auth). So the agent is confined to the acting user's permissions.
- Access to the feature is permission-gated: `ChatbotPermission.UseChatbot` (`ChatSession.cs:166-168`), registered via `PermissionLogic.RegisterTypes(typeof(ChatbotPermission))` (`ChatbotLogic.cs:90`).
- Row-level security is offered for the conversation data itself: `ChatbotLogic.RegisterUserTypeCondition(TypeConditionSymbol)` scopes `ChatSessionEntity` to `User.Is(UserEntity.Current)` and `ChatMessageEntity` transitively (`ChatbotLogic.cs:93-97`).
- Destructive tools are flagged `[McpServerTool(Destructive = true)]` and the `ConfirmUISkill` provides a genuine human-in-the-loop gate rendered inline in the chat.
- Every LLM/tool exception is persisted as an `ExceptionEntity` on the message, so failures are auditable.

**Residual risks to flag in any deployment review:**
- **Prompt injection reaches a write path.** `OperationSkill` can `Construct` / `ConstructFrom` / `Execute` / `Delete` arbitrary entities. Data returned by `SearchSkill`/`RetrieveSkill` is business data that an attacker may control (e.g. a customer-supplied note or filename), and it flows straight into the model's context. The only barrier before a destructive call is the model *choosing* to call `Confirm` — the framework does not force it. Enforcing confirmation server-side for `Destructive = true` tools would be the hardening step.
- **`ConfirmUISkill` is advisory, not mandatory.** `Skills/ConfirmUI.md` says "always"; nothing enforces it.
- **API keys live in `ChatbotConfigurationEmbedded`** and are read via `LanguageModelLogic.GetConfig().AnthropicAPIKey` (`Providers/AnthropicProvider.cs:47`). Whether that is DB-stored or config-bound depends on the host app's `Func<ChatbotConfigurationEmbedded>`; if DB-stored, keys are in a table and reachable by anyone with schema access — treat as a secret-management concern.
- **`AuthLogic.Disable()` in the controller.** `ChatbotController.cs:75` reads history under `using (AuthLogic.Disable())` (after an `AssertAllowed(typeof(ChatMessageEntity))`), which is intentional but is a place where a session-ownership bug would leak other users' conversations. The `RegisterUserTypeCondition` helper exists precisely to close this, but it is opt-in by the host app.
- **`Instructions` are DB-editable prose that becomes the system prompt.** Whoever can save a `SkillCustomizationEntity` can rewrite the agent's behaviour and (via `SubSkills`) attach the `OperationSkill`. That save operation must be tightly role-restricted — it is effectively a privilege-escalation surface. No dedicated permission for it exists beyond the standard operation/type auth on `SkillCustomizationEntity`.
- Debug leftover in shipped code: `IntroductionSkill.Describe` throws if `skillName.Contains("error")` (`Skills/IntroductionSkill.cs:24-25`) — clearly a test hook that should not be in a release.

---

## 5. `Signum.Eval` / `Signum.Dynamic` / `Signum.WorkflowDynamic` — runtime C# and dynamic entities

| | Compiles C#? | Where does the code live? | Restart needed? | Permission gate |
|---|---|---|---|---|
| **Eval** | yes, in-memory → **default** ALC (`EvalEmbedded.cs:74-119`) | `EvalEmbedded.Script` column on the owning entity | no | `EvalPanelPermission.ViewDynamicPanel` (panel only) |
| **Dynamic** | yes, real `.cs` files → `CodeGen/*.dll` on disk (`DynamicLogic.cs:302-325`) | `DynamicTypeEntity.TypeDefinition` JSON + `Dynamic*Entity` rows | **yes** (`DynamicController.cs:73`) | + `DynamicPanelPermission.RestartApplication` |
| **WorkflowDynamic** | no | n/a (glue only) | n/a | none |

### 5.1 `Signum.Eval` — the compile-a-string primitive

Only 8 `.cs` files / ~663 LOC, and **no tables of its own**. The single compile path is `Extensions/Signum.Eval/EvalEmbedded.cs:64-130`:

```csharp
 72   var tree = SyntaxFactory.ParseSyntaxTree(code);
 74   var compilation = CSharpCompilation.Create($"{Guid.NewGuid()}.dll")
 75      .WithOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
 76                    nullableContextOptions: NullableContextOptions.Enable))
 77      .AddReferences(references).AddSyntaxTrees(tree);
 79   using (MemoryStream ms = new MemoryStream())
 81       var emit = compilation.Emit(ms);
115       var assembly = AssemblyLoadContext.Default.LoadFromStream(ms);
117       Type type = assembly.GetTypes().Where(a => typeof(T).IsAssignableFrom(a)).SingleEx();
119       T algorithm = (T)assembly.CreateInstance(type.FullName!)!;
```

Roslyn (`Microsoft.CodeAnalysis.CSharp` 5.3.0). **`AssemblyLoadContext.Default` — not a collectible ALC** — so every distinct script text permanently adds a non-unloadable assembly to the process.

Model:
- `EvalEmbedded<T>` (abstract `EmbeddedEntity`, `EvalEmbedded.cs:10`) with `Script` (`[DbType(Size = int.MaxValue)]`, `:36-47`), `[HiddenProperty] Algorithm` (`:22-34`, throws `InvalidOperationException` carrying the compiler errors), and `CompilationResult { T Algorithm; string CompilationErrors; }` (`:13-17`).
- Two cache layers: per-instance `[Ignore, NonSerialized] compilationResult` cleared by `Reset()` on any `Script` change (`:19-20, 44-53`); plus a **process-wide, content-addressed** `static ConcurrentDictionary<string, CompilationResult> resultCache` per closed generic (`:57`), cleared by `EvalLogic.OnInvalidated` (`:59-61`). The cache key is the full source text, so it self-invalidates on edit — but it is **unbounded, never evicted**. `OnInvalidated` is fired from only three places, all in Workflow (`Extensions/Signum.Workflow/WorkflowLogic.cs:429, 770, 806`); nothing in Dynamic clears it.
- Compile is forced during `PreSaving` (`:146-151`) so `PropertyValidation` (`:138-144`) surfaces compile errors before the entity is saved. (`CompilationError`, wrapping a Roslyn `Diagnostic`, lives in Dynamic at `DynamicLogic.cs:253`, not in Eval.)

**13 `EvalEmbedded<T>` subclasses** across 3 modules — the only consumers (`ProjectReference ..\Signum.Eval` appears in `Signum.Dynamic.csproj:29`, `Signum.Templating.csproj`, `Signum.Workflow.csproj`):

| Module | Subclasses |
|---|---|
| Dynamic (3) | `DynamicValidationEval` (`Validations/DynamicValidation.cs:34`), `DynamicTypeConditionEval` (`Types/DynamicTypeCondition.cs:28`), `DynamicApiEval` (`Controllers/DynamicApi.cs:28`) |
| Templating (1) | `TemplateApplicableEval` (`TemplateApplicable.cs:10`) |
| Workflow (8) | `WorkflowActionEval` (`WorkflowAction.cs:57`), `SubEntitiesEval` (`WorkflowActivity.cs:274`), `WorkflowEventTaskConditionEval`/`…ActionEval` (`WorkflowEventTask.cs:91, 119`), `WorkflowConditionEval` (`WorkflowCondition.cs:57`), `WorkflowLaneActorsEval` (`WorkflowLane.cs:75`), `WorkflowTimerConditionEval` (`WorkflowTimerCondition.cs:61`), `WorkflowScriptEval` (`WorkflowScript.cs:61`) |

The idiom is identical everywhere: build a source string from `EvalLogic.GetUsingNamespaces()` + a wrapper class implementing a marker interface, splicing `this.Script` verbatim (`DynamicValidation.cs:42-59`, `TemplateApplicable.cs:22-39`). `DynamicValidation.cs:39` even auto-wraps expression-only scripts: `script = script.Contains(';') ? script : "return " + script + ";"`.

### 5.1.1 Security: there is no sandbox, only a reference allow-list

`Extensions/Signum.Eval/EvalLogic.cs:13-51` is the entire containment story:

```csharp
 13  public static HashSet<string> Namespaces = new HashSet<string>
 14  { "System", "System.IO", "System.Globalization", "System.Net", "System.Text", "System.Linq",
       "System.Reflection", "System.ComponentModel", "System.Collections", …, "Signum.Utilities", … };
 32  public static HashSet<Type> AssemblyTypes = new HashSet<Type>
 34  { typeof(object), typeof(System.IO.File), typeof(System.Attribute), …
 45    typeof(System.Net.HttpWebRequest), …, typeof(Signum.Utilities.Csv), … };
```

- This only controls **which `MetadataReference`s Roslyn sees** (`GetMetadataReferences`, `:55-63`; `GetCoreMetadataReferences`, `:75-81`). It is **not** a runtime sandbox: no AppDomain, no CAS, no isolated/collectible `AssemblyLoadContext`, no syntax-tree denylist.
- `System.IO` + `typeof(File)` and `System.Net` + `typeof(HttpWebRequest)` are allow-listed **by default** ⇒ eval scripts can read/write the filesystem and make outbound calls as the app-pool identity. `System.Reflection` plus the `mscorlib`/`System.Runtime` references make reflection-based escape from the list trivial.
- `AddFullAssembly(Type)` (`:102-106`) adds *every* exported namespace of an assembly at once; every real deployment calls it for `Signum.dll` and the app's entity assembly, so the list is always wider in practice than the default.
- The only policy hook is `EvalLogic.GetCustomErrors` (`:98`, applied at `EvalEmbedded.cs:97-112`) — it can reject code *after* a successful emit but *before* `Assembly.Load`. `CustomCompilerError { int Line; string ErrorText; }` at `:122-126`.

**Effective threat model: anyone who can save an entity containing an `EvalEmbedded<T>` gets arbitrary code execution as the app-pool identity.** The real gate is therefore *type/operation authorization on the owning entity*, **not** `EvalPanelPermission.ViewDynamicPanel` (`EvalEmbedded.cs:163-167`), which guards only the eval panel (`EvalPanelController.cs:15`).

### 5.2 `Signum.Dynamic` — define the application at runtime

36 `.cs` / ~4214 LOC. Deps: `Signum.Eval`, `Signum.Caching`, `Signum.Tree`, `Signum.Isolation`, **`Signum.Migrations`** (`Signum.Dynamic.csproj:25-31`).

**What can be defined dynamically:**

| Concern | Entity | File | Codegen |
|---|---|---|---|
| Entity types, columns, PK, ticks, table name, operations, MList tables, unique indexes, custom inheritance/members/start code | `DynamicTypeEntity` + POCO `DynamicTypeDefinition` | `Types/DynamicType.cs:8, :124-164` | `Types/DynamicTypeLogic.cs` (911 LOC) |
| Declarative validators (9 subclasses: NotNull, StringLength, Decimals, NumberIs, CountIs, NumberBetween, DateTimePrecision, TimeSpanPrecision, StringCase) | `DynamicValidator` | `Types/DynamicType.cs:289-441` | rendered as C# attributes |
| Imperative validations (C#) | `DynamicValidationEntity` + `…Eval` | `Validations/DynamicValidation.cs:7, 34` | hooks `Validator.GlobalValidation +=` (`DynamicValidationLogic.cs:61`) |
| React views | `DynamicViewEntity` (+ `DynamicViewPropEmbedded`), `DynamicViewSelectorEntity`, `DynamicViewOverrideEntity` | `Views/DynamicView.cs:82, 120, 164, 186` | `Views/DynamicViewLogic.cs` |
| Queries / columns | `DynamicTypeDefinition.QueryFields` + `MultiColumnUniqueIndex` | `Types/DynamicType.cs:159, :161-172` | `DynamicTypeLogic.cs:708-740`, `:760-786` |
| Mixins | `DynamicMixinConnectionEntity` | `Mixins/DynamicMixinConnection.cs:19` | → `MixinDeclarations.Register<X,Y>()` (`…Logic.cs:87`) |
| LINQ-translatable expressions | `DynamicExpressionEntity` | `Expression/DynamicExpression.cs:6, 297` | emits `Expression<Func<..>>` + `[ExpressionField]` + `QueryLogic.Expressions.Register` (`…Logic.cs:152-210`) |
| **Type conditions (row-level security predicates)** | `DynamicTypeConditionEntity`, `…SymbolEntity`, `…Eval` | `Types/DynamicTypeCondition.cs:11, 28` | → `TypeConditionLogic.Register<T>(…)` (`…Logic.cs:133-158`) |
| Isolation strategy | `DynamicIsolationMixin` | `Isolation/DynamicIsolation.cs:5` | → `IsolationLogic.Register<X>(…)` (`…Logic.cs:157-179`) |
| Web API controllers | `DynamicApiEntity` + `…Eval` | `Controllers/DynamicApi.cs:8, 28` | one `CodeGenController : ControllerBase` (`…Logic.cs:100-116`) |
| Front-end JS modules | `DynamicClientEntity` | `Client/DynamicClient.cs:5` | served raw (`DynamicClientController.cs:190-195`) |
| CSS | `DynamicCSSOverrideEntity` | `CSS/DynamicCSSOverride.cs:6` | `CSS/DynamicCSSOverrideLogic.cs` |
| SQL migrations + rename history | `DynamicSqlMigrationEntity`, `DynamicRenameEntity` | `SqlMigrations/DynamicSqlMigration.cs:9, 45` | `SqlMigrations/DynamicSqlMigrationLogic.cs` |

`DynamicTypeEntity` stores the whole shape as **JSON in one column**, not relationally (`Types/DynamicType.cs:16-27, 41-52`):

```csharp
[DbType(Size = int.MaxValue)] string typeDefinition;
public string TypeDefinition { get; set { if (Set(ref typeDefinition, value)) definition = null; } }
public DynamicTypeDefinition GetDefinition() => definition ??= JsonSerializer.Deserialize<DynamicTypeDefinition>(TypeDefinition, settings)!;
```
`DynamicBaseType` = `Entity | MixinEntity | EmbeddedEntity | ModelEntity` (`:203-209`).

**The mechanism is NOT runtime schema patching. It is: generate source → compile to a DLL on disk → restart the process → run the normal `SchemaSynchronizer`.**

1. **Collect `.cs` files.** Each sub-module appends to `DynamicLogic.GetCodeFiles` (`DynamicLogic.cs:47`; subscribers at `:30`, `DynamicTypeLogic.cs:30`, `DynamicExpressionLogic.cs:42`, `DynamicTypeConditionLogic.cs:65`, `DynamicMixinConnectionLogic.cs:26`, `DynamicIsolationLogic.cs:112`). Generated names: `<TypeName>.cs`, `<TypeName>Logic.cs`, `CodeGenBeforeSchema.cs`, `CodeGenStarter.cs`, `CodeGenExpressionStarter.cs`, `CodeGenTypeCondition.cs`, `CodeGenMixinLogic.cs`, `CodeGenIsolationLogic.cs`, `CodeGenController.cs`.
2. **Write real files + compile** (`DynamicLogic.cs:293-334`):

```csharp
302   codeFiles.Values.ToList().ForEach(a => File.WriteAllText(
          Path.Combine(CodeGenDirectory, a.FileName), a.FileContent, Encoding.UTF8));
305   var references = EvalLogic.GetCoreMetadataReferences().Concat(EvalLogic.GetMetadataReferences(needsCodeGenAssembly));
308   var compilation = CSharpCompilation.Create(Path.GetFileNameWithoutExtension(assemblyName))
311        .AddSyntaxTrees(codeFiles.Values.Select(v => CSharpSyntaxTree.ParseText(v.FileContent,
                path: …, options: new CSharpParseOptions(LanguageVersion.CSharp8))));
313   var outputAssembly = inMemory ? null : Path.Combine(CodeGenDirectory, $"{assemblyName.Before(".")}.{Guid.NewGuid()}.dll");
317        var emitResult = compilation.Emit(stream);
```
Constants at `DynamicLogic.cs:14-19`: `CodeGenNamespace = "Signum.CodeGen"`, `CodeGenDirectory = "CodeGen"`, `CodeGenAssembly = "CodeGenAssembly.dll"`, `CodeGenControllerAssembly`. Note `LanguageVersion.CSharp8` is pinned even though the project targets net10.0.
3. **Startup binding.** `BindCodeGenAssemblies` picks the **newest DLL by `CreationTime`** (`:51-59, 91-95`); `AssemblyResolveHandler` (`:39-45`) resolves via `Assembly.LoadFrom`; then `RegisterMixins()` → `RegisterIsolations()` → `BeforeSchema(sb)` → `StartDynamicModules(sb)` (`:164-234`) invoke the generated starters reflectively. The generated `<TypeName>Logic.Start(sb)` does exactly what a hand-written module does — `sb.Include<XEntity>().WithSave(…).WithQuery(…)` (`DynamicTypeLogic.cs:708-740`) — into schema `codegen` (`[assembly: AssemblySchemaName("codegen")]`, `DynamicTypeLogic.cs:893`).
   Failure mode is explicit and alarming (`DynamicLogic.cs:145-162`): `"IMPORTANT!: Starting without Dynamic Entities."` / `"Synchronizing will try to DROP dynamic types. Clean the script manually!"`.
4. **Restart.** `POST api/dynamic/restartServer` → `lifeTime.StopApplication()` (`DynamicController.cs:65-74`). The UI is an explicit wizard: `DynamicPanelCodeGenPage.tsx:22` `type DynamicPanelTab = "search" | "compile" | "restartServerApp" | "migrations" | "checkEvals" | "refreshClients"`.
5. **DB.** `DynamicSqlMigrationEntity` is produced by running the normal synchronizer **non-interactively** with an auto-renamer derived from `DynamicRenameEntity` rows (`SqlMigrations/DynamicSqlMigrationLogic.cs:80-87`), and executed from a web request inside `Transaction.ForceNew` with `Console.Out` hijacked into a `SynchronizedStringWriter` so the browser can tail the log (`:99-139, :276-304`).

### 5.2.1 Security implications

Only **two** permissions exist in the whole Eval+Dynamic surface: `EvalPanelPermission.ViewDynamicPanel` and `DynamicPanelPermission.RestartApplication` (`Dynamic.cs:3-7`, registered `DynamicLogic.cs:29`). The complete list of enforcement points:

| File:line | Gate |
|---|---|
| `Signum.Eval/EvalPanelController.cs:15` | `ViewDynamicPanel` |
| `Signum.Dynamic/DynamicController.cs:23` | `ViewDynamicPanel` on `POST api/dynamic/compile` |
| `Signum.Dynamic/DynamicController.cs:68` | `RestartApplication` on `POST api/dynamic/restartServer` |
| `Signum.Dynamic/DynamicController.cs:79` | `ViewDynamicPanel` on `GET api/dynamic/startErrors` |
| `Signum.Dynamic/DynamicController.cs:98` | `ViewDynamicPanel` on `POST api/dynamic/getPanelInformation` |

That is all. Consequences:

1. **`ViewDynamicPanel` + `RestartApplication` = full RCE, by design.** `POST api/dynamic/compile` writes attacker-influenced `.cs` to disk and compiles it, gated by a *view* permission.
2. **Three endpoints compile *and execute* posted C# with NO `AssertAuthorized` at all** — only the generic `SignumAuthenticationFilter` (`Signum/API/Filters/SignumFilters.cs:39-68`), i.e. **any authenticated user**:
   - `Extensions/Signum.Dynamic/Expression/DynamicExpressionController.cs:12-46` compiles `request.dynamicExpression.Body` at `:40` and **invokes it at `:58`**.
   - `Extensions/Signum.Dynamic/Validations/DynamicValidationController.cs:113-119` compiles the posted script, invokes at `:145`.
   - `Extensions/Signum.Dynamic/Types/DynamicTypeConditionController.cs:187-193` same, invokes at `:207`.
3. **Unauthenticated-by-permission stored XSS by design.** `GET api/dynamic/clients` (`Client/DynamicClientController.cs:190-195`) has no permission check and its payload is `eval`'d in every user's browser: `DynamicClientClient.tsx:39-44` does `eval("(function start"+c.name+"(modules){ "+c.code+" })")`. Same pattern at `DynamicViewClient.tsx:319, 380` and `View/NodeUtils.tsx:517, 526`; `DynamicViewController.cs` also has no asserts. Only mitigation is a `?safeMode` escape hatch (`DynamicClientClient.tsx:31-33`).
4. **Arbitrary SQL over HTTP**: `DynamicSqlMigrationOperation.Execute` (`DynamicSqlMigrationLogic.cs:99-139`), gated only by operation authorization.
5. **User-authored row-level security**: `DynamicTypeConditionEntity` scripts compile straight into `TypeConditionLogic.Register` (`DynamicTypeConditionLogic.cs:143`).
6. **User-authored MVC controllers**: `SignumDynamicApiControllerProvider.cs:126-141` does `Assembly.LoadFrom` and registers *every* exported type as a controller — routes and `[Authorize]` semantics are whatever the script author typed.
7. Rename heuristics use Levenshtein guessing (`DynamicSqlMigrationLogic.cs:154-158`) inside a **non-interactive** sync — a wrong guess becomes destructive DDL in the generated migration.

Practical guidance: treat `Signum.Dynamic` as a *development-time* facility. In production, either omit the module or restrict every `Dynamic*Entity` save operation and the three `/test` endpoints to a break-glass role; the module's own permissions are insufficient.

### 5.3 `Signum.WorkflowDynamic` — pure glue

2 `.cs` (~100 LOC) + 1 `.tsx`. **No entity, no table, no permission.** `WorkflowDynamicLogic.Start` (`WorkflowDynamicLogic.cs:13-58`) asserts Workflow started, then registers two conditional blocks via `sb.Schema.WhenIncluded<T>`:

```csharp
// :20-30 — when DynamicTypeEntity exists, add an operation to repair denormalized case descriptions
sb.Schema.WhenIncluded<DynamicTypeEntity>(() => {
    new Graph<DynamicTypeEntity>.Execute(DynamicTypeWorkflowOperation.FixCaseDescriptions)
    { Execute = (e, _) => { var type = TypeLogic.GetType(e.TypeName); giFixCaseDescriptions.GetInvoker(type)(); } }.Register();
});
```
`FixCaseDescriptions` bulk-`UnsafeUpdate`s `CaseEntity.Description` from the (renamed) dynamic entity's `ToString()` (`:60-69`) — its only declared type is the symbol at `DynamicTypeWorkflowOperation.cs:87-91`.

Second block (`:32-57`): when `DynamicViewEntity` exists, install `StaticPropertyValidation` on `WorkflowActivityEntity.ViewNameProps` and `WorkflowActivityModel.ViewNameProps` cross-checking them against the dynamic view's declared `Props` (shared `ValidateViewNameProps`, `:72-81`).

Client side (`WorkflowDynamicClient.tsx:12-70`) rewires `WorkflowActivityModelOptions.getViewProps`/`navigateToView` to the Dynamic view API and registers three `DynamicViewClient.registeredCustomContexts` — `"caseActivity"`, `"case"`, `"parentCase"` — so dynamic views can bind to the workflow case context.

`sb.Schema.WhenIncluded<T>(action)` is worth noting as a general framework idiom: **optional cross-module integration without a hard dependency at Start time.**

---

## 6. `Signum.Migrations` — how migrations are modeled

8 `.cs` files. Depends **only on `Signum.Utilities` + `Signum`** (`Signum.Migrations.csproj:22-25`) — no Eval, no Dynamic. The arrow points the other way: `Signum.Dynamic` and `Signum.UserAssets` reference `Signum.Migrations`.

### 6.1 The model: a ledger, not a script store

Three tables, all `EntityKind.System` + `TicksColumn(false)`:

```csharp
// SqlMigration.cs:158-170
[EntityKind(EntityKind.System, EntityData.Transactional), TicksColumn(false)]
public class SqlMigrationEntity : Entity
{
    [UniqueIndex][StringLengthValidator(Max = 200)] public string VersionNumber { get; set; }
    [StringLengthValidator(Min = 0, Max = 400)]     public string? Comment { get; set; }
}
```
- `CSharpMigrationEntity` (`CSharpMigration.cs:174-185`): `[UniqueIndex] string UniqueName` + `DateTime ExecutionDate`.
- `LoadMethodLogEntity` (`LoadMethodLogEntity.cs:167-195`): `MethodName`, `ClassName`, `Description`, `Start`, `End`, computed `Duration` (`[ExpressionField("DurationExpression"), Unit("ms")]`, `:183-189`), `Lite<ExceptionEntity>? Exception`.

**No entity stores the SQL.** `SqlMigrationEntity` is *purely* a "we already ran version X" ledger row; the script lives only on disk, in git. (Contrast: `Signum.Dynamic`'s `DynamicSqlMigrationEntity` *does* store `Script` in the DB — a deliberately different, web-driven model for runtime-generated schema changes.)

### 6.2 `MigrationLogic.Start` and the seam into the core

`Extensions/Signum.Migrations/MigrationLogic.cs:5-64` includes the three tables with queries (`:10-37`), registers log retention (`ExceptionLogic.DeleteLogs += …`, `:39`), and then **overrides the core's plain-sync entry point**:

```csharp
// MigrationLogic.cs:41-63
Administrator.AvoidSimpleSynchronize = () =>
{
    if (Administrator.ExistsTable<SqlMigrationEntity>())
    {
        var count = Database.Query<SqlMigrationEntity>().Count();
        if (count > 0) { …
            if (SafeConsole.Ask("Do you want to create a new SQL Migration instead?", "continue", "migrations") == "migrations")
            { SqlMigrationRunner.SqlMigrations(); return true; }
        }
    }
    return false;
};
```

Plus `EnsureMigrationTable<T>()` (`:85-109`), which bootstraps the migration table itself out-of-band via `sqlBuilder.CreateSchema/CreateTableSql/CreateIndex(...).ExecuteLeaves()` — solving the chicken-and-egg — and `ExecuteLoadProcess(Action, string)` (`:111-153`) which wraps any load/migration action in a `LoadMethodLogEntity` row with exception capture.

### 6.3 Files on disk ↔ DB rows (`SqlMigrationRunner.cs`)

- **Directory**: `MigrationsDirectory = Path.Combine("..","..","..","Migrations")` (`:9`) — the *source tree*, next to the Terminal project. Migrations are git artifacts.
- **Filename is the identity**: `:198` `new Regex(@"(?<version>\d{4}\.\d{2}\.\d{2}\-\d{2}\.\d{2}\.\d{2})(_(?<comment>.+))?\.sql")`. Non-matching `.sql` throws (`:203-207`). Ordering is **lexicographic on the `yyyy.MM.dd-HH.mm.ss` version string** (`:214, :169`) — the timestamp *is* the sequence number.
- **Join**: `SetExecuted` (`:136-170`) loads `VersionNumber`s and marks matching disk entries executed; DB rows with **no file** become synthetic entries `Comment = ">> In Database Only << …", FileName = null` (`:159-165`).
- **Execution** (`:330-355`): read the file, `text.Replace(DatabaseNameReplacement, Connector.Current.DatabaseName())` (the `"#DatabaseName#"` token, `:219`), `SqlPreCommandExtensions.ExecuteScript`, then `EnsureMigrationTable<SqlMigrationEntity>()` and insert the ledger row — all inside `Transaction.ForceNew`, **except** when the comment starts with `"NT_"` (no-transaction migrations, `:335`; prefix stamped at `:104`).
- **Two guard rails** in `Prompt` (`:222-321`): executed-but-file-missing ⇒ "get latest version" and abort (`:226-234`); an unexecuted migration *older* than an executed one ⇒ suspected merge conflict, requires typing literal `"force"` (`:236-250`).
- **Creating a migration** (`:252-287`): only when everything is executed → `Schema.Current.SynchronizationScript(out var rep, interactive: true, replaceDatabaseName: DatabaseNameReplacement)`, display, ask for a comment, `File.WriteAllText`, fire `AfterCreatingMigration`. The new file is **not** ledgered here — the loop then *executes* it like any other.
- **Bootstrap / squash**: `CreateInitialMigration()` uses `Schema.Current.GenerationScipt(...)` (`:91-96`); `SaveMigrations` splits a `SqlPreCommandConcat` into `Before …`/…/`After …` files at ±1 s (`:98-134`); `SquashMigrationHistory()` (`:384-449`) loops `Administrator.TotalSynchronizeScript` until clean, then deletes all files + `UnsafeDelete`s all rows and regenerates one initial migration, ledgering directly (`:441-446`).
- **Cache reset after applying**: `ResetCache()` (`:323-328`) → `Schema.InvalidateCache` + `GlobalLazy.ResetAll` + `InvalidateMetadata`.
- **Events** (documented `:11-40`): `AfterMigrationsCompleted(bool autoRun)`, `AfterCreatingMigration(string fileName, Replacements)`, plus a `PromptResult { Continue, Skip, Completed }` state machine.

`CSharpMigrationRunner.cs` is the code-side analogue: an `IEnumerable<MigrationInfo>` you `Add(Action, uniqueName)` (`:10-13`), keyed by **`action.Method.Name`** by default (`:15-18`), recorded as `CSharpMigrationEntity` (`:105-109`). Order = **registration order**, not timestamps; `SetExecuted` compares against the DB `UniqueName` set (`:31-43`); failures rethrown as `ExecuteSqlScriptException` (`:102`).

### 6.4 Four distinct layers — do not conflate them

1. **`SchemaSynchronizer` (core, `Signum/Engine/Sync/SchemaSynchronizer.cs:9`, 1334 LOC)** — the **diff engine**. `SynchronizeTablesScript(Replacements)` (`:15`) compares `Schema.Current.GetDatabaseTables()` (the model, `:23`) against `SysTablesSchema.GetDatabaseDescription` / `PostgresCatalogSchema.GetDatabaseDescription` (the live DB, `:34-36`) and emits a `SqlPreCommand`. It also owns `SnapshotIsolation` (`:1247`), `SyncPostgresExtensions` (`:1292`), `SyncPostgresDefaultTextLanguage` (`:1316`). It **writes nothing and tracks nothing** — pure diff→script. Wired as an event subscriber (`Signum/Engine/Schema/Schema.cs:686-693`):

```csharp
686  Synchronizing += SchemaSynchronizer.SnapshotIsolation;
691  Synchronizing += SchemaSynchronizer.SynchronizeTablesScript;
693  Synchronizing += TypeLogic.Schema_Synchronizing;
```
fanned out by `Schema.SynchronizationScript(out Replacements, interactive, schemaOnly, replaceDatabaseName, autoReplacement)` (`Schema.cs:420-468`), which builds the `Replacements` rename context and combines every subscriber's script (this is where each module's own `sb.Schema.Synchronizing += …` hook, e.g. `Extensions/Signum.Agent/SkillCodeLogic.cs:82-93`, contributes).
2. **`Administrator.Synchronize()` (`Signum/Engine/Administrator.cs:167-189`)** — the "open `Sync*.sql` and run it yourself" dev flow. Its first line is `if (AvoidSimpleSynchronize()) return;` (`:168`) — the seam `Signum.Migrations` hijacks (§6.2). `TotalSynchronizeScript` at `:191-206`; `AfterSynchronize` event at `:157-164`.
3. **`Signum.Migrations`** — adds **versioning, ordering, idempotence and an audit ledger** on top of (1)+(2). It never diffs anything itself; it calls `SynchronizationScript`/`GenerationScipt` and freezes the result into a timestamped file.
4. **`Signum.Upgrade` (`/home/patrick.maue/git/sfcl/signum-framework/Signum.Upgrade/`, an `Exe`)** — **completely unrelated to DB migrations**: a *source-code* rewriting tool. It references only `Signum.Utilities` + `LibGit2Sharp` (`Signum.Upgrade.csproj:10-16`) — no `Signum.csproj`, so no `Schema`/`Connector` access at all. `CodeUpgradeRunner` auto-discovers `CodeUpgradeBase` subclasses ordered by **type name** (`CodeUpgradeRunner.cs:15-22`) and tracks executed steps in a **plain text file committed to git**, `SignumUpgrade.txt` (`:34, 44-57`) — the file-based analogue of `SqlMigrationEntity`. Steps are named `Upgrade_yyyyMMdd_Description.cs` (e.g. `Upgrades/Upgrade_20260710_TypeScript7Stable.cs`) and mutate the app's `.cs`/`.tsx`/`.csproj` text.

> **`Signum.Upgrade` upgrades your *source* to a newer framework version; `Signum.Migrations` upgrades your *database* to match your source; `SchemaSynchronizer` computes the delta that `Signum.Migrations` freezes into a file.**

A fifth flavour rides the `Signum.Migrations` events: `Extensions/Signum.UserAssets/TokenMigrations/TokenMigrationLogic.cs:42-63` subscribes `SqlMigrationRunner.AfterMigrationsCompleted`, `AfterCreatingMigration` and `Administrator.AfterSynchronize`, and persists sibling artifacts next to the `.sql` files (`.tokens.json` / `.query.json`, matched by the same version regex, `:21-31`) with its own `TokenMigrationEntity` ledger (`:49-56`) — so that **stored query tokens in user assets get migrated alongside the schema**.

### 6.5 Security notes

- `Signum.Migrations` has **zero permission checks** — by design: it is a console/terminal-only surface (`SafeConsole.Ask`, `Console.ReadLine`), never exposed over HTTP. The HTTP-exposed variant is `Signum.Dynamic`'s `DynamicSqlMigrationEntity` (§5.2.1 item 4).
- Migration `.sql` files are executed verbatim from a path relative to the working directory (`SqlMigrationRunner.cs:9, 333`) — write access to that directory equals arbitrary SQL execution as the migration account.
- `SquashMigrationHistory` (`:384-449`) irreversibly `File.Delete`s all migrations and `UnsafeDelete`s the ledger behind a single typed `"squash"` confirmation (`:427`).
- `"NT_"`-prefixed migrations run **outside any transaction** (`:335`) and can leave the schema half-applied while still recording the ledger row.

---

## 7. Cross-cutting observations & flags for human review

1. **The extension pattern is remarkably uniform** — the 11-file checklist in §1.11 covers essentially every module; the difference between `Signum.Notes` (16 files) and `Signum.Workflow` (97) is *quantity* of entities/views, not a different architecture. That makes the framework easy to extend and easy to reason about, at the cost of a lot of boilerplate per module.
2. **The single source of truth is the C# entity.** DB schema (via `SchemaSynchronizer`), TS types (via `TSGenerator`), validation, localization keys, query tokens and UI metadata all derive from it. This is the framework's central bet, and `Signum.Agent`'s skills exploit it directly — the LLM tools *are* the metadata API.
3. **Static registration + no DI** is a deliberate, documented policy (`AGENTS.md:38`), enforced by the `sb.AlreadyDefined(...)` idempotence guard. The cost is that module composition order is the host app's responsibility and is not verified by the compiler; the mitigations are `XLogic.AssertStarted(sb)` and `sb.Schema.WhenIncluded<T>(...)`.
4. **Security items to escalate** (all generated code / eval surfaces should get a dedicated security + license review):
   - Three `api/dynamic/*/test` endpoints compile **and execute** posted C# for any authenticated user with no permission assert (`DynamicExpressionController.cs:12-58`, `DynamicValidationController.cs:113-145`, `DynamicTypeConditionController.cs:187-207`).
   - `GET api/dynamic/clients` is unguarded and its payload is `eval`'d in every browser (`DynamicClientController.cs:190-195` + `DynamicClientClient.tsx:39-44`).
   - `Signum.Eval` loads compiled code into the **default, non-collectible** `AssemblyLoadContext` with an unbounded content-keyed cache (memory growth; no unload).
   - `Signum.Agent`: prompt injection can reach the destructive `OperationSkill` write path; `ConfirmUISkill` is advisory only, not server-enforced; `SkillCustomizationEntity.Instructions` is a DB-editable system prompt and therefore a privilege-escalation surface that deserves its own permission.
   - Debug leftover shipped in `Extensions/Signum.Agent/Skills/IntroductionSkill.cs:24-25`: `if (skillName.Contains("error")) throw new Exception(...)`.
5. **Licensing**: the framework is MIT (`LICENSE.txt`, `package.json` `"license": "MIT"`). Third-party NuGet in the extensions worth a license pass: TensorFlow.Keras (MachineLearning), bpmn-js (Workflow), MailKit (Mailing.Pop3), the seven LLM SDKs in `Signum.Agent`, `Pgvector`, `LibGit2Sharp` (Signum.Upgrade), AWSSDK.S3, Azure SDKs, ImageSharp (Word — note ImageSharp's dual license: Apache-2.0 vs. commercial depending on version).

*All findings above are generated analysis of a read-only checkout; no files in the repository were modified. This document should get a human review pass before being treated as authoritative documentation.*

