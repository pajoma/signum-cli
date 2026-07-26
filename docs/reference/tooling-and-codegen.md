# Signum Framework — Tooling & Code-Generation Ecosystem

Repo analysed read-only: `/home/patrick.maue/git/sfcl/signum-framework` (branch `develop`).
All paths below are relative to that root unless absolute.

## 0. Map of the tooling estate

| Area | Kind | Target | In `Signum.Framework.sln`? |
|---|---|---|---|
| `Signum.Upgrade/` | .NET console `Exe`, net10.0, LibGit2Sharp | rewrites a *target application's* source tree | **No** |
| `Signum/CodeGeneration/` | library code, run from the app's `*.Terminal` console | generates entities / logic / React from DB or assemblies | yes (part of `Signum`) |
| `Signum.TSGenerator/` | `Exe` net10.0 + Mono.Cecil, shipped as NuGet with `.targets` | C# entity assembly → `.ts` declarations | yes |
| `Signum.MSBuildTask/` | `Exe` net10.0 + Mono.Cecil, NuGet with `.targets` | post-compile IL weaving | yes |
| `Signum.TSCBuild/` | VSIX (VS 2022+) | "Build TypeScript" / "Run TSGenerator" context menus | no (own `.sln`) |
| `Signum.VSIX/` | VSIX (older/internal twin of TSCBuild) | same commands | no (own `.sln`) |
| `Signum.Analyzer/` | Roslyn analyzers + code fixes, netstandard2.0 NuGet | 8 diagnostics enforcing framework rules | no (own `.sln`) |
| `Snippets/`, `SnippetsTS/` | VS `.snippet` XML (34 + 15 files) | canonical code shapes | n/a |
| `Utils/CheckUrl/` | tiny `Exe` | poll a URL until alive/dead | no |
| `Skills/` | 4 `.md` agent skill docs | incl. `CreatingSignumUpgrades.md` | n/a |

`Signum.Framework.sln` contains only `Signum.Utilities`, `Signum.Test`, `Signum.TSGenerator`,
`Signum.MSBuildTask`, `Signum`. Everything else is deliberately out-of-solution — a strong hint that
`Signum.Upgrade` is meant to be opened/run from the *application's* solution (the Framework repo is a
git submodule at `Framework/` inside each app).

`Signum/Signum.csproj:31-33` shows the three build-time tools consumed as NuGet packages:

```xml
<PackageReference Include="Signum.Analyzer" Version="3.2.0" />
<PackageReference Include="Signum.MSBuildTask" Version="10.0.0" />
<PackageReference Include="Signum.TSGenerator" Version="10.0.3" />
```

---

## 1. `Signum.Upgrade/` — the de-facto Signum CLI

`Signum.Upgrade/Signum.Upgrade.csproj`:

```xml
<OutputType>Exe</OutputType>
<TargetFramework>net10.0</TargetFramework>
<Nullable>enable</Nullable><WarningsAsErrors>nullable</WarningsAsErrors>
...
<PackageReference Include="LibGit2Sharp" Version="0.31.0" />
<ProjectReference Include="..\Signum.Utilities\Signum.Utilities.csproj" />
```

Only 8 infrastructure files (1,723 LOC) + **223 upgrade scripts** (9,738 LOC) in `Upgrades/`.

### 1.1 `Program.cs` — input parsing and menu

There is **no argument parsing at all**. `args` is accepted and ignored (`Program.cs:8`).
No `ConsoleSwitch`, no verbs, no flags. The whole UX is: `cd` into an app folder, run the exe.

```csharp
// Signum.Upgrade/Program.cs:8-41
static void Main(string[] args)
{
    Console.WriteLine("  ..:: Welcome to Signum Upgrade ::..");
    SafeConsole.WriteLineColor(ConsoleColor.DarkGray, "  This application helps you upgrade a Signum Framework application by modifying your source code.");
    SafeConsole.WriteLineColor(ConsoleColor.DarkGray, "  The closer your application resembles Southwind, the better it works.");
    SafeConsole.WriteLineColor(ConsoleColor.DarkGray, "  Review all the changes carefully");

    var uctx = UpgradeContext.CreateFromCurrentDirectory();
    Console.Write("  RootFolder = ");      SafeConsole.WriteLineColor(ConsoleColor.DarkGray, uctx.RootFolder);
    Console.Write("  ApplicationName = "); SafeConsole.WriteLineColor(ConsoleColor.DarkGray, uctx.ApplicationName);

    uctx.ChangeCodeFile("SignumUpgrade.tsx", file => { /* one-off historical self-repair of key names */ });

    //SolutionRenamer.RenameSolution(uctx);                                    // <-- line 36, commented out
    //UpgradeContext.DefaultIgnoreDirectories = ... .Where(a => a != "Framework")  // <-- line 38, commented out

    new CodeUpgradeRunner(autoDiscover: true).Run(uctx);
}
```

Two of the three "commands" the tool can perform are **commented-out source lines** (`:36`, `:38`).
`ApplicationRenamer.RenameApplication` has **zero callers anywhere in the repo** (verified by grep) —
it is dead-but-maintained code you re-wire by editing `Program.cs` and rebuilding.

Note: `ConsoleSwitch<K,V>` from `Signum.Utilities/ConsoleSwitch.cs` *is* the framework's console-menu
primitive, but `Signum.Upgrade` uses it only indirectly via the `ChooseConsole` extension
(`CodeUpgradeRunner.cs:51`) and `SafeConsole.Ask`. The direct users of `ConsoleSwitch` are
`Signum/CodeGeneration/CodeGenerator.cs:15`, `ReactCodeGenerator.cs:168`,
`Extensions/Signum.Authorization/AuthLogic.cs:1047`, `Extensions/Signum.Help/HelpExportImport.cs:847`,
`Extensions/Signum.Mailing/Templates/EmailTemplateLogic.cs:142`.

### 1.2 `UpgradeContext.cs` — discovering & modelling the target app

Discovery is convention-based and brutally simple (`UpgradeContext.cs:34-52`):

```csharp
static string GetRootFolder()                       // walk up until a "Framework" directory exists
{
    var directory = Directory.GetCurrentDirectory()!;
    while (!Directory.Exists(Path.Combine(directory, "Framework")))
    {
        directory = Path.GetDirectoryName(directory);
        if (directory == null) throw new InvalidOperationException("Unable to detect Root Folder");
    }
    return directory;
}

static string GetApplicationName(string rootFolder)  // the *.sln whose name matches a sibling folder
{
    var lists = Directory.GetFiles(rootFolder, "*.sln").Select(Path.GetFileNameWithoutExtension).ToList();
    return lists.SingleEx(a => Directory.Exists(Path.Combine(rootFolder, a))
                            || Directory.Exists(Path.Combine(rootFolder, a + ".Entities")));
}
```

So the model of an application is exactly two strings: `RootFolder` + `ApplicationName`.
Everything else is derived by string concatenation (`UpgradeContext.cs:112-118`):

```csharp
public string EntitiesDirectory        => AbsolutePath(ApplicationName + ".Entities");
public string LogicDirectory           => AbsolutePath(ApplicationName + ".Logic");
public string TerminalDirectory        => AbsolutePath(ApplicationName + ".Terminal");
public string ReactDirectory           => AbsolutePath(ApplicationName + ".React");
public string TestEnvironmentDirectory => AbsolutePath(ApplicationName + ".Test.Environment");
public string TestLogicDirectory       => AbsolutePath(ApplicationName + ".Test.Logic");
public string TestReactDirectory       => AbsolutePath(ApplicationName + ".Test.React");
```

The **templating mechanism is literally `Replace("Southwind", ApplicationName)`** — `Southwind` is the
reference application and every upgrade script is written against Southwind paths
(`UpgradeContext.cs:109`, `:126`, `:217`, `:241`):

```csharp
public string AbsolutePathSouthwind(string name) =>
    Path.Combine(RootFolder, name.Replace("Southwind", this.ApplicationName));
```

Ignore list (`UpgradeContext.cs:122`):
```csharp
public static string[] DefaultIgnoreDirectories =
    { "bin","obj","CodeGen","node_modules","ts_out","dist","Framework",".git",".vs",".vscode" };
```

File-level API surface: `TryGetCodeFile`, `CreateCodeFile`, `DeleteFile`, `ChangeCodeFile`,
`ForeachCodeFile` (3 overloads, comma-separated glob patterns, recursive with ignore list),
`GetCodeFiles`, `MoveFile`, `MoveFiles`, `DeleteDirectory`, `ReplaceSouthwind`.
Every one takes a `WarningLevel` (`None` / `Warning` / `Error`) so a script declares how loudly a
missed target should complain; `uctx.HasWarnings` accumulates the worst level per upgrade
(`CodeFile.cs:11-16`, `UpgradeContext.cs:120`).

### 1.3 The execution model: `CodeUpgradeBase` / `CodeUpgradeRunner` / `CodeFile`

**Declaration** — an upgrade is a class with a description and one method (`CodeUpgradeBase.cs`, 13 lines):

```csharp
public abstract class CodeUpgradeBase
{
    public string Key => $"{GetType().Name}";
    public bool IsExecuted { get; set; }
    public abstract string Description { get; }
    public abstract void Execute(UpgradeContext uctx);
}
```

**Discovery + ordering** — reflection over the *own* assembly, ordered alphabetically by type name;
because names are `Upgrade_yyyyMMdd_Title`, alphabetical == chronological (`CodeUpgradeRunner.cs:15-22`):

```csharp
public CodeUpgradeRunner(bool autoDiscover)
{
    if (autoDiscover)
        Upgrades = Assembly.GetExecutingAssembly().GetTypes()
            .Where(t => t.BaseType == typeof(CodeUpgradeBase))
            .OrderBy(t => t.Name)
            .Select(t => (CodeUpgradeBase)Activator.CreateInstance(t)!).ToList();
}
```

Note `t.BaseType == typeof(CodeUpgradeBase)` — direct subclasses only, no intermediate base classes.

**Applied-tracking** — a plain text file `SignumUpgrade.txt` at the app root, one `Key` per line,
committed to git (`CodeUpgradeRunner.cs:34`, `:44-75`):

* If absent, the user is asked *"What do you think is the next upgrade that you should run?"* via
  `ChooseConsole` over all keys plus a `<< Mark ALL upgrades as executed >>` option; everything before
  the choice is written as already-executed (`:51-53`). This is the bootstrap for an app of unknown vintage.
* `IsExecuted` is set by `list.Contains(v.GetType().Name)` (`:73`).
* Legacy repair: strips a historical `Southwind_` prefix if present (`:65-69`).

**The run loop** (`Run` → `SetExecuted` → `Prompt` → `ExecuteUpgrade`), `CodeUpgradeRunner.cs:32-183`:

1. `Draw()` prints the full list colour-coded: dark-green = executed, blue = next, white = pending (`:185-207`).
2. Only the **first** non-executed upgrade is offered: `SafeConsole.Ask("Run next Upgrade ({0})?")` — strictly sequential, no skipping, no "run all".
3. **Clean-tree gate**: blocks until the working copy is clean, using LibGit2Sharp with `ExcludeSubmodules = true` (`:100-107`, `:111-116`). This is the safety model: the diff *is* the review artifact.
4. `upgrade.Execute(uctx)`; on exception, prints message + stack trace and asks whether to skip & mark executed (`:120-132`).
5. Appends the key to `SignumUpgrade.txt` (`:134`), reports `None`/`Warning`/`Error` summary (`:138-144`).
6. Asks `"What should we do next?" → commit | retry | exit` (`:150`). `commit` stages `*` and commits with the upgrade key as the message using the git config signature (`:152-167`); `retry` waits for you to revert and re-runs the same upgrade (`:168-174`).

So: **one upgrade = one reviewable git commit**, keyed by class name.

**File rewriting — `CodeFile.cs` (921 lines)** is the real payload; it is a *line- and regex-oriented
surgical editor*, not an AST tool. Content is lazily read, BOM/encoding is detected and preserved
(`:44-52`, `:82-103`), and `SaveIfNecessary()` writes only if changed and also performs a pending
move + prunes the emptied directory (`:54-80`). Any operation that fails to match calls
`Warning(FormattableString)`, which colour-prints the interpolated args in white (`:108-132`) —
that's how a partially-applicable upgrade degrades into an actionable TODO list instead of a crash.

Full API (all `Signum.Upgrade/CodeFile.cs`):

| Group | Members (line) |
|---|---|
| raw | `Content` (36), `SaveIfNecessary` (54), `Warning` (108), `GetIndent` (196), `ProcessLines(Func<List<string>,bool>)` (446), `MoveFile` (810), `OverrideWarningLevel` (803) |
| replace | `Replace(string,string)` (134), `Replace(Regex,string)` (144), `Replace(Regex,MatchEvaluator)` (154) |
| line ops | `RemoveAllLines` (165), `ReplaceLine` (374), `InsertAfterFirstLine` (180), `InsertBeforeFirstLine` (391), `InsertAfterLastLine` (414), `InsertBeforeLastLine` (430) |
| block ops | `ReplaceBetween{,Excluded,Included}` string/func overloads (203-275), `ReplaceBetweenAll` (279), `ReplaceBlock` (815), `GetLinesBetween{,Excluded,Included}` (339-372), `GetMethodBody` (324), `ReplaceMethod` (330) |
| TypeScript-aware | `ReplacPartsInTypeScriptImport` (465), `ReplaceAndCombineTypeScriptImports` (499) — parse & rewrite `import { a, b } from '...'` |
| npm | `UpdateNpmPackages(block)` (540), `UpdateNpmPackage` (555), `RemoveNpmPackage` (577), `AddNpmPackage(..., devDependencies)` (604) |
| NuGet | `UpdateNugetReferences(xmlSnippets)` (643), `UpdateNugetReference` (651), `RemoveNugetReference` (672), `AddNugetReference` (693) |
| `.sln` surgery | `Solution_RemoveProject` (710), `Solution_AddProject` (732), `Solution_AddFolder` (770), `Solution_AddSolutionItem` (782) |

The line predicates are `Expression<Predicate<string>>`, **not** `Predicate<string>` — deliberately, so
the failure warning can print the lambda source (`//Waiting for https://github.com/dotnet/csharplang/issues/287`, `:164`):

```csharp
public void RemoveAllLines(Expression<Predicate<string>> condition)
{
    ProcessLines(lines => {
        var res = lines.RemoveAll(condition.Compile());
        if (res == 0) { Warning($"Unable to find any line where {condition} to remove it"); return false; }
        return true;
    });
}
```

`ReplaceBetweenOption` (`:874-919`) carries `Condition`, `Delta`, `LastIndex`, `SameIdentation` —
indentation-aware block matching, which is how `GetMethodBody` finds a closing brace at the same indent.

`Solution_AddProject` is the closest thing in the repo to real project scaffolding: it mints a GUID,
inserts the `Project(...)`/`EndProject` pair, mirrors every `SolutionConfigurationPlatforms` entry into
`ProjectConfigurationPlatforms`, and nests under a solution folder (`:732-767`).

### 1.4 Renaming a generated app

Two overlapping, both-unreachable implementations:

* `ApplicationRenamer.cs:10` `RenameApplication(uctx)` — asks for a new PascalCase name (validated by
  `Regex.IsMatch(s, @"[A-Z][a-zA-Z0-9]+")`), then (a) bottom-up renames every directory and filename via
  `InternalRenameDirectoryTree` honouring `DefaultIgnoreDirectories`, **commits**, then (b) rewrites
  content of `*.*` in three case variants (lower / UPPER / exact) and **commits again**. Two commits =
  git rename detection survives. Gated on a clean tree. **No callers.**
* `SolutionRenamer.cs:18` `RenameSolution(uctx)` — a later, cruder rewrite living in namespace
  `Signum.CodeGeneration` (namespace/folder mismatch). Whitelists 17 text extensions plus `Dockerfile`
  (`:10-14`), skips `bin obj .git .vs ts_out node_modules`, uses "has a `.gitignore`" as a submodule
  heuristic (`:53`), does *not* commit, and swallows every IO error into a red console line. It also has
  a latent bug: `if (SafeConsole.Ask("Are you running outside of Visual Studio and VS is closed?"))` at
  `:22` has **no braces and no body**, so the following `Console.Write` is the conditional statement and
  the prompt for the new name is only printed when the user answers yes — the `ReadLine` runs regardless.
  Referenced only from the commented-out `Program.cs:36`.

### 1.5 The `Upgrades/` catalogue

223 files, naming convention `Upgrade_<yyyyMMdd>[_<n>]_<PascalTitle>.cs`, namespace
`Signum.Upgrade.Upgrades`, class is `internal` (`class X : CodeUpgradeBase`). Cadence is remarkably
steady — 2020: 17, 2021: 41, 2022: 39, 2023: 35, 2024: 36, 2025: 37, 2026: 18 (to July). Median size is
~14 lines; the tail is large: `Upgrade_20260321_SeleniumToPlaywright.cs` (585),
`Upgrade_20230426_ProjectRevolution_MoveFiles.cs` (464),
`Upgrade_20230426_4_ProjectRevolution_RemoveStartup.cs` (283).

Themes: NuGet/npm version bumps (`*UpdateNugets*`, ~15 scripts), TypeScript/React/Bootstrap major
upgrades, .NET version bumps, project-layout revolutions, API renames, Docker/CI/deployment,
Copilot/Claude config files (`Upgrade_20260326_ClaudeGitignore`, `Upgrade_20260212_UpdateCopilotInstructions3`).

**Example A — the minimal shape** (`Upgrades/Upgrade_20260326_ClaudeGitignore.cs`, complete file):

```csharp
namespace Signum.Upgrade.Upgrades;

class Upgrade_20260326_ClaudeGitignore : CodeUpgradeBase
{
    public override string Description => "Add .claude worktrees and settings.local.json to root .gitignore";

    public override void Execute(UpgradeContext uctx)
    {
        uctx.ChangeCodeFile(".gitignore", file =>
        {
            file.InsertAfterLastLine(a => a.Trim().Length > 0,
                """

                .claude/worktrees/
                .claude/settings.local.json
                """);
        });
    }
}
```

**Example B — Southwind-templated paths** (`Upgrades/Upgrade_20260710_TypeScript7Stable.cs`, complete):

```csharp
class Upgrade_20260710_TypeScript7Stable : CodeUpgradeBase
{
    public override string Description => "Switch from TypeScript Native Preview (tsgo) back to stable TypeScript 7.0.2";

    public override void Execute(UpgradeContext uctx)
    {
        uctx.ChangeCodeFile("Southwind.Server/Southwind.Server.csproj", file =>
        {
            file.ReplaceLine(a => a.Contains("TSC_Build"), "<TSC_Build>true</TSC_Build>");
        });

        uctx.ChangeCodeFile("Southwind.Server/package.json", file =>
        {
            file.ReplaceLine(a => a.Contains("@typescript/native-preview"), """"typescript": "7.0.2","""");
        });
    }
}
```

**Example C — the dependency-bump idiom** (`Upgrades/Upgrade_20260422_UpdateNugets.cs`): a single
`ForeachCodeFile("*.csproj", …)` + `UpdateNugetReferences` fed a verbatim block of `<PackageReference>`
lines; the helper matches by `Include=` and only rewrites versions of packages already present.

**Example D — structural migration** (`Upgrades/Upgrade_20240328_Extract_Server.cs`, "Extract Program.cs
and webpack to Southwind.Server"): declares a local `string ToServer(string filePath) =>
filePath.Replace(uctx.ApplicationName, uctx.ApplicationName + ".Server")`, then `Directory.CreateDirectory`,
`ForeachCodeFile("appsettings.*", "Southwind", c => c.MoveFile(ToServer(c.FilePath)))`, edits
`.gitignore`, `deploy*.ps1`, root `package.json`, and rewrites the `Dockerfile`'s `COPY`/`WORKDIR`/
`dotnet restore`/`dotnet publish`/`ENTRYPOINT` lines — then moves the Dockerfile too. This is the
pattern for "reshape the app's project layout".

Authoring guidance is captured for agents in `Skills/CreatingSignumUpgrades.md` (whole file):

> When creating `Signum.Upgrade` scripts from Southwind commits:
> - Ignore changes that are only Framework submodule pointer updates.
> - Include Framework-related updates only when the corresponding changes are also present in Southwind files.

i.e. the canonical workflow is **diff Southwind → hand-write an upgrade script that reproduces the diff**.
`AGENTS.md:19` links it as a first-class skill.

### 1.6 Verdict: is `Signum.Upgrade` already "the Signum CLI"?

**It is the only shipped CLI, but it is a migration engine, not a CLI.**

What it *is*:
* A versioned, ordered, git-integrated **migration runner for source code** — conceptually EF Core
  migrations applied to `.cs`/`.tsx`/`.csproj`/`.sln`/`package.json`/`Dockerfile`/`.gitignore` instead of to a database.
* A rich, battle-tested **file-surgery library** (`CodeFile`) with domain-aware helpers for npm, NuGet,
  TypeScript imports and MSBuild solution files.
* A **safety harness**: refuses to run on a dirty tree, one commit per upgrade, warning levels, retry loop.
* A **living changelog** of the framework's breaking changes, 223 entries deep and still ~3/month.

What it deliberately does *not* do:
* **No CLI surface.** `args` unused; no verbs, flags, `--help`, exit codes, or non-interactive mode.
  Every run is a modal Q&A. It cannot be scripted or run in CI.
* **No project/app creation.** There is no `new`/`init`. Bootstrapping is documented as an out-of-band
  web flow — `README.md:50`: *"**Create Application**: The simplest way to get started. Create a new
  project by renaming and customizing Southwind example application."* (links `signumsoftware.com/en/DuplicateApplication`).
* **No scaffolding of entities/logic/views** — that is `Signum/CodeGeneration`'s job, and it lives in a
  *different process* (the app's `*.Terminal`) because it needs the compiled assemblies and a live `Schema`.
* **No app renaming in practice** — both renamers are unreachable dead code.
* **No distribution.** Not in `Signum.Framework.sln`, not packaged as a NuGet/dotnet tool. You build the
  `.csproj` out of the submodule and run it.
* **No idempotence or dry-run.** Re-running an upgrade is prevented only by the txt ledger; there is no
  "what would change" mode — the git diff is the preview.
* **Non-portable assumptions**: hard requirement of a `Framework/` subdirectory, exactly one matching
  `.sln`, the literal token `Southwind`, and Windows-flavoured paths in places.

---

## 2. `Signum/CodeGeneration/` — the in-framework generators

Five files, 3,384 LOC including 5 `.md` docs (`CodeGenerator.md`, `EntityCodeGenerator.md`,
`LogicCodeGenerator.md`, `ReactCodeGenerator.md`, `LegacyDatabase.AdventureWorks.md`).

Design philosophy, verbatim from `Signum/CodeGeneration/CodeGenerator.md`:

> Whenever possible, we prefer hand-written code, a succinct API, and runtime intelligence over code
> generation. However, when language limitations make repetitive code unavoidable, automated code
> generation can save significant development time.
> The code generation classes are designed to run in the Load application, so the solution must compile
> successfully to use them. Unlike Visual Studio Item Templates, these generators do not require
> installation and offer greater power and customization.
> **The goal remains: once code is generated, you own it and should adapt it to your needs.**

### 2.1 Entry point and invocation

`Signum/CodeGeneration/CodeGenerator.cs:5-30` — a facade with three **mutable static** generator
instances (that's the customization hook) and a `ConsoleSwitch` menu:

```csharp
public static class CodeGenerator
{
    public static EntityCodeGenerator Entities = new EntityCodeGenerator();
    public static LogicCodeGenerator  Logic    = new LogicCodeGenerator();
    public static ReactCodeGenerator  React    = new ReactCodeGenerator();

    public static void GenerateCodeConsole()
    {
        while (true)
        {
            var action = new ConsoleSwitch<string, Action>("What do you want to generate today?")
            {
                {"E", Entities.GenerateEntitiesFromDatabaseTables, "Entities (from Database tables)"},
                {"L", Logic.GenerateLogicFromEntities,             "Logic (from entites)"},
                {"R", React.GenerateReactFromEntities,             "React (from entites)"},
            }.Choose();
            if (action == null) return;
            action();
            if (action == Entities.GenerateEntitiesFromDatabaseTables) return;   // entities invalidate the loaded assembly
        }
    }
}
```

`GenerateCodeConsole()` has **no in-repo callers** — it is invoked from the *application's*
`<App>.Terminal` console menu (per `LegacyDatabase.AdventureWorks.md`: *"run the `AdventureWorks.Terminal`
application and choose `[G]enerate` -> `[E]ntities`"*). Customization is documented as assigning the
statics at the top of the app's `Main`:

```csharp
static void Main(string[] args)
{
   CodeGenerator.Entities = new AdventureWorksEntityCodeGenerator();
   ...
}
```

Solution discovery is by regex over `Environment.CurrentDirectory`, and is **Windows-only**
(`CodeGenerator.cs:32-41`):

```csharp
var m = Regex.Match(Environment.CurrentDirectory,
    @"(?<solutionFolder>.*)\\(?<solutionName>.*).Terminal\\bin\\(Debug|Release)", RegexOptions.ExplicitCapture);
if (!m.Success)
    throw new InvalidOperationException("Unable to GetSolutionInfo from non-standart path " + ... + ". Override GetSolutionInfo");
```

Module grouping is interactive: `CodeGenerator.GetModules` (`:43-66`) repeatedly shows a multi-select
`ConsoleSwitch` of remaining types, proposes a default module name derived from the common namespace
suffix (`GetDefaultModuleName`, `:68-80`), and yields `Module(ModuleName, List<Type>)` (`:83-93`).

### 2.2 `EntityCodeGenerator` (984 LOC) — legacy DB → C# entities

Reads the live schema (`GetTables()` → `SysTablesSchema.GetDatabaseDescription` or
`PostgresCatalogSchema.GetDatabaseDescription`, `:66-71`), builds an inverse FK graph
(`InverseGraph`, `:30-31`) so it can discover MLists, groups tables by `GetFileName(t)` → one `.cs` per
group written under `<solutionFolder>/<solutionName>/<ModuleName>/<EntityName>.cs`
(`:78-88`, `:22-57`). Emits `[EntityKind]`, `[TableName]`, `[PrimaryKey]`, `[TicksColumn]`,
`[SqlDbType]`, `[ColumnName]`, `[StringLengthValidator]`, `[NotNullValidator]`, `[PreserveOrder]`,
`[BackReferenceColumnName]`, embedded entities, enums with ids/descriptions read from the table rows,
`ToString()`, multi-column-index comments, and an `[AutoInit]` operations class.
Overwrites are guarded by `SafeConsole.Ask(ref overwriteFiles, "Overwrite {0}?")` (a *remembered* answer).

The docs advertise ~55 `protected virtual` extension points; the actual count of `virtual` members is
**56** (`GetTables`, `GetFileName`, `GetModuleName`, `WriteEntity`, `WriteEnum`, `WriteField`,
`WriteFieldMList`, `GetMListInfo`, `IsVirtualMList`, `GetEntityKind`, `GetEntityData`, `Singularize`,
`GetSqlDbTypeParts`, `IsLite`, `HasUniqueIndex`, …). `EntityCodeGenerator.md` documents the full call
tree explicitly as the extension contract.

### 2.3 `LogicCodeGenerator` (614 LOC) — entities → `*Logic.cs`

`CandidateTypes()` reflects over the entities assembly for non-abstract `Entity` subclasses, groups into
modules, and writes `<Module>Logic` with a canonical `Start(SchemaBuilder sb)`
(`LogicCodeGenerator.cs:98-250`). The emitted shape:

```csharp
public static void Start(SchemaBuilder sb)
{
    if (sb.AlteryDefined(MethodInfo.GetCurrentMethod()))    // sic — typo in the generator, :167
        return;
    ...
}
```

`WriteInclude` (`:230-248`) is the canonical fluent registration, assembled from optional parts:

```csharp
return new[]
{
    "sb.Include<" + type.TypeName() + ">()",
    GetWithVirtualMLists(type),
    save   != null && ShouldWriteSimpleOperations(save)   ? "   .WithSave("   + save.Symbol   + ")" : null,
    delete != null && ShouldWriteSimpleOperations(delete) ? "   .WithDelete(" + delete.Symbol + ")" : null,
    simpleExpressions.HasItems() ? simpleExpressions.ToString(e =>
        $"   .WithExpressionFrom(({e.FromType.Name} {GetVariableName(e.FromType)}) => {GetVariableName(e.FromType)}.{e.Name}())", "\n") : null,
    p == null ? null : $"   .WithQuery(() => {p} => {WriteQueryConstructor(type, p)})"
}.NotNull().ToString("\n") + ";";
```

Plus `QueryLogic.Expressions.Register(...)` lines (`:220-228`), `[AutoExpressionField]` expression
methods (`WriteExpressionMethod`, `:354`), and full `Graph<T>.Execute/Delete/ConstructFrom/
ConstructFromMany/Construct` operation blocks when the simple `.WithSave/.WithDelete` form doesn't
apply (`:450-600`). 33 `virtual` members.

It also detects **virtual MLists** by finding a back-reference property on the child type
(`GetVirtualMListBackReference`, `:411`; `IsVirtualMListBackReference`, `:429`).

### 2.4 `ReactCodeGenerator` (589 LOC) — entities → `.tsx` + client + controller

Per module it emits: a `<Module>Client.tsx`, a typings file, an optional `<Module>Server.cs`, an optional
`<Module>Controller.cs` (both gated on `SafeConsole.Ask`), and one `Templates/<Entity>.tsx` per type
(`:15-84`). Crucially it is **incremental**: if the module folder already exists it *patches* the
existing client file — inserting `Navigator.addSettings(...)` after the last existing one (or before
`export function start`) and merging the entity names into an existing `import { … } from './<Namespace>'`
line via regex, rather than overwriting (`:30-60`).

Generated client shape (`:317-390`):

```csharp
sb.AppendLine("import { Navigator } from '@framework/Navigator'");
sb.AppendLine("import { EntityOperationSettings } from '@framework/Operations'");
sb.AppendLine("import { Operations } from '@framework/Operations'");
// import { Foo, Bar } from './Namespace'
sb.AppendLine("export namespace " + mod.ModuleName + "Client" + " {");
//   export function start(options: { routes: RouteObject[] }) {
//     Navigator.addSettings(new EntitySettings(FooEntity, f => import('./Templates/Foo')));
//     //Operations.addSettings(new EntityOperationSettings(MyEntityOperations.Save, {}));
//   }
```

Generated component (`WriteEntityComponentFile`, `:406-441`) computes its own import list by regexing the
control names out of the generated body, then:

```csharp
sb.AppendLine("export default function {0}(p: {{ ctx: TypeContext<{1}> }}): React.ReactElement {{"...);
//   var ctx = p.ctx;
//   return (<div> …lines… </div>);
```

Per-property dispatch (`WriteProperty`, `:443-458`) → `WriteAutoLine` / `WriteEntityProperty` /
`WriteEmbeddedProperty` / `WriteMListProperty` / `WriteValueLine`, with a remembered
`SafeConsole.Ask(ref autoLineMemo, "Use <AutoLine /> ?")` toggle. The `AutoLine` form is a one-liner:

```csharp
return "<AutoLine ctx={{ctx.subCtx({0} => {0}.{1})}} />".FormatWith(v, pi.Name.FirstLower());
```

### 2.5 `SqlServerToPostgresMigration` (415 LOC)

Not a code generator — a **data**-migration utility (`MigrateToPostgres(postgresConnectionString,
MigrateToPostgresOptions?)`, `:26`). Asserts the current connector is `SqlServerConnector`, detects the
Postgres version, builds a `PostgreSqlConnector` with transport security + arrays, and bulk-copies
tables (`BatchSize = 10000`), with hooks `IsSysStartDate`/`IsSysEndDate`/`CleanDataTable`/`ExecuteAs`.
Reachable only from application code.

### 2.6 Customizability summary

Every generator is a plain class with `virtual` everything and no DI; you subclass, override, and assign
to `CodeGenerator.Entities/Logic/React`. `LegacyDatabase.AdventureWorks.md` (521 lines) is a full worked
example showing overrides of `GetTables` (to inject synthetic PKs/FKs), `ShouldWriteExpression`,
`GetModules` (grouping by namespace instead of interactively), etc. Note that doc still references a
`CodeGenerator.Windows` and a `ReactCodeConverter` that no longer exist in the code — the docs have drifted.

---

## 3. `Signum.TSGenerator/` — C# entity assemblies → TypeScript

7 files; the substance is `Program.cs` (~190 LOC) and `EntityDeclarationGenerator.cs` (868 LOC).
`Signum.TSGenerator.csproj`: `OutputType=Exe`, net10.0, `StartupObject=Signum.TSGenerator.Program`,
`Version=10.0.3`, `NuSpecFile=Signum.TSGenerator.nuspec`, `RollForward=LatestMajor`, and
`PackageReference Mono.Cecil 0.11.3`.

### 3.1 Wiring — an `Exec` from a NuGet `.targets`, not an MSBuild `Task`

Despite the name, it is **not** an `ITask`; it's an out-of-proc `dotnet <dll>` invocation.
`Signum.TSGenerator/Signum.TSGenerator.targets`:

```xml
<PropertyGroup Condition="'$(CompileTypeScriptDependsOn)' == ''">
  <BuildDependsOn>$(BuildDependsOn); GenerateSignumTS; TSC_BuildAll;</BuildDependsOn>
</PropertyGroup>

<Target Name="GenerateSignumTS" Condition="'$(TSGeneratorDisabled)' != 'true'">
  <WriteLinesToFile File="$(BaseIntermediateOutputPath)SignumReferences.txt" Lines="@(ReferencePath)" Overwrite="true" Encoding="Unicode" />
  <Exec command="dotnet &quot;$(MSBuildThisFileDirectory)Signum.TSGenerator.dll&quot; &quot;@(IntermediateAssembly)&quot; &quot;$(BaseIntermediateOutputPath)SignumReferences.txt&quot; &quot;$(BaseIntermediateOutputPath)SignumContent.txt&quot;" ConsoleToMSBuild="true">
    <Output TaskParameter="ConsoleOutput" PropertyName="OutputOfExec" />
  </Exec>
</Target>

<Target Name="TSC_BuildAll">
  <!-- $(TSC_Build) == 'true' → yarn tsc -b <proj>/tsconfig.json --pretty false ;  == 'tsgo' → yarn tsgo -b … -->
</Target>
```

The reference set is passed as a *file* of paths (the classic MSBuild→exe hand-off). Opt out with
`<TSGeneratorDisabled>true</TSGeneratorDisabled>`; `Signum/Signum.csproj:10` sets it to `false`
explicitly. `TSC_Build` selects stable `tsc` vs. the native `tsgo` preview — and
`Upgrade_20260710_TypeScript7Stable` is exactly the upgrade script that flips that property in an app.

### 3.2 Contract: `.t4s` files drive output

`Program.cs`:
* `GetAllT4SFiles` recursively collects `*.t4s`, skipping `obj bin node_modules ts_out`.
* Determines which namespaces *should* export TS via `EntityDeclarationGenerator.GetAllTSTypes(options)`.
* A `.t4s` with no exporting namespace is a **build error** `STSG0002: t4s file not needed, Namespace {X} does not export typescript types`; a missing one is **auto-created empty** at a path inferred from the namespace (`Automatically creating {newT4S}`).
* For each namespace: `WriteNamespaceFile(...)` → written to `Path.ChangeExtension(t4sFile, ".ts")`, skipped if byte-identical ("Skipping … (Up to date)").
* Incrementality: a `SignumUpToDate.txt` next to the intermediate assembly holding
  `<lastWriteUtc> <fileName>` lines for the assembly + all `.t4s`; identical content ⇒ immediate exit.
* Errors surface as MSBuild-parseable `path:error STSG0001:<message>`.

There are **85 `.t4s` files** in the repo. The `.t4s` file is a *template prologue*: its literal content
is copied into the head of the generated `.ts`, after the framework imports. Generated `.ts` files are
git-ignored (`.gitignore` contains `*.js`, `**/ts_out/**`; the `.ts` outputs are untracked —
`git ls-files Extensions/Signum.Files/` lists `Changelog.ts` but not `Signum.Files.ts`).

### 3.3 What it emits — concrete input → output

`EntityDeclarationGenerator.GetAllTSTypes` (`:72-180`) selects, per assembly module:
* classes where `type.InTypeScript() ?? IsModifiableEntity(type)` → `EntityInTypeScript`
* interfaces where `InTypeScript() ?? inherits IEntity` → `EntityInTypeScript`
* symbol containers → `SymbolInTypeScript`
* enums where `InTypeScript() ?? usedEnums.Contains(type)` → `EnumInTypeScript`
* `*Message` static classes → `MessageInTypeScript`; `*Query` → `QueryInTypeScript`
* externally-referenced enums/messages land in a synthetic `<Assembly>.External` namespace
* `[ImportInTypeScript]` assembly attributes pull in extra types (`:80`)
* properties are skipped when `[HiddenProperty]`, `[ExpressionField]`, `[AutoExpressionField]` (`:467`)
* `[InTypeScript(true/false)]` on a type or property is the explicit override (`InTypeScript()`, `:487`)

Header of every generated file (`:196-205`):

```ts
//////////////////////////////////
//Auto-generated. Do NOT modify!//
//////////////////////////////////

import { MessageKey, QueryKey, Type, EnumType, registerSymbol } from '../../Signum/React/Reflection'
import * as Entities from '../../Signum/React/Signum.Entities'
import * as Basics from '../../Signum/React/Signum.Basics'
import * as Operations from '../../Signum/React/Signum.Operations'
```

Cross-namespace/assembly references are resolved to relative import paths with generated variable names
(`RelativeName`, `:642`; `GetNamespaceReference`, `:696`).

**Worked example.** Input `Extensions/Signum.Files/FileEntity.cs`:

```csharp
namespace Signum.Files;

[EntityKind(EntityKind.SharedPart, EntityData.Transactional), TicksColumn(false)]
public class FileEntity : ImmutableEntity, IFile
{
    [StringLengthValidator(Min = 3, Max = 254)]
    public string FileName { get; set; }

    [NotNullValidator(DisabledInModelBinder = true)]
    public string Hash { get; private set; }

    byte[] binaryFile;
    public byte[] BinaryFile { get => binaryFile; set { if (Set(ref binaryFile, value)) Hash = CryptorEngine.CalculateMD5Hash(binaryFile); } }
    public override string ToString() => ...
}
```

Output in `Extensions/Signum.Files/Signum.Files.ts` (generated; `Type<T>` const + interface pair, note
`"File"` — the *clean* type name, not the class name):

```ts
export const FileEntity: Type<FileEntity> = new Type<FileEntity>("File");
export interface FileEntity extends Entities.ImmutableEntity {
  Type: "File";
  fileName: string;
  hash: string;
  binaryFile: string /*Byte[]*/;
}
```

Other emitted shapes from the same file, showing all four generators:

```ts
export const FilePathEmbedded: Type<FilePathEmbedded> = new Type<FilePathEmbedded>("FilePathEmbedded");
export interface FilePathEmbedded extends Entities.EmbeddedEntity {
  Type: "FilePathEmbedded";
  fileName: string;  binaryFile: string /*Byte[]*/;  hash: string | null;
  fileLength: number;  suffix: string;  fileType: FileTypeSymbol;
}

export namespace FileMessage {                                    // from a *Message static class
  export const DownloadFile: MessageKey = new MessageKey("FileMessage", "DownloadFile");
  export const ErrorSavingFile: MessageKey = new MessageKey("FileMessage", "ErrorSavingFile");
  // … 24 more
}

export namespace FilePathOperation {                              // from an [AutoInit] symbol container
  export const Save : Operations.ExecuteSymbol<FilePathEntity> = registerSymbol("Operation", "FilePathOperation.Save");
}

export const FileTypeSymbol: Type<FileTypeSymbol> = new Type<FileTypeSymbol>("FileType");
export interface FileTypeSymbol extends Basics.Symbol { Type: "FileType"; }
```

And the hand-written prologue in `Extensions/Signum.Files/Signum.Files.t4s` (interfaces + client-only
fields like `__uploadingOffset`, `__abortController`) is copied verbatim above all of that — that's how
you inject TS-only members and interface augmentation into a generated file.

Enum / query emission (`EntityDeclarationGenerator.cs:240-292`):

```csharp
sb.AppendLine($"export const {type.Name}: EnumType<{type.Name}> = new EnumType<{type.Name}>(\"{type.Name}\");");
sb.AppendLine($"  export const {field.Name}: MessageKey = new MessageKey(\"{type.Name}\", \"{field.Name}\");");
sb.AppendLine($"  export const {field.Name}: QueryKey   = new QueryKey(\"{type.Name}\", \"{field.Name}\");");
sb.AppendLine($"  export const {field.Name} : {propertyType} = registerSymbol(\"{cleanType}\", \"{type.Name}.{field.Name}\");");
```

Generic entities get `Type<T>`/`EnumType<T>` constraint parameters (`:344`).

---

## 4. `Signum.MSBuildTask/` — post-compile IL weaving

`Signum.MSBuildTask/Signum.MSBuildTask.csproj`: `OutputType=Exe`, net10.0, `Version=9.0.0`
(NuGet is referenced as `10.0.0`), `Mono.Cecil 0.11.4`. Again **not** an `ITask` — same `Exec` pattern,
but hooked `AfterTargets="AfterCompile"` (`Signum.MSBuildTask.targets`):

```xml
<Target Name="SignumAfterCompile" AfterTargets="AfterCompile" Outputs="$(TargetPath)">
  <WriteLinesToFile File="$(BaseIntermediateOutputPath)SignumReferences.txt" Lines="@(ReferencePath)" Overwrite="true" Encoding="Unicode" />
  <Exec command="dotnet &quot;$(MSBuildThisFileDirectory)Signum.MSBuildTask.dll&quot; &quot;@(IntermediateAssembly)&quot; &quot;$(BaseIntermediateOutputPath)SignumReferences.txt&quot;" ConsoleToMSBuild="false" />
</Target>
```

`Program.cs:36-71` reads the intermediate assembly in-memory (with PDB if present), runs three rewriters,
then re-writes the assembly and stamps it:

```csharp
bool errors = false;
errors |= new ExpressionFieldGenerator(assembly, resolver, log).FixAutoExpressionField();
errors |= new FieldAutoInitializer(assembly, resolver, log).FixAutoInitializer();
errors |= new AutoPropertyConverter(assembly, resolver).FixProperties();
if (errors) return -1;
MarkAsProcessed(assembly, resolver);
assembly.Write(intermediateAssembly, new WriterParameters { WriteSymbols = hasPdb, SymbolWriterProvider = ... });
```

Idempotence is an assembly-level `[GeneratedCode("SignumTask", <version>)]` attribute checked by
`AlreadyProcessed` (`:83-91`) and added by `MarkAsProcessed` (`:93-106`).

### 4.1 `ExpressionFieldGenerator` (463 LOC) — `[AutoExpressionField]` → hidden static `Expression<T>` field

This is the framework's headline compile-time trick. It finds every method *and* property getter carrying
`Signum.Utilities.AutoExpressionFieldAttribute` (`FixAutoExpressionField`, `:53-70`), synthesises a
`private static Expression<...> <Name>Expression` field (`:73-79`), moves the body's
`As.Expression(() => …)` lambda into it, and rewrites the member to read the field — so the Signum LINQ
provider can translate the member into SQL. It also handles the older
`ExpressionFieldAttribute` (pointing at an explicitly-declared static field) and reports mismatches as
build errors. Cecil references it pre-resolves: `Type.GetTypeFromHandle`, `Expression.Parameter`,
`Expression.Lambda<T>`, `Array.Empty`, `ParameterExpression` (`:44-50`).

### 4.2 `FieldAutoInitializer` (155 LOC) — `[AutoInit]` symbol containers

For every type carrying `Signum.Entities.AutoInitAttribute`, it generates the static initializer that
assigns each `readonly` symbol field (e.g. `ExecuteSymbol<FooEntity> Save`) a value derived from the
declaring type + field name, incl. the nested `OperationSymbol.Construct<T>` case (`:36-39`). This is why
the `entity` snippet's `[AutoInit] public static class FooOperation { public static readonly ExecuteSymbol<FooEntity> Save; }`
compiles with *no assignment* and still works at runtime.

### 4.3 `AutoPropertyConverter` (128 LOC) — auto-properties → `Get`/`Set` on `ModifiableEntity`

For every `ModifiableEntity` subclass it rewrites property accessors to call
`ModifiableEntity.Get`/`ModifiableEntity.Set` instead of touching the backing field directly
(`:23-26`, `FixProperties`, `:67`). That is what makes plain `public string FileName { get; set; }` in an
entity participate in change tracking / notification / property-route validation — the single most
important reason generated Signum entity code looks like ordinary POCO code.

---

## 5. `Signum.TSCBuild/` — VSIX for fast TypeScript builds

A Visual Studio 2022–2026 extension (`InstallationTarget [17.0, 19.0)`, Community/Pro/Enterprise, MIT
licensed, own `Signum.TSCBuild.sln`). Purpose, verbatim from `source.extension.vsixmanifest`:

> Adds a "Build TypeScript" context menu to each .csproj in Solution Explorer, which runs `tsc -b` using
> the `tsconfig.json` in the same project.
> Calling tsc once is much faster than running Microsoft.TypeScript.MSBuild nuget for each project,
> making it useful for solutions structured with 'vertical modules' (such as the Signum Framework),
> where many reusable projects contain both C# and TypeScript code.

Two commands share `CommandSet 57018ec6-5e1b-4ac7-8226-30120d45e7c0`:
* `CompileTypeScript.cs` — `CommandId 0x0100` (solution-wide) and `BuildTypeScriptCommandId 0x0111`
  (per-csproj, `BeforeQueryStatus` → visible only when a single `.csproj` is selected). Parses tsc output
  into the VS Error List via `ErrorListProvider`, and tracks progress across projects
  (`totalProjects`/`completedProjects`/`projectList`).
* `RunTSGenerator.cs` — `RunTSGeneratorCommandId 0x0112`, invokes the TSGenerator target on demand via
  `Microsoft.Build.Execution.BuildManager` (cf. `README.md:58` "2025.12.15 Run TSGenerator on demand").

`Signum.VSIX/` is the older/thinner twin: same GUID `CommandSet`, only `CompileTypeScript`, no
`RunTSGenerator`, identity `Signum.VSIX.7b6cb8f6-…`, description still the template placeholder
*"Empty VSIX Project."*. It looks superseded by `Signum.TSCBuild`. Notably **neither VSIX packages the
snippets** — no `Snippet` asset in either `.vsixmanifest`/`.csproj`; `Snippets/` and `SnippetsTS/` are
copied by hand into the VS user snippets folder.

---

## 6. `Signum.Analyzer/` — the codified coding rules

netstandard2.0, `PackageId Signum.Analyzer`, `PackageVersion 3.2.0`, MIT,
`Microsoft.CodeAnalysis.CSharp.Workspaces 3.11.0`, packed to `analyzers/dotnet/cs`. Own solution +
`Signum.Analyzer.Test` project with per-rule tests (`AutoExpressionFieldTest.cs`, `ExpressionFieldTest.cs`,
`LiteCastTest.cs`, `LiteEqualiyTest.cs`). `AnalyzerReleases.Unshipped.md` is empty.

From `Signum.Analyzer/Signum.Analyzer/AnalyzerReleases.Shipped.md` plus the descriptors in source:

| ID | Category | Severity | Analyzer | Title / message | Fix? |
|---|---|---|---|---|---|
| `SF0001` | Expressions | Warning | `AutoExpressionFieldAnalyzer.cs:18` | "Call `As.Expression` in a method or property with `AutoExpressionFieldAttribute`" — `'{0}' should call As.Expression(() => ...) ({1})` | yes — `AutoExpressionFieldFixProvider.cs` |
| `SF0002` | Expressions | Warning | `ExpressionFieldAnalyzer.cs:18` | "Use `ExpressionFieldAttribute` in non-trivial method or property" — `'{0}' should reference an static field of type Expression<T> with the same signature ({1})` | no |
| `SF0003` | Lite | Error | (`LiteEqualityAnalyzer`, superseded by SF0031-34 in 3.2) | — | — |
| `SF0004` | Lite | Error | `LiteCastAnalyzer.cs:19,26` | "Prevents direct conversion from `Lite<T>` to `T`" → *"consider using Entity or Retrieve"*; and `T` → `Lite<T>` → *"consider using ToLite or ToLiteFat"* | no |
| `SF0031` | Lite | Warning | `LiteEqualityAnalyzer.cs:17` | "Prevents unintended reference comparison between two `Lite<T>`" — *"consider using 'Is' extension method"* | yes — `LiteEqualityCodeFixProvider.cs` |
| `SF0032` | Lite | Warning | `LiteEqualityAnalyzer.cs:24` | "Prevents unintended reference comparison between two Entities" | yes |
| `SF0033` | Lite | Error | `LiteEqualityAnalyzer.cs:31` | "Prevents comparisons between `Lite<T>` and `T`" — *"Impossible to compare"* | yes |
| `SF0034` | Lite | Error | `LiteEqualityAnalyzer.cs:38` | "Prevents comparisons between `Lite<A>` and `Lite<B>`" — `Impossible to compare Lite<{0}> and Lite<{1}>` | yes |

Release history: 2.7 introduced SF0001-0004; 3.0 and 3.1 fixed SF0004 pattern-matching (incl. `case`
statements/expressions); 3.2 split the old SF0003 into SF0031-0034.

The rationale is stated in the descriptors themselves — `Lite<T>` is an *interface* to obtain covariance,
so C# will happily compile comparisons and casts that can never succeed:

> "Checks direct conversion from `Lite<T>` to `T`. C# doesn't catch this because `Lite<T>` is implemented
> as an interface to have co-variance."

`SF0001`'s description is the clearest statement anywhere of the expression-field contract:

> "A Property or Method can use `AutoExpressionFieldAttribute` and `As.Expression(() => ...)` to extract
> their implementation to a hidden static field with the expression tree, that will be used by Signum
> LINQ provider to translate it to SQL."

`SF0001` validation logic (`AutoExpressionFieldAnalyzer.cs:35-80+`) also rejects `void` return types
("no return type"), `ref`/`out`/`in` parameters ("complex parameter 'x'"), and bodies that are not a
single `As.Expression(...)` invocation ("no As.Expression", flagged `fixable: true`).

**Consequence for any code generator:** generated C# must (a) use `[AutoExpressionField]` +
`As.Expression(() => …)` for computed members, (b) never compare or cast `Lite<T>`/`T` directly — always
`.Is(...)`, `.ToLite()`, `.ToLiteFat()`, `.Entity`, `.Retrieve()`. The existing generators already comply
(`LogicCodeGenerator.WriteExpressionMethod`; the `expressionMethodQuery` snippet uses `.Is(...)`).

---

## 7. `Snippets/` + `SnippetsTS/` — the canonical-shape catalogue

34 files in `Snippets/` (29 `.snippet` + 4 `.vssettings` font themes + `Signum.Framework.DotSettings`
for ReSharper/Rider) and 15 `.snippet` in `SnippetsTS/`. Plain VS `.snippet` XML with `$placeholder$`
tokens — no packaging, installed by copying.

### 7.1 C# snippets (`Snippets/`)

| Shortcut | File | Scaffolds |
|---|---|---|
| `entity` | entity.snippet | `[EntityKind(Main, Transactional)] class XEntity : Entity` **+** `[AutoInit] static class XOperation { ExecuteSymbol<XEntity> Save; DeleteSymbol<XEntity> Delete; }` |
| `entityWithName` | entityWithName.snippet | same, with a `Name` field |
| `embeddedEntity` | embeddedEntity.snippet | `class XEmbedded : EmbeddedEntity` |
| `modelEntity` | modelEntity.snippet | `class XModel : ModelEntity` + `[StringLengthValidator(Min=3,Max=100)] string Name` |
| `mixinEntity` | mixinEntity.snippet | `class XMixin : MixinEntity` with `(ModifiableEntity, MixinEntity?)` ctor + commented `CopyFrom` |
| `field` | field.snippet | `public $type$ $property$ { get; set; }` |
| `fieldString` | fieldString.snippet | `[StringLengthValidator(Max = $size$)] public string P { get; set; }` |
| `fieldLite` | fieldLite.snippet | `public Lite<$type$> P { get; set; }` |
| `fieldMlist` | fieldMList.snippet | `[PreserveOrder, NoRepeatValidator] public MList<T> P { get; set; } = new MList<T>();` |
| `fieldCreation` | fieldCreation.snippet | field with automatic creation date |
| `fieldEuro` | fieldEuro.snippet | decimal amount in euros |
| `logic` | logic.snippet | `static class XLogic { Start(SchemaBuilder sb) { if (sb.AlreadyDefined(MethodBase.GetCurrentMethod())) return; sb.Include<XEntity>().WithSave(...).WithDelete(...).WithQuery(() => x => new { Entity = x, x.Id, x.… }); } }` |
| `start` | start.snippet | bare `Start(SchemaBuilder sb)` with the `AlreadyDefined` guard |
| `include` | include.snippet | the `sb.Include<…>().WithSave().WithDelete().WithQuery()` chain alone |
| `graph` | graph.snippet | `class XGraph : Graph<XEntity, XState>` with `GetState`, `new Execute(...) { FromStates, ToStates, CanBeNew, CanBeModified, Execute }`, `new Delete(...)` |
| `save` | save.snippet | `new Graph<XEntity>.Execute(XOperation.Save) { CanBeNew = true, CanBeModified = true, Execute = (x,_) => { } }.Register();` |
| `delete` | delete.snippet | `new Graph<XEntity>.Delete(XOperation.Delete) { Delete = (x,_) => { x.Delete(); } }.Register();` |
| `expressionProperty` | expressionProperty.snippet | `[AutoExpressionField] public $returnType$ $propertyName$ => As.Expression(() => …);` |
| `expressionMethod` | expressionMethod.snippet | extension method with LINQ support |
| `expressionMethodQuery` | expressionMethodQuery.snippet | `[AutoExpressionField] static IQueryable<R> M(this T t) => As.Expression(() => Database.Query<R>().Where(r => r.T.Is(t)));` |
| `expressionToString` | expressionToString.snippet | `ToString` expression that removes the `toStr` column |
| `query` | query.snippet | `Database.Query<XEntity>()` |
| `registerQuery` | registerQuery.snippet | `QueryLogic.Queries.Register(typeof(XEntity), () => from x in Database.Query<XEntity>() select new { Entity = x, x.Id, … });` |
| `mlistQuery` | mlistQuery.snippet | query against an MList table |
| `unsafeUpdate` | unsafeUpdate.snippet | `Database.Query<X>().Where(...).UnsafeUpdate().Set(x => x.P, x => …).Execute();` |
| `unsafeUpdateMList` | unsafeUpdateMList.snippet | same for MLists |
| `synchronize` | synchronize.snippet | full `Synchronizer.Synchronize(newDictionary, oldDictionary, createNew, removeOld, merge)` block with coloured console dots, `GraphExplorer.IsGraphModified`, and `BulkInserter.BulkInsertQueryIds` |
| `tran` | tran.snippet | `using (var tr = new Transaction()) { … tr.Commit(); }` |
| `tranNC` | tranNC.snippet | transaction without commit (unit tests) |
| `wait` | consoleSafeWrite.snippet | `SafeConsole.WaitRows` |

### 7.2 TS/React snippets (`SnippetsTS/`)

| Shortcut | File | Scaffolds |
|---|---|---|
| `reactFunction` | react.function.snippet | `export function C(p : { ctx: TypeContext<E> }) { return (<div>…</div>); }` |
| `reactClass` / `reactClassProps` / `reactClassState` | react.class*.snippet | legacy class components (implicit props / explicit props / props+state) |
| `reactModal` | react.modal.snippet | full `IModalProps<T>` modal: `useState(true)`, `useRef`, ok/cancel handlers, `onExited`, react-bootstrap `Modal` with `btn-close`, `JavascriptMessage.ok/cancel.niceToString()`, and a static `C.show = (…) => openModal<T>(<C … />)` |
| `entityTable` | entityTable.snippet | `<EntityTable ctx={ctx.subCtx(p => p.X)} columns={EntityTable.typedColumns<T>([{ property: p => p.Y, headerHtmlAttributes: { style: { width: "30%" } } }])} />` |
| `sc` | searchControl.snippet | `<h3>{T.nicePluralName()}</h3>` + `<SearchControl findOptions={{ queryName: T, filterOptions: [{ token: T.token(a => a.X), value: ctx.value }] }} />` |
| `svl` | searchValueLine.snippet | `{!ctx.value.isNew && <SearchValueLine ctx={ctx} findOptions={{…}} />}` |
| `fo` | findOptions.snippet | the bare `{ queryName: T, filterOptions: [{ token: T.token(a => a.X), value: ctx.value }] }` |
| `row2` / `row3` / `rowAuto` | row*.snippet | Bootstrap `row` with two `col-sm-6` / three `col-sm-4` / three `col-auto` |
| `useState` / `useRef` / `useVersion` | use*.snippet | hooks, incl. the Signum-specific `const [v, updateV] = useVersion();` |

These 44 snippets are the single best inventory of "what idiomatic Signum code looks like", and they
overlap heavily with what `LogicCodeGenerator`/`ReactCodeGenerator` emit — `include.snippet` vs.
`LogicCodeGenerator.WriteInclude`, `expressionProperty.snippet` vs. `WriteExpressionMethod`,
`react.function.snippet` vs. `WriteEntityComponentFile`, `searchControl.snippet` vs. the client file.
Two independent implementations of the same templates.

---

## 8. `Utils/CheckUrl/` — deployment smoke-check

`Utils/CheckUrl/CheckUrl/Program.cs` (~70 LOC, net10.0, no dependencies) plus a prebuilt
`Utils/CheckUrl.exe` committed to the repo.

```
Usage: CheckUrl alive/dead "http://www.google.com" 10
```

Polls the URL with `HttpClient.GetAsync` every 10 s, up to `retry` times (default 15), colour-printing
`GET <url> … 200 (OK)`; returns when `IsSuccessStatusCode == alive`, throws
`ApplicationException("Timeoout")` on exhaustion. Swallows `HttpRequestException`/`TaskCanceledException`
as red output and keeps retrying.

Its only consumer is a **generated deployment script**: `Upgrade_20210908_BlueGreenDeployments.cs:64-84`
writes PowerShell containing `.\Framework\Utils\CheckUrl.exe dead $urlSlot` /
`alive $urlSlot` / `alive $url` to gate an Azure blue-green slot swap. A nice illustration of the pattern
"upgrade script emits ops tooling into the target app".

---

## 9. Cross-cutting observations relevant to building a CLI

1. **Two disjoint execution contexts.** `Signum.Upgrade` operates on *text on disk* and needs nothing to
   compile. `Signum/CodeGeneration` operates on *loaded assemblies + a live `Schema`* and therefore must
   run inside the application's own `*.Terminal` process. Any unified CLI has to either shell out to the
   app's Terminal or reimplement generation from Roslyn/DB metadata instead of reflection.
2. **Convention over configuration, encoded as string concatenation.** `<App>.Entities`, `<App>.Logic`,
   `<App>.Terminal`, `<App>.React`, `<App>.Server`, `<App>.Test.*`; a `Framework/` submodule; exactly one
   `.sln`; the literal token `Southwind`. There is **no manifest file** describing a Signum application.
   `SignumUpgrade.txt` is the only piece of tool state in an app.
3. **Console UX primitives already exist and are good**: `Signum.Utilities/SafeConsole.cs`
   (`WriteLineColor`, `Ask`, `Ask(ref bool?, …)` remembered answers, `AskString` with validator,
   `AskRetry`, `AskSwitch`, `WaitRows`, `WaitQuery`, `WaitExecute`) and
   `Signum.Utilities/ConsoleSwitch.cs` (`Add(key, value, description)`, separators, `Choose`,
   `ChooseMultiple`, paging with `+`, `Load(collection, getString)`, `ChooseConsole` extension).
   A new CLI should reuse these for parity of feel.
4. **Windows/VS-centric assumptions** to be careful with: `CodeGenerator.GetSolutionInfo`'s
   `\\…\\bin\\(Debug|Release)` regex, `SolutionRenamer`'s `Directory.Move` error handling, the two VSIX
   projects, `CheckUrl.exe` as a committed binary, `.sln` text surgery (no `dotnet sln` usage anywhere).
5. **Quality signal**: `Signum.Upgrade`'s own code is `Nullable enable` with `WarningsAsErrors`, but has
   never been refactored — dead renamers, a commented-out call site, a bodyless `if`, a typo'd
   `sb.AlteryDefined` in the logic generator, and docs referencing removed classes
   (`ReactCodeConverter`, `CodeGenerator.Windows`). The *upgrade scripts* are the maintained asset; the
   host is a means to an end.
6. **The framework's rules are machine-checkable already** (8 Roslyn diagnostics, 4 with code fixes).
   A generator can be validated by compiling its output with `Signum.Analyzer` referenced.

---

## Prior art for a Signum CLI

**What already exists.** `Signum.Upgrade` is a complete, 6-year-old, 223-script **source-code migration
engine** with a git-backed safety model (clean-tree gate, one commit per upgrade, `SignumUpgrade.txt`
ledger, retry loop) and an excellent domain-aware editing library (`CodeFile`: line/regex/block surgery
plus first-class npm, NuGet, TypeScript-import and `.sln` helpers). `Signum/CodeGeneration` is a separate,
deeply overridable generator suite (entities from a legacy DB, `*Logic.cs`, `*Client.tsx` + `Templates/*.tsx`
+ controller) driven by an interactive `ConsoleSwitch` menu inside the app's `*.Terminal`.
`Signum.TSGenerator` + `Signum.MSBuildTask` are build-time codegen/weaving already shipped as NuGets with
`.targets` (both plain `Exec`'d exes, not `ITask`s). `Signum.Analyzer` encodes 8 diagnostics.
44 VS snippets catalogue the canonical shapes. Two VSIXes give VS-only "Build TypeScript" / "Run TSGenerator".

**Gaps a new CLI would fill.**
1. *An actual CLI surface* — verbs, flags, `--help`, exit codes, non-interactive/CI mode, dry-run. Today
   `Signum.Upgrade` ignores `args` entirely and two of its three capabilities are commented-out lines.
2. *`signum new`* — app creation is currently an out-of-repo web page ("duplicate Southwind"), and both
   in-repo renamers are unreachable dead code with known bugs.
3. *Distribution* — nothing is a `dotnet tool`; `Signum.Upgrade` isn't even in the solution.
4. *Unifying the two contexts* — one entry point that can both rewrite files and scaffold
   entity/logic/view triples, instead of "run the exe from the submodule" + "run the app's Terminal".
5. *A manifest* — no file declares an app's project layout, so everything is inferred from folder names
   and the `Southwind` token; a CLI should introduce (or at least tolerate) explicit configuration.
6. *Scaffolding parity with snippets* — `signum add entity/logic/view/operation/mixin/modal` would
   replace hand-copied VS snippets and work outside Visual Studio (VS Code / Rider / agents).
7. *Cross-platform correctness* — replace the Windows-path regexes and `.sln` text surgery.
8. *Machine-readable output* — JSON/SARIF for warnings so agents and CI can consume results.

**What it should reuse.** Keep the upgrade model wholesale: `CodeUpgradeBase` (Key/Description/Execute),
alphabetical-by-`Upgrade_yyyyMMdd_Name` ordering, the `SignumUpgrade.txt` ledger, the clean-tree gate and
one-commit-per-upgrade discipline, and the `WarningLevel` + `Expression<Predicate<string>>` idiom that
turns a missed match into a readable warning rather than a crash. Reuse `CodeFile` as-is — its
`UpdateNugetReferences` / `UpdateNpmPackage` / `Solution_AddProject` /
`ReplaceAndCombineTypeScriptImports` helpers are exactly the primitives a scaffolder needs. Reuse
`SafeConsole` and `ConsoleSwitch` for interactive fallbacks so the tool feels native. Reuse the
generators via their `virtual` override points and the `CodeGenerator.Entities/Logic/React` static
seams rather than rewriting them. Treat `Snippets/` + `SnippetsTS/` as the authoritative template
corpus for a `signum add …` command, and validate every generated file against `Signum.Analyzer`
(SF0001/SF0002 for expression fields, SF0004/SF0031-34 for `Lite<T>`) plus a build that exercises
`Signum.MSBuildTask` and `Signum.TSGenerator`. Finally, reuse the documented authoring workflow from
`Skills/CreatingSignumUpgrades.md` — diff Southwind, write the script — since that is what actually
keeps the 223-script corpus alive.
