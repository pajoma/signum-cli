# Signum Framework — Developer Workflow (build / test / release / consume)

Repo analysed: `/home/patrick.maue/git/sfcl/signum-framework` (read-only).
Fork of `github.com/signumsoftware/framework`; remotes: `origin = pajoma/signum-framework`, `upstream = signumsoftware/framework` (`no_push`). HEAD is a merge of upstream `master`.

> **Machine reality check** (measured, see §7): `dotnet` **NOT installed**, `yarn` **NOT installed**, `psql`/`sqlcmd` **NOT installed**. `node v22.23.1`, `npm 10.9.8`, `docker 29.6.2`, `podman 5.8.2`, `git 2.52.0` are present. Nothing in this report can currently be executed end-to-end on this machine.

---

## 1. Repo topology & the Southwind relationship

### 1.1 How this repo is meant to be consumed: as a git submodule named `Framework/`

This repo is **not a NuGet-distributed library**. It is consumed **as source**, checked out as a git submodule into the folder `Framework/` at the root of an application repo. Evidence, strongest first:

| Evidence | Location |
|---|---|
| `README.md:54`: *"Signum Framework doesn't use any numeric versioning, since is distributed as source code we just use Git commit hashes."* | `README.md:54` |
| `UpgradeContext.GetRootFolder()` walks **up** from cwd until it finds a directory literally called `Framework` — that directory is the framework, its parent is the app root | `Signum.Upgrade/UpgradeContext.cs:34-45` |
| `"Framework"` is in `UpgradeContext.DefaultIgnoreDirectories` — upgrade scripts must never rewrite the submodule | `Signum.Upgrade/UpgradeContext.cs:122` |
| Upgrade script writes into the app's `AGENTS.md`: *"**Framework/** — Signum Framework git submodule (do not modify directly from this repo)."* | `Signum.Upgrade/Upgrades/Upgrade_20260212_UpdateCopilotInstructions3.cs:29` |
| Same, earlier revisions: *"Framework is a git submodule with shared code."* / *"**Framework:** Signum Framework (git submodule at `Framework/`)"* | `Upgrade_20260110_UpdateCopilotInstructions.cs:24`, `Upgrade_20260206_UpdateCopilotInstructionsSimple.cs:30` |
| `AGENTS.md:15`: *"Detailed guidance is organized in `Framework/Skills/`"* — i.e. this file is read **from the app root**, where the framework is at `Framework/` | `AGENTS.md:15`; also `AGENTS.md:11` "Framework\Extensions contains many reusable vertical modules" |
| App `.sln` files reference framework projects by relative path `Framework\Extensions\...` | `Upgrade_20260321_SeleniumToPlaywright.cs:26` (`file.Solution_AddProject(@"Framework\Extensions\Signum.Playwright\Signum.Playwright.csproj", "2.Extensions")`), `Upgrade_20260617_...:46` |
| App `tsconfig.json` extends `../Framework/tsconfig.base.json` | `Upgrade_20250930_TSC.cs:24`, `:37` |
| VS Code launch config points at `${workspaceFolder}/Framework/Signum.Upgrade/bin/Debug/net10.0/Signum.Upgrade.dll` | `Upgrade_20251207_SimplifyVSCode.cs` (launch.json block) |
| `Skills/CreatingSignumUpgrades.md:5`: *"Ignore changes that are only Framework submodule pointer updates."* | `Skills/CreatingSignumUpgrades.md:5` |
| This repo itself has **no** `.gitmodules` — it is the leaf, not the container | verified: no `.gitmodules` |

Note the fork is checked out here as a **standalone** clone at `sfcl/signum-framework`, not as `<app>/Framework`. So `Signum.Upgrade` will **fail** if run from inside this clone (`"Unable to detect Root Folder"`, `UpgradeContext.cs:41`) — it needs a real application repo above it.

### 1.2 Expected on-disk layout of a real Signum application

From `UpgradeContext.cs:112-118` (canonical project names) and `Upgrade_20260212_UpdateCopilotInstructions3.cs:24-31`:

```
MyApp/                             <- git repo root; contains MyApp.sln
├── MyApp.sln                      <- app name is derived from this: UpgradeContext.cs:49-51
├── SignumUpgrade.txt              <- list of applied upgrades, committed (CodeUpgradeRunner.cs:33,58)
├── SignumUpgrade.tsx              <- client-side upgrade marker (Signum.Upgrade/Program.cs:24)
├── Modules.xml                    <- optional/removable module config
├── Directory.Build.props           <- app-level MSBuild props (referenced Upgrade_20250930_TSC.cs)
├── AGENTS.md / CLAUDE.md / .github/copilot-instructions.md  <- all delegate to Framework/AGENTS.md
├── .vscode/{launch.json,tasks.json,settings.json}
├── MyApp/                         <- entities + logic + React, organised per module
│   ├── Starter.cs                 <- central bootstrapping, registers all extensions + modules
│   ├── MainAdmin.tsx              <- imports/starts all module clients
│   ├── Layout.tsx                 <- app shell
│   ├── package.json, tsconfig.json
├── MyApp.Server/                  <- ASP.NET Core host (Microsoft.NET.Sdk.Web)
│   ├── Program.cs                 <- calls Starter.Start()
│   ├── HomeController.cs, Index.cshtml   (moved here by Upgrade_20250930_TSC.cs:21-22)
│   ├── vite.config.js, package.json, tsconfig.json, Dockerfile, .dockerignore
├── MyApp.Terminal/                <- console app: schema sync, migrations, data load
│   └── Migrations/*.sql           <- GENERATED, never hand-edit (AGENTS.md:61)
├── MyApp.Test.Environment/        <- shared test setup + DB config
├── MyApp.Test.Logic/              <- xUnit business-logic tests
├── MyApp.Test.React/              <- Playwright (formerly Selenium) UI tests
│   └── PLAYWRIGHT_MODE.txt
└── Framework/                     <- THIS repo, as a submodule
    ├── Signum/  Signum.Utilities/  Extensions/  Signum.Upgrade/  Skills/  tsconfig.base.json ...
```

`Signum.Utilities`, `Signum`, and each `Extensions/Signum.*` csproj are added **directly to the app's solution** (solution folder `2.Extensions`) and referenced as `ProjectReference`. That is why `Signum.Framework.sln` in this repo lists only 5 projects (`Signum.Framework.sln:6-15`: Signum.Utilities, Signum.Test, Signum.TSGenerator, Signum.MSBuildTask, Signum) — the 58 `Extensions/*.csproj` are in **no** solution here.

### 1.3 What Southwind is

**Southwind** is the reference/demo application — a port of Microsoft's Northwind onto Signum (`README.md:16-17`, `Introduction.md:39-43`). It plays **three** roles:

1. **Reference app / online demo** — `README.md:16`, hosted in Azure.
2. **Project template.** The official "create application" path is *"Create a new project by renaming and customizing Southwind example application"* (`README.md:50`). `Signum.Upgrade` ships `SolutionRenamer.cs` + `ApplicationRenamer.cs` for exactly this; `UpgradeContext.ReplaceSouthwind(val)` / `AbsolutePathSouthwind(name)` textually swap `"Southwind"` → your app name (`UpgradeContext.cs:109`, `:126`, `:217`, `:241-244`).
3. **Source of truth for upgrade scripts.** Every `Signum.Upgrade/Upgrades/Upgrade_*.cs` (≈250 files, `Upgrade_20200920_*` → `Upgrade_20260710_*`) is written against Southwind paths (`"Southwind.Server/package.json"`, `"Southwind.sln"`, …) and re-targeted to your app at runtime. `Skills/CreatingSignumUpgrades.md` is explicit: upgrades are authored **from Southwind commits**, and *"the closer your application resembles Southwind, the better it works"* (`Signum.Upgrade/Program.cs:15`).

Southwind itself is **not in this repo** (`github.com/signumsoftware/southwind`).

### 1.4 What is published vs. consumed as source

**Published to NuGet (3 packages, all built from this repo):**

| Package | Version | Source | Purpose |
|---|---|---|---|
| `Signum.TSGenerator` | 10.0.3 | `Signum.TSGenerator/Signum.TSGenerator.nuspec` | MSBuild target + `dotnet` tool that turns `*.t4s` → `*.ts` |
| `Signum.MSBuildTask` | 10.0.0 | `Signum.MSBuildTask/Signum.MSBuildTask.nuspec` | IL rewriter (auto-properties in entities, `[AutoInit]`, `[ExpressionField]`) |
| `Signum.Analyzer` | 3.2.0 | `Signum.Analyzer/Signum.Analyzer/Signum.Analyzer.csproj:12` (`GeneratePackageOnBuild=True`, `PackageId`, `PackageVersion`) | Roslyn analyzers SF0001–SF0004, SF0031–SF0034 |

All three are consumed **by this repo itself** — `Signum/Signum.csproj:31-33` references `Signum.Analyzer 3.2.0`, `Signum.MSBuildTask 10.0.0`, `Signum.TSGenerator 10.0.3`. Each nuspec packs `bin\Release\net10.0\*.dll` + the `.targets` into `build/`, so the target auto-imports on package restore.

Two **VSIX** extensions (Windows/Visual Studio only, `TargetFrameworkVersion v4.7.2`):
- `Signum.TSCBuild/` — VS commands "Compile TypeScript" (`yarn tsc|tsgo -b <projectDir>/tsconfig.json -v`, `CompileTypeScript.cs:295`) and "Run TSGenerator" (`dotnet build -p:TSGeneratorDisabled=false`, `RunTSGenerator.cs:124`). Marketplace: `SignumSoftware.signumtscbuild` (`Upgrade_20250930_TSC.cs`, final console message).
- `Signum.VSIX/` — packages the code snippets in `Snippets/` (C#: entity, logic, graph, field*, expression*) and `SnippetsTS/` (React: `react.function`, `searchControl`, `useState`, …).

**NOT published to npm.** Every `package.json` here (53 of them: `Signum/package.json` + 52 in `Extensions/`) is `"version": "1.0.0"`, has no `main`/`files`/`publishConfig`, and no `yarn.lock` / `.npmrc` exists anywhere in the repo. They exist purely as **dependency manifests**: the app's `MyApp.Server` runs `yarn install` and yarn (workspaces / resolutions) pulls the union of dependencies. E.g. `Signum/package.json` declares react 19.1.2, react-dom 19.1.2, react-router 7.7.0, bootstrap 5.3.7, react-bootstrap 2.10.10, d3 7.9.0, luxon 3.7.1, `@microsoft/signalr` 10.0.0, `react-widgets-up` 6.0.14, FontAwesome 6.7.2; `Extensions/Signum.HtmlEditor/package.json` adds lexical 0.45.0 + `@lexical/*`; `Extensions/Signum.Chart/package.json` adds `@types/google.maps`.

**Everything else (all C#, all `.ts`/`.tsx`) is consumed as source** via the `Framework/` submodule.

Housekeeping conventions:
- `.gitattributes` is a single line: `* text=auto eol=lf` → **LF for everything**, incl. `.cs`/`.ts` (adopted 2025.05.25, `README.md:70`).
- `.gitignore` ignores `bin`, `obj/`, `*.js`, `*.js.map`, `**/ts_out/**`, `*/node_modules/**` → the TS build output directory is `ts_out/`, and `.js` is never committed.
- Generated `.ts` **are** committed: `git ls-files` shows both `Signum/React/Signum.Entities.t4s` and `Signum/React/Signum.Entities.ts` (164 tracked `.ts` files total).
- `index.mdi` is a 6-line documentation table-of-contents (Introduction, Readme, Signum.Entities, Signum.Engine, Signum.Windows, Signum.Web, Signum.Utilities) — stale (Windows/Web layers are gone); it drives the website's ordering of the ~130 `.md` files that live next to the code (`Signum/Engine/Linq/*.md`, `Signum.Utilities/**/*.md`, …), per `Introduction.md:27`.

---

## 2. Build

### 2.1 Target framework & SDK

- **All** modern projects: `<TargetFramework>net10.0</TargetFramework>` → requires **.NET SDK 10.x**. Confirmed in `Signum/Signum.csproj:3`, `Signum.Utilities/Signum.Utilities.csproj:4`, `Signum.Test/Signum.Test.csproj:4`, `Signum.Upgrade/Signum.Upgrade.csproj:4`, `Extensions/Signum.Chart/Signum.Chart.csproj:4`, `Extensions/Signum.Playwright/Signum.Playwright.csproj:4`, `Extensions/Signum.Extensions.Test/…:4`, `Signum.Analyzer/Signum.Analyzer.Test/…:4`. Upgrade `Upgrade_20251113_Dotnet10.cs` did the blanket `net9.0`→`net10.0` swap (matches `README.md:62` "2025.11.23 .Net 10").
- Exceptions:
  - `Signum.Analyzer/Signum.Analyzer/Signum.Analyzer.csproj:4` → `netstandard2.0`, `LangVersion 11.0` (Roslyn analyzer requirement).
  - `Signum.TSCBuild/Signum.TSCBuild.csproj:22` and `Signum.VSIX/Signum.VSIX.csproj:18` → `TargetFrameworkVersion v4.7.2`, `MinimumVisualStudioVersion 17.0`, `ProjectTypeGuids` VSIX + `Microsoft.VSSDK.BuildTools` → **Windows + Visual Studio 2022 only**.
- `Signum/Signum.csproj:13` uses `<FrameworkReference Include="Microsoft.AspNetCore.App" />` (not the Web SDK), so the core framework library pulls in ASP.NET Core surface without being a web project. Same pattern in `Extensions/Signum.Chart/Signum.Chart.csproj:9`. `Upgrade_20250930_TSC.cs:96-99` performed exactly this switch (`Microsoft.NET.Sdk.Web` → `Microsoft.NET.Sdk` + FrameworkReference) for all non-Server projects.
- `Extensions/Signum.Playwright/Signum.Playwright.csproj:7` pins `<LangVersion>13.0</LangVersion>` and `ImplicitUsings`.

### 2.2 Solutions

| Solution | Contents |
|---|---|
| `Signum.Framework.sln` | 5 projects only: `Signum.Utilities`, `Signum.Test`, `Signum.TSGenerator`, `Signum.MSBuildTask`, `Signum` (`:6-15`). Configurations `Debug\|Any CPU` and `Release\|Any CPU`; note most projects map `Release\|Any CPU` → `Release\|x64` (`:24,27,30,33`) which is a latent inconsistency. `Signum` maps to `Release\|Any CPU` (`:36-37`). |
| `Signum.Analyzer/Signum.Analyzer.sln` | Analyzer + Analyzer.Test |
| `Signum.TSCBuild/Signum.TSCBuild.sln` | VSIX (Windows) |
| `Signum.VSIX/Signum.VSIX.sln` | VSIX (Windows) |
| `Utils/CheckUrl/CheckUrl.sln` | small utility |

**No solution contains `Extensions/`** and **no solution contains `Signum.Upgrade`** — those are built either individually or from the app's solution.

### 2.3 Build commands

```bash
# Framework core (the only self-contained solution)
dotnet build Signum.Framework.sln

# Preferred granularity (AGENTS.md:36 — "avoid compiling the entire solution")
dotnet build Signum/Signum.csproj
dotnet build Signum.Utilities/Signum.Utilities.csproj
dotnet build Extensions/Signum.Chart/Signum.Chart.csproj

# Analyzer (separate sln, netstandard2.0; produces the NuGet on build)
dotnet build Signum.Analyzer/Signum.Analyzer.sln -c Release

# Upgrade tool (must be run from inside an application repo, not this clone)
dotnet build Signum.Upgrade/Signum.Upgrade.csproj
dotnet run   --project Signum.Upgrade/Signum.Upgrade.csproj

# From an application repo (Upgrade_20260212_UpdateCopilotInstructions3.cs:34-38)
dotnet build MyApp/MyApp.csproj      # not the whole solution
cd MyApp && yarn tsgo --build        # TypeScript type-check/d.ts
cd MyApp.Server && yarn dev          # Vite dev server, port 3000
dotnet test MyApp.Test.Logic/MyApp.Test.Logic.csproj

# Regenerate TS definitions after a C# entity change (AGENTS.md:51)
dotnet build MyApp/MyApp.csproj -p:TSGeneratorDisabled=false
```

Inside Visual Studio, `AGENTS.md:29-31` orders Copilot to use the `run_build` tool (VS integrated compiler) instead of `dotnet build` — that instruction is **VS-Copilot-specific** and irrelevant on Linux/CLI.

### 2.4 What building `Signum.csproj` triggers

Two NuGet-delivered MSBuild hooks fire, plus an optional third:

**(a) `Signum.MSBuildTask` — IL weaving** (`Signum.MSBuildTask/Signum.MSBuildTask.targets`):
```xml
<Target Name="SignumAfterCompile" AfterTargets="AfterCompile" Outputs="$(TargetPath)">
  <WriteLinesToFile File="$(BaseIntermediateOutputPath)SignumReferences.txt" Lines="@(ReferencePath)" .../>
  <Exec command="dotnet &quot;$(MSBuildThisFileDirectory)Signum.MSBuildTask.dll&quot; &quot;@(IntermediateAssembly)&quot; ... />
</Target>
```
It rewrites the freshly-compiled assembly (Mono.Cecil-style). Three passes, from `Signum.MSBuildTask/Program.cs:54-56`:
- `AutoPropertyConverter.cs` — turns entity auto-properties into `Set(ref field, value)` change-tracking property bodies. **This is why entities can be written as plain `public string Name { get; set; }` yet still notify/validate.**
- `ExpressionFieldGenerator.cs:53 FixAutoExpressionField()` — for `[AutoExpressionField]` methods/properties it synthesises a `static private <Name>Expression` field (`:78`) and rewrites the member to `[ExpressionField]` (`:104`). Emits an error if the body isn't a simple expression evaluation (`:460`).
- `FieldAutoInitiaizer.cs:23 FixAutoInitializer()` — implements `[AutoInit]`.

Because this runs `AfterCompile` on the *intermediate* assembly, **the weaving is a hard prerequisite**: skipping it produces entities without change tracking. There is no way to opt out.

**(b) `Signum.TSGenerator` — `.t4s` → `.ts`** (`Signum.TSGenerator/Signum.TSGenerator.targets`):
```xml
<PropertyGroup Condition="'$(CompileTypeScriptDependsOn)' == ''">
  <BuildDependsOn>$(BuildDependsOn); GenerateSignumTS; TSC_BuildAll;</BuildDependsOn>
</PropertyGroup>
<Target Name="GenerateSignumTS" Condition="'$(TSGeneratorDisabled)' != 'true'"> ... </Target>
```
(`:5-11`, `:13`). It writes `obj/SignumReferences.txt` then `Exec`s `dotnet Signum.TSGenerator.dll <IntermediateAssembly> <SignumReferences.txt> <SignumContent.txt>`.

**(c) `TSC_BuildAll`** (`Signum.TSGenerator.targets:19-42`) — only fires when `TSC_Build` is set:
- `TSC_Build=true` → `yarn tsc -b $(MSBuildProjectDirectory)/tsconfig.json --pretty false`
- `TSC_Build=tsgo` → `yarn tsgo -b …`
`IgnoreExitCode="true"`, output captured into `TscOutput`. In this repo the flag is **commented out** (`Extensions/Signum.Authorization/Signum.Authorization.csproj:9`: `<!--<TSC_Build>true</TSC_Build>-->`); the app enables it on `MyApp.Server.csproj` only (`Upgrade_20250930_TSC.cs:77`, later forced back to `true` by `Upgrade_20260710_TypeScript7Stable.cs:10-13` when TypeScript 7.0.2 stable replaced `@typescript/native-preview`). So: **a plain `dotnet build` does not compile TypeScript unless `TSC_Build` is set and yarn is on PATH.**

### 2.5 `TSGeneratorDisabled` — the "on demand" switch

`Signum/Signum.csproj:10` sets `<TSGeneratorDisabled>false</TSGeneratorDisabled>` explicitly, so **this repo's core project always regenerates TS on build**. The target's condition is `!= 'true'`, i.e. unset also means "run". The "Run TSGenerator on demand" change (`README.md:58`, 2025.12.15) is the app-side convention of setting it to `true` in app csprojs for speed, then overriding per-invocation with `-p:TSGeneratorDisabled=false` — precisely what the VSIX command does (`Signum.TSCBuild/RunTSGenerator.cs:124`).

### 2.6 The 85 `.t4s` files

`.t4s` = hand-written **TypeScript prologue/partial** for one C# namespace. `Signum.TSGenerator` scans the compiled assembly for the entities/enums/messages/operations/queries of each namespace and emits `<Namespace>.ts` next to the `<Namespace>.t4s`:

- `Signum.TSGenerator/Program.cs:182` — enumerates `*.t4s` in the project.
- `:108` — if a namespace exports TS types but has no `.t4s`, it *creates* one.
- `:96` — if a `.t4s` exists for a namespace that exports nothing → build error `STSG0002: t4s file not needed`.
- `:118-121` — `EntityDeclarationGenerator.WriteNamespaceFile(options, t4sFile, ns, types)` then `Path.ChangeExtension(t4sFile, ".ts")`.
- `EntityDeclarationGenerator.cs:60-63` — reflects over `ModifiableEntity`, `[InTypeScript]`, `[ImportInTypeScript]`, `IEntity`.
- `:738-743` — namespace → `<ns>.t4s` → `<ns>.ts` mapping used for cross-namespace imports.

Distribution: 8 in `Signum/React/` (`Signum.Basics`, `Signum.DynamicQuery`, `Signum.DynamicQuery.Tokens`, `Signum.Entities`, `Signum.Entities.Validation`, `Signum.External`, `Signum.Operations`, `Signum.Security`), the rest one-or-two per `Extensions/Signum.*`. A `.t4s` holds only what the generator can't infer — `//Partial` interface augmentations and imports. Example (`Extensions/Signum.Chart/Signum.Chart.t4s`):
```ts
import { FilterOptionParsed, ... } from '@framework/FindOptions'
//Partial
export interface ChartRequestModel { queryKey: string; filterOptions: FilterOptionParsed[]; filters: FilterRequest[]; }
```

Both `.t4s` and generated `.ts` are committed (§1.4).

### 2.7 TypeScript build graph

- `tsconfig.base.json` (root) is the single shared config: `target esnext`, `module esnext`, `moduleResolution bundler`, `jsx react-jsx`, `strict: true`, `noImplicitOverride`, `isolatedDeclarations: true`, `isolatedModules: true`, `composite: true`, `incremental: true`, **`emitDeclarationOnly: true`**, `sourceMap` + `declarationMap`, `types: ["node","google.maps"]`.
- Every project has a tiny `tsconfig.json` extending it with `"outDir": "./ts_out"` — e.g. `Signum/tsconfig.json` (4 lines). Extension tsconfigs add `paths: { "@framework/*": ["../../Signum/React/*"] }` and a `references: []` array forming a **TS project-reference DAG** (`Extensions/Signum.Chart/tsconfig.json` references `../../Signum`, `../Signum.UserAssets`, `../Signum.Omnibox`, `../Signum.UserQueries`, `../Signum.Dashboard`). 52 extension tsconfigs + `Signum/tsconfig.json` + the base.
- **`emitDeclarationOnly: true` is the key fact**: `yarn tsc -b` / `yarn tsgo -b` only **type-checks and emits `.d.ts` into `ts_out/`**. It never produces runnable `.js`. The actual transpile+bundle is done by **Vite** in `MyApp.Server`. This is why `.gitignore` can blanket-ignore `*.js` and `**/ts_out/**`.
- `isolatedDeclarations: true` is why `AGENTS.md:55` demands *"Type all props and state (using isolatedDeclarations)"* — every exported symbol needs an explicit type annotation.
- TS toolchain history: webpack → Vite (2025.08.22, `README.md:66`); `Microsoft.TypeScript.MSBuild` NuGet removed in favour of `yarn tsc` + the TSCBuild VSIX (2025.10.01, `README.md:63`, `Upgrade_20250930_TSC.cs:104`); `tsgo` (TypeScript Native Preview) added 2025.12.14 (`README.md:59`) and then swapped for **stable TypeScript 7.0.2** by `Upgrade_20260710_TypeScript7Stable.cs`. `AGENTS.md:50` still says `yarn tsgo --build`; the newest upgrade implies `yarn tsc -b` is now correct. **Both are wired in the target — check your app's `TSC_Build` value.**

---

## 3. Test

### 3.1 Frameworks

| Project | Framework | Runner packages |
|---|---|---|
| `Signum.Test/Signum.Test.csproj` | **xUnit v3** (`xunit.v3 3.2.2`, `:25`) | `Microsoft.NET.Test.Sdk 18.6.0` (`:20`), `xunit.runner.visualstudio 3.1.5` (`:22`) |
| `Extensions/Signum.Extensions.Test/…csproj` | **xUnit v3** (`xunit.v3 3.2.2`, `:21`) | same |
| `Signum.Analyzer/Signum.Analyzer.Test/…csproj` | **MSTest v2** (`MSTest.TestAdapter/TestFramework 2.2.5`, `:17-18`) + `Microsoft.CodeAnalysis.CSharp 4.14.0` | `Microsoft.NET.Test.Sdk 18.0.1` |
| `Extensions/Signum.Playwright/` | library, not a test project — `Microsoft.Playwright 1.60.0` (`:10`) | consumed by app's `MyApp.Test.React` |
| `Extensions/Signum.Selenium/` | library — `Selenium.WebDriver`/`Selenium.Support 4.45.0` (`:9-10`) | **legacy**, superseded by Playwright (`Upgrade_20260321_SeleniumToPlaywright.cs`) |

Counts (grep): `Signum.Test` = **669** `[Fact]`/`[Theory]`; `Signum.Extensions.Test` = **5**; `Signum.Analyzer.Test` = **54** `[TestMethod]`.

`Signum.Test/Properties/GlobalUsings.cs` global-imports `Xunit`, `Signum.Test.Environment`, `Signum.Engine`, `Signum.Entities`, `Signum.Operations`, etc. — test files have almost no `using` lines. `Signum.Test/Properties/Attributes.cs` = `[assembly: DefaultAssemblyCulture("en")]` (required by `DescriptionManager` localization).

### 3.2 `.runsettings` — the database selector

Only two, both in `Signum.Test/Properties/`, and each does exactly one thing: set `ASPNETCORE_ENVIRONMENT`.

```xml
<!-- SqlServer.runsettings -->
<RunSettings><RunConfiguration><EnvironmentVariables>
  <ASPNETCORE_ENVIRONMENT>SqlServer</ASPNETCORE_ENVIRONMENT>
</EnvironmentVariables></RunConfiguration></RunSettings>
```
`Postgres.runsettings` is identical with `Postgres`.

`MusicStarter` **throws** if `ASPNETCORE_ENVIRONMENT` is unset (`Signum.Test/Environment/MusicStarter.cs:22-23`), then builds config from `appsettings.json` + `appsettings.{environment}.json` (**not optional**, `:27`) + env vars (`:29`), and reads `ConnectionStrings:SignumTest` (`:32`). Equivalent CLI forms:
```bash
dotnet test Signum.Test/Signum.Test.csproj --settings Signum.Test/Properties/Postgres.runsettings
# or simply
ASPNETCORE_ENVIRONMENT=Postgres dotnet test Signum.Test/Signum.Test.csproj
```
`Signum.Test/Properties/launchSettings.json` mirrors this with "SQL Server" / "Postgres" profiles.

### 3.3 Connection strings & DB choice

- `Signum.Test/appsettings.json` — comments only; points at the two runsettings files (and uses the literal path `Framework\Signum.Test\Properties\…`, more submodule evidence).
- `Signum.Test/appsettings.SqlServer.json` → `Data Source=.;Initial Catalog=SignumTest;Integrated Security=true;TrustServerCertificate=true` (Windows integrated auth).
- `Signum.Test/appsettings.Postgres.json` → `Host=localhost;Database=SignumTest;Username=<placeholder>;Password=<placeholder>` — **committed placeholder credentials**. Do not treat as real; override via user secrets (`UserSecretsId=SignumTest`, `Signum.Test.csproj:5`) or `ConnectionStrings__SignumTest` env var. Both `.SqlServer.json` and `.Postgres.json` are `CopyToOutputDirectory=PreserveNewest` (`Signum.Test.csproj:38-46`).
- **Postgres-only is viable.** Dialect selection is by connection-string sniffing: `MusicStarter.cs:58` — `if (connectionString.Contains("Data Source"))` → `SqlServerConnector` (with `SqlServerVersionDetector.Detect`, `:60`), else → `PostgreSqlConnector` (with `PostgresVersionDetector.Detect`, `:65`) enabling `EnableArrays()`, `EnableLTree()`, `EnableRanges()`, `UseVector()` (`:67-71`) — i.e. Postgres needs the **`ltree` and `vector` (pgvector)** extensions available.
- `Extensions/Signum.Extensions.Test/appsettings.json` defaults to `Data Source=.\SQLEXPRESS;Initial Catalog=SignumExtensionsTest;…` but is explicitly **`CopyToOutputDirectory=Never`** with the comment *"This file is not copy to the bin directory. Use UserSecrets instead."* (`…csproj:36-39`, `UserSecretsId=SignumExtensionsTest`). In practice its only test file `AuthTest.cs` is **pure in-memory** (`TypeConditionMerger.MergeBaseImplementations` over `WithConditions<TypeAllowed>`) — grep finds no `Connector`/`Starter`/`Database.` — so **`Signum.Extensions.Test` needs no database at all today**.

### 3.4 How the test DB is created and seeded

`Signum.Test/Environment/` (4 files) is a miniature Signum application ("Music": Artist/Album/Band/Label…):

`MusicStarter.StartAndLoad()` (`MusicStarter.cs:12-52`), guarded by a `static bool` + `lock (typeof(MusicStarter))` so it runs **once per test process**:
1. resolve environment + connection string (§3.2);
2. `Start(connectionString)` — builds `SchemaBuilder`, picks the connector, sets `sb.Schema.Version` from the assembly version (`:76`), registers `ImplementedByAllPrimaryKeyTypes` for `long` and `Guid` (`:77-78`), `FieldAttributes` overrides for `OperationLogEntity.User` / `ExceptionEntity.User` (`:79-80`), then `MusicLogic.Start(sb)`;
3. **`Administrator.TotalGeneration(interactive: false)`** (`:39`) — **drops and recreates the entire schema from the entity model**. No migration files, no EF migrations.
4. `Schema.Current.Initialize()` (`:41`), `(Connector.Current as PostgreSqlConnector)?.ReloadTypes()` (`:43`);
5. **`MusicLoader.Load()`** (`:45`, 349 lines) — seeds the fixture data;
6. if SQL Server and `SupportsVectors`, create the vector index on `SimplePassageEntity` (`:47-49`).

So: **point it at an empty database and it self-creates and self-seeds.** Create the empty DB first (`CREATE DATABASE SignumTest;`) — `TotalGeneration` builds the schema, not the database.

DB-specific tests **skip themselves** rather than fail — `throw SkipException.ForSkip(...)` in the constructor:
- `LinqProvider/FullTextSearchTest.SqlServer.cs:20` — "not SQL Server"; `:22-23` — also skips if `!con.SupportsFullTextSearch`.
- `LinqProvider/FullTextSearchTest.Postgres.cs` — mirror image.
- `PostgresArrayTest.cs:13-14` — skips if not Postgres.
- `DynamicQueries/DynamicQueryVectorTest.cs:27` — skips if `!Connector.Current.SupportsVectors`.

### 3.5 Running only the DB-free tests

Every DB-touching class calls `MusicStarter.StartAndLoad()` in its **constructor**, so there's no attribute/trait to filter on — you must filter by class. Files that never reference `MusicStarter`/`Signum.Test.Environment` (grep-verified) are exactly 6 classes, **26 tests**:

`CsvTest`, `ExpressionGeneratorTest`, `ExtensionsTest`, `NiceToStringTest`, `SortableHierarchyTest`, `StringDistanceTest`
(+ `StaticExample`/`InstanceExample` helper classes in `ExpressionGeneratorTest.cs:25,75`).

```bash
# xUnit v3 / VSTest filter — still needs ASPNETCORE_ENVIRONMENT because a full
# assembly load happens, but no connection is opened by these classes.
ASPNETCORE_ENVIRONMENT=Postgres dotnet test Signum.Test/Signum.Test.csproj \
  --filter "FullyQualifiedName~CsvTest|FullyQualifiedName~ExpressionGeneratorTest|FullyQualifiedName~ExtensionsTest|FullyQualifiedName~NiceToStringTest|FullyQualifiedName~SortableHierarchyTest|FullyQualifiedName~StringDistanceTest"

# Fully DB-free projects:
dotnet test Extensions/Signum.Extensions.Test/Signum.Extensions.Test.csproj   # 5 tests, in-memory
dotnet test Signum.Analyzer/Signum.Analyzer.Test/Signum.Analyzer.Test.csproj  # 54 MSTest, Roslyn in-memory
```
There is **no** `--filter`-friendly trait/category anywhere and no CI to copy a canonical invocation from.

### 3.6 `Signum.Analyzer.Test`

MSTest, in its own solution (`Signum.Analyzer/Signum.Analyzer.sln`). `Helpers/CodeFixVerifier.Helper.cs` + `Verifiers/` compile snippets in-memory and assert diagnostics/code-fixes for `AutoExpressionFieldTest`, `ExpressionFieldTest`, `LiteCastTest`, `LiteEqualiyTest`. It `ProjectReference`s `Signum` and `Signum.Utilities` with the comment *"Remove before restore to workarround NuGet duplicated key bug"* (`Signum.Analyzer.Test.csproj:26`) — expect a restore hiccup here.

### 3.7 UI tests — Playwright (and legacy Selenium)

`Extensions/Signum.Playwright/` is a **proxy library**, not a test project: `BrowserProxy.cs`, `ElementLocator.cs`, `PlaywrightExtensions.cs`, `SignumPlaywrightTestClass.cs`, and folders `Frames/`, `LineProxies/`, `ModalProxies/`, `Search/`, `Toolbar/`. `Extensions/Signum.Playwright.Workflow/` adds workflow-module proxies. The **tests live in the app** (`MyApp.Test.React`).

`Extensions/Signum.Selenium/` is the pre-2026 equivalent (Selenium 4.45.0). `Upgrade_20260321_SeleniumToPlaywright.cs` is the migration: swap the `ProjectReference`, drop `Selenium.WebDriver`, rewrite `GlobalUsings.cs` to `Signum.Playwright{,.Frames,.Search,.LineProxies,.ModalProxies}` + `Microsoft.Playwright`, make `MyAppTestClass` inherit `SignumPlaywrightTestClass, IAsyncLifetime`, and convert `Browse(...)` → `async ValueTask InitializeAsync()`. Note `Upgrade_20260212_UpdateCopilotInstructions3.cs:28` still describes `MyApp.Test.React` as "Selenium UI tests" — stale.

**Workflow prescribed by `Skills/ReactTesting.Writing.md`:**
1. **xUnit.v3 + Playwright + Signum proxy abstractions** (`:3`). Test classes derive from a shared app base (`SouthwindTestClass`) and wrap everything in `await BrowseAsync("System", async b => { … })` (`:9-23`). Methods are always `async Task` (`:25`).
2. **Proxy-first.** A proxy wraps Playwright for one page/control and exposes *domain* actions. Raw selectors stay inside proxies; *"Tests should read as business flows, not Playwright scripts"* (`:29-34`). For a complex UI, write the custom proxy **before** the test (`:32`).
3. `BrowserProxy` is the root (login/logout, `SearchPageAsync`, `FramePageAsync<T>`, `FindRoute`, `NavigateRoute`); apps subclass it as `SouthwindBrowser` (`:35-45`).
4. **Modals**: `ModalProxy` implements `IAsyncDisposable`/`IDisposable` so lifecycle is automatic (`:49-51`). Standard proxies: `FrameModalProxy<T>`, `SearchModalProxy`, `SelectorModalProxy`, `AutoLineModalProxy`, `MessageModalProxy`, `ErrorModalProxy` (`:55-61`). Capture via `page.CaptureModalAsync(() => btn.ClickAsync())`, `CaptureOnClickAsync`, `CaptureOnDoubleClickAsync`, `OperationClickCaptureAsync`; then `await FrameModalProxy<T>.NewAsync(locator)` — `NewAsync` waits for modal content (`:63-89`).
5. **Chain with `.Then(...)`, not `using`** (`:91-107`): `.Then` is an extension on `Task<T>` that guarantees disposal and mirrors modal nesting; casting helpers `.Then(loc => loc.AsSearchModal())` / `.AsFrameModal<T>()`. Explicit rule: *"AVOID `using var ...` without an explicit block (Dispose is called too late)."* (`:108`).
6. **Read/write data via typed lines** (`:131-155`): `ILineContainer<T>` (`FramePageProxy<T>`, `FrameModalProxy<T>`, `LineContainer<T>`, `EntityTableRow<T>`) + `LineContainerExtensions` → `AutoLine(...)`, `AutoLineValueAsync(o => o.Reference, "SO-1001")`, `EntityTable(o => o.Details).CreateRowAsync<OrderDetailEmbedded>()`.
7. **Operations via `IEntityButtonContainer`** (`:175-199`): `ExecuteAsync(OrderOperation.Save)`, `OperationClickCaptureAsync`, `ConstructFromAsync<OrderEntity, InvoiceEntity>(OrderOperation.InvoiceFrom)`, `OperationEnabledAsync`, `DeleteAsync`.
8. **Custom proxies, 3 shapes** (`:201-279`): page-level method on `SouthwindBrowser` + a `XxxPageProxy` with `static NewAsync(page)` that waits on a root locator; component-level `class + extension method on ILineContainer<TEntity>`; or a bare extension method. **Every proxy class must carry a comment pointing at the equivalent `.tsx` file** (`:203`).

**Workflow prescribed by `Skills/ReactTesting.Debugging.md`** (heavily Windows/IIS-flavoured; `AGENTS.md:24` mandates reading it *before* diagnosing any failing UI test):
- **Startup checklist**, in order (`:9-59`):
  1. Playwright browsers missing (`Executable doesn't exist at …ms-playwright\chromium-…`) → run the generated bootstrapper: `…/MyApp.Test.React/bin/Debug/net10.0/playwright.ps1 install chromium` (on Linux: `pwsh playwright.ps1 install chromium`, or `dotnet tool install --global Microsoft.Playwright.CLI && playwright install chromium`).
  2. Web app not running → open `http://localhost/MyApp.Server`; **503** means the IIS app pool is stopped → `& "$env:windir\system32\inetsrv\appcmd.exe" start apppool /apppool.name:"MyApp.Server AppPool"` (with the note that `%windir%` is CMD-only).
  3. 200 but `URIError … http://localhost:3118/main.tsx didn't load correctly` → **the Vite dev server isn't running**: `cd MyApp.Server && yarn run dev`.
  4. **`GenerateEnvironment` test not yet run** → it *"will put the database in a base state and create a snapshot (in SQL Server) or a template (in Postgres) that will be restored before running any UI Test"*. `GenerateEnvironment` lives in the **app**, not here; the framework side is `Administrator.WithSnapshotOrTemplateDatabase()` (`Signum/Engine/Administrator.cs:941-970`) and `Administrator.RestoreSnapshotOrDatabase()` (`:972-991`) — SQL Server uses `CREATE DATABASE … AS SNAPSHOT OF` / `RESTORE DATABASE … FROM DATABASE_SNAPSHOT` (`Snapshots`, `:993-1027`); Postgres uses `CREATE DATABASE <db> WITH TEMPLATE <db>_Template` (`:983`, `PostgressTools`, `:1029+`) plus `SchemaSynchronizer.SyncPostgresDefaultTextLanguage()`. Default template name is `<db>_Template` (`:944`, `:975`). Each UI test calls `Administrator.RestoreSnapshotOrDatabase()` in `InitializeAsync` (`Upgrade_20260321_SeleniumToPlaywright.cs:75`) plus a `POST api/cache/invalidateAll`.
- **`PLAYWRIGHT_MODE`** (`Debugging.md:63-96`, implemented in `Extensions/Signum.Playwright/SignumPlaywrightTestClass.cs:26-30`): read from the env var, else the **first line** of `MyApp.Test.React/PLAYWRIGHT_MODE.txt`, else `"debug"` if a debugger is attached.
  - absent/other → visible Chromium (`--start-maximized --no-first-run --no-default-browser-check --disable-popup-blocking`, `:44-54`)
  - `headless` → `LaunchAsync(new { Headless = true })` (`:35-36`)
  - `debug` → real Chrome with `--remote-debugging-port=9222`, connected over CDP, window kept open after failure (`:38-42`, `DebugChromePort = 9222` at `:12`); reuses the CDP default context so pages open as tabs (`:60-68`). Disable by prefixing the file line with `//`.
- **Post-failure inspection**: attach `chrome-devtools-mcp` to the live Chrome — `npx -y chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9222` (`:104-116`).
- **Hard rule**: *"DO NOT remove or comment out failing test code — If the test needs to be modified or removed, get explicit user confirmation first. Never silently delete assertions."* (`:128`). Triage order: MCP page state → check the `.tsx` implementation → only then touch the test.

---

## 4. Run

### 4.1 Hosting

There is **no sample host in this repo** — no `Program.cs`/`Startup.cs` for a web app, no `.pubxml` for a server, no `Dockerfile`. The host is `MyApp.Server` in the application repo (`Upgrade_20260212_UpdateCopilotInstructions3.cs:26`: *"ASP.NET Core host, Vite dev server (port 3000), API controllers"*; `:32`: *"`MyApp.Server/Program.cs` — Server entry point, calls `Starter.Start()`"*).

The framework's contribution is the **`WebServerBuilder` convention** (`Signum/API/SignumServer.cs:224-236`):
```csharp
public class WebServerBuilder
{
    public required WebApplication WebApplication { get; set; }
    public required string? MachineName { get; set; }
    public required string AuthTokenEncryptionKey { get; set; }
    public required CultureInfo DefaultCulture { get; set; }

    public HashSet<(Type type, string method)> LoadedModules = new();
    public bool AlreadyDefined(MethodBase? methodBase)
        => !LoadedModules.Add((type: methodBase!.DeclaringType!, method: methodBase!.Name));
}
```
Every module exposes `static void Start(WebServerBuilder wsb)` whose first line is the idempotence guard `if (wsb.AlreadyDefined(MethodBase.GetCurrentMethod())) return;` (`SignumServer.cs:90-93`). `SignumServer.Start` then sets `Schema.Current.ApplicationName` (`:95`), runs `ReflectionServer.Start()` (`:97`) and registers which enums/namespaces are exposed to the client, gated on `UserHolder.Current != null` (`:99-105`). `MyApp/Starter.cs` calls each module's `Start(wsb)` in order — this is the **static-registration, no-DI** pattern of `AGENTS.md:37-40`.

DI touchpoints are limited to genuine ASP.NET extensibility: `services.AddSignumValidation()` (`:75-88`), `MvcOptions.AddSignumGlobalFilters()` (`:57`), `JsonOptions.AddSignumJsonConverters()` (`:33`) / `JsonSerializerOptions.AddSignumJsonConverters()` (`:40`). Controllers live in `Signum/API/Controllers/`; filters in `Signum/API/Filters/`; JSON converters in `Signum/API/Json/`; `Signum/API/SignumHealthResult.cs` provides a health endpoint; `Signum/API/ReflectionServer.cs` is the `api/types` metadata endpoint.

`MyApp.Terminal` is the console entry point for schema sync / migrations / data load, with launch profiles `test`/`live` via `ASPNETCORE_ENVIRONMENT` (`Upgrade_20251207_SimplifyVSCode.cs` launch.json).

### 4.2 React dev server: Vite, in the app

**No `vite.config.*` and no webpack config exists in this repo** (verified by `find`). Vite lives in `MyApp.Server/vite.config.js`. The framework's integration point is `Signum/API/ViteAssets.cs`:
- `ViteAssets.FromViteServerUrl(mainJsUrl)` (`:17`) — **dev**: point the page's `<script>` straight at the Vite dev server (e.g. `http://localhost:3118/main.tsx`, the URL that appears in the `URIError` diagnostic in `ReactTesting.Debugging.md:46`).
- `ViteAssets.FromManifestFile(manifestFilePath, mainEntry)` (`:18-33`) — **prod**: parse Vite's `manifest.json`, resolve `~/dist/<file>` for the entry plus recursive `imports` (preload) and `css` (`CollectAssets`, `:35-63`), and emit the loader script via `GetHtmlString(IUrlHelper)` (`:65+`) with `showError(new URIError(...))` handlers.
`MyApp.Server/HomeController.cs` + `Index.cshtml` (moved there by `Upgrade_20250930_TSC.cs:21-22`) render it.

Versions and ports, from the upgrade scripts:
- `vite 8.0.15`, `@vitejs/plugin-react 6.0.2`, `sass 1.100.0` (`Upgrade_20260602_Vite8AndOptions.cs:18-20`).
- Vite 8 = Rolldown: `manualChunks` was rewritten to `codeSplitting: { groups: [{ name, test: /node_modules[\\/](…)/, priority: 10 }] }` (`Upgrade_20260602_Vite8AndOptions.cs:70-90`), and `strictExecutionOrder: true` was required so prismjs core runs before `@lexical/code`'s `prism-*` imports (`Upgrade_20260617_StrictExecutionOrderAndNugets.cs:33-41`).
- Dev-server port: **3000** per `Upgrade_20260212_UpdateCopilotInstructions3.cs:26`; the debugging skill shows **3118** — it's per-app configurable.
- `typescript 7.0.2` (`Upgrade_20260710_TypeScript7Stable.cs:17-20`), previously `@typescript/native-preview` (tsgo).
- `.dockerignore` and `.gitignore` both exclude `ts_out` (`Upgrade_20250930_TSC.cs:108-118`); `Upgrade_20260610_ViteWatchIgnoreObjBin.cs` adds `obj`/`bin` to Vite's watch-ignore.

### 4.3 Dev loop commands (from the app root)

```bash
git clone --recurse-submodules <app-repo> && cd MyApp
cd MyApp.Server && yarn install && cd ..          # yarn, never npm (AGENTS.md:46-49)
dotnet build                                       # weaves IL + regenerates .ts
cd MyApp.Server && yarn dev &                      # Vite dev server (port 3000)
dotnet run --project MyApp.Server                  # Kestrel; "Now listening on: …"
# schema sync / migrations / seed:
dotnet run --project MyApp.Terminal
```
VS Code tasks provided by the template (`Upgrade_20251207_SimplifyVSCode.cs`, tasks.json): `dotnet build` (cwd = root), `yarn tsgo -b` (cwd = `MyApp.Server`), `yarn dev`, `yarn install`. **All four are declared under a `"windows"` key only** — they will not run as-is on Linux/macOS; change `"windows"` → `"command"`. launch.json ships `MyApp.Server` (+ `test`/`live` variants), `MyApp.Terminal` (+ variants), `Signum.Upgrade` (`preLaunchTask: build_signum_upgrade`, program under `Framework/Signum.Upgrade/bin/Debug/net10.0/`), and `.NET Core Attach`; `serverReadyAction` regex `\bNow listening on:\s+(https?://\S+)`.

The debugging skill's IIS/app-pool path (`ReactTesting.Debugging.md:22-39`) describes the **Windows/IIS** hosting variant (`http://localhost/MyApp.Server`); Kestrel via `dotnet run` is the cross-platform equivalent.

### 4.4 Migrations

`Extensions/Signum.Migrations/SqlMigrationRunner.cs:9`:
```csharp
public static string MigrationsDirectory = Path.Combine("..", "..", "..", "Migrations");
```
i.e. `MyApp.Terminal/Migrations/` relative to `bin/Debug/net10.0`. Filenames must match `(?<version>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2})(_(?<comment>.+))?\.sql` (`:198`, error text at `:206`: `yyyy.MM.dd-HH.mm.ss_OptionalComment.sql`). The runner **diffs the entity model against the live schema and writes the `.sql` itself** (`:106-108` `File.WriteAllText(...)`), auto-creating the directory if missing (`:186-189`). `CSharpMigration.cs`/`CSharpMigrationRunner.cs` cover code migrations. Signum.Test bypasses all of this and uses `Administrator.TotalGeneration` instead (§3.4).

---

## 5. CI/CD

**There is none in this repository.** Verified:

| Looked for | Result |
|---|---|
| `.github/` | **absent** (`test -d .github` → NO) |
| `azure-pipelines*` | none |
| `*.yml` / `*.yaml` (any CI) | none outside `node_modules` |
| `Dockerfile` / `.dockerignore` | none — only two *upgrade scripts* that patch the **app's** Dockerfile (`Upgrade_20251218_DockerfileFix.cs`, `Upgrade_20210113_TimezoneInDockerfile.cs`) |
| `*.ps1` | only `Signum.Analyzer/Signum.Analyzer/tools/install.ps1` + `uninstall.ps1` (legacy `packages.config` NuGet install hooks) |
| `*.pubxml` | 2, both for local folder publish of dev tools: `Signum.Analyzer/Signum.Analyzer/Properties/PublishProfiles/FolderProfile.pubxml`, `Utils/CheckUrl/CheckUrl/Properties/PublishProfiles/FolderProfile.pubxml` |
| `Directory.Build.props` / `.targets` / `Directory.Packages.props` | none — the only `.props`/`.targets` are the two NuGet-shipped ones (`Signum.MSBuildTask.targets`, `Signum.TSGenerator.targets`). **NuGet versions are duplicated across ~60 csproj files** and kept in sync by hand-written `Signum.Upgrade` scripts calling `file.UpdateNugetReferences(...)` (e.g. `Upgrade_20260617_StrictExecutionOrderAndNugets.cs:13-30`) — that *is* the dependency-management mechanism. |
| `.editorconfig` | none |

**"Release" model** = git. `README.md:54`: no numeric versioning; consumers `git pull` the submodule and then run `Signum.Upgrade` to migrate their own source. The version ledger is `README.md:58-189` (a hand-maintained changelog of ~150 notable commits) plus `SignumUpgrade.txt` in each app (`CodeUpgradeRunner.cs:33`, `:58` — *"this file contains the Upgrades that have been run, and should be commited to git"*). NuGet publishing of the 3 packages and VSIX publishing to the Marketplace are **manual, off-repo**.

CI/CD hints that exist only *as upgrade payloads* (i.e. they live in the app): `MyApp.Server/Dockerfile` (multi-stage `sdk:10.0` → `aspnet:10.0`, installs Node **22** via `nsolid_setup_deb.sh 22` then `npm install -g yarn`, plus `libgdiplus libfontconfig1 libgssapi-krb5-2`, and `COPY ["Framework.tar", "/"]` — the submodule is tarred into the build context) — `Upgrade_20251218_DockerfileFix.cs`; and `deploy*.ps1` scripts (`Upgrade_20251113_Dotnet10.cs:47-50`).

---

## 6. Conventions & guardrails — the hard rules

### C#

| # | Rule | Source |
|---|---|---|
1 | **Nullable reference types on, with `<WarningsAsErrors>nullable</WarningsAsErrors>`** — a nullability warning is a build failure. | `Signum/Signum.csproj:4-5`; identically in `Signum.Utilities:5-6`, `Signum.Test:6-7`, `Extensions/Signum.Chart:5-6`, `Signum.Upgrade:6-7`, `Extensions/Signum.Selenium:5-6`, `Extensions/Signum.Extensions.Test:6-7`. AGENTS.md:42. |
2 | **`<NoWarn>8618</NoWarn>`** — CS8618 ("non-nullable field must contain a non-null value") is suppressed *project-wide*, the sanctioned escape hatch for DTOs/entities that are deserialized or MSBuildTask-initialised. AGENTS.md:42: *"Use not nullable reference types, but allow DTOs without default values or constructors (often deserialized)."* | `Signum/Signum.csproj:8`, `Signum.Test:11`, `Extensions/Signum.Chart:7`. Note tests still use local `#pragma warning disable CS0649` where needed (`Signum.Test/CsvTest.cs:25`). |
3 | **No EF, no raw SQL for queries.** *"Use Signum LINQ provider for queries, not EF or SQL."* Neither `Microsoft.EntityFrameworkCore` nor Dapper appears in any csproj; data access is `Microsoft.Data.SqlClient 7.0.1` / `Npgsql 10.0.3` under Signum.Engine. | AGENTS.md:39; `Signum/Signum.csproj:27,29` |
4 | **Static logic classes over dependency injection.** *"Prefer static classes for logic over dependency injection"* / *"Avoid dependency injection unless ASP.Net extensibility requires it"* / *"Follow Signum static logic registration patterns."* Enforced structurally by `SchemaBuilder`+`WebServerBuilder.AlreadyDefined`. | AGENTS.md:37, :40, :41; `Signum/API/SignumServer.cs:90-93`, `:224-236`; `Signum.Test/Environment/MusicStarter.cs` (`static`, `lock (typeof(...))`) |
5 | **Prefer synchronous logic in operations/processes.** | AGENTS.md:38 |
6 | **All end-user messages must be localized.** Never a bare string literal. C#: `typeof(X).NiceName()`, `NicePluralName()`, `pi.NiceName()`, `EnumValue.NiceToString()`; reuse an existing `Message` enum before adding one; new messages are `enum` members with `[Description("… {0}")]` and are consumed as `YourMessage.MyFavoriteFoodIs0.NiceToString(arg)`. Assemblies need `[assembly: DefaultAssemblyCulture("en")]`. | AGENTS.md:43, :59; `Skills/Localization.md:3-25`; `Signum.Test/Properties/Attributes.cs`, `Extensions/Signum.Extensions.Test/Properties/Attributes.cs` |
7 | **Don't compile the whole solution.** *"The solution is large; avoid compiling the entire solution unless necessary. Prefer compiling only the affected project."* | AGENTS.md:36; app-level restatement `Upgrade_20260212_UpdateCopilotInstructions3.cs:35` |
8 | **`[AutoExpressionField]` bodies must be a single expression evaluation** — the IL rewriter fails the build otherwise, and analyzer **SF0001** (Warning) flags it with a code fix. | `Signum.MSBuildTask/ExpressionFieldGenerator.cs:53,460`; `Signum.Analyzer/Signum.Analyzer/AutoExpressionFieldAnalyzer.cs:16-21` + `AutoExpressionFieldFixProvider.cs` |
9 | **`[ExpressionField]` without a parameter must point at a real static expression field** — analyzer **SF0002** (Warning). | `ExpressionFieldAnalyzer.cs:16-21`; `AnalyzerReleases.Shipped.md` |
10 | **Never compare `Lite<T>`/`Entity` with `==`/`!=`.** `SF0031` Warning (`Lite<T> == Lite<T>`), `SF0032` Warning (`Entity == Entity`), **`SF0033` Error** (`Lite<T> == Entity`), **`SF0034` Error** (`Lite<A> == Lite<B>`). Code fix provided (`Is(...)`). | `LiteEqualityAnalyzer.cs:17-42`; `LiteEqualityCodeFixProvider.cs`; `AnalyzerReleases.Shipped.md` Release 3.2 |
11 | **Never cast/pattern-match a `Lite<T>` to an `Entity` (or vice versa)** — **`SF0004` Error**; covers `as`/`is`/`switch` patterns and case expressions. | `LiteCastAnalyzer.cs:17-29`; `AnalyzerReleases.Shipped.md` Releases 3.0/3.1 |
12 | Analyzers are **not optional**: `Signum.Analyzer 3.2.0` is a `PackageReference` in the framework, every extension, and both xUnit test projects. | `Signum/Signum.csproj:31`, `Signum.Test:21`, `Extensions/Signum.Chart:113`, `Extensions/Signum.Selenium:9`, `Extensions/Signum.Extensions.Test:20` |
13 | New Roslyn rules must be recorded in `AnalyzerReleases.{Shipped,Unshipped}.md` (Rule ID / Category / Severity / Notes). | `Signum.Analyzer/Signum.Analyzer/AnalyzerReleases.Shipped.md` |

### TypeScript / React

| # | Rule | Source |
|---|---|---|
14 | **`yarn` exclusively, never `npm`** — `yarn install`, `yarn add`, `yarn <script>`. Stated in caps: *"ALWAYS use `yarn` exclusively, never `npm`"*. The MSBuild target and the VSIX both shell out to `yarn`. | AGENTS.md:46-49; `Signum.TSGenerator.targets:25,37`; `Signum.TSCBuild/CompileTypeScript.cs:234-295` |
15 | **Compile only the affected tsconfig**: `yarn tsgo --build` (or `yarn tsc -b <tsconfig>`), not the whole graph. | AGENTS.md:50; `Signum.TSGenerator.targets:19-42` |
16 | **Never hand-write the generated `.ts`.** After a C# change, *"regenerate the TypeScript definitions just compiling the csproj"*. Edit the `.t4s` for hand-written partials only. | AGENTS.md:51; `Signum.TSGenerator/Program.cs:118-121` |
17 | **TypeScript `strict: true`** plus `noImplicitOverride`, `isolatedModules`, and **`isolatedDeclarations: true`** ⇒ every exported symbol needs an explicit type. *"Type all props and state (using isolatedDeclarations)"*, *"Use strict mode in TypeScript."* | `tsconfig.base.json:5,6,20,21`; AGENTS.md:55, :57 |
18 | **Functional components as plain functions**; **Signum hooks (`useAPI`, `useForceUpdate`) over state-management libraries** — no Redux/Zustand/MobX anywhere. | AGENTS.md:56, :58 |
19 | **Bootstrap 5 + react-bootstrap + Font Awesome** are the UI vocabulary. | AGENTS.md:54; `Signum/package.json:24-28,42-43` |
20 | **Imperative mutation of entities in components is explicitly allowed** — *"do not enforce strict immutability."* | AGENTS.md:59 |
21 | TS user-facing text must be localized: `X.niceName()`, `X.nicePropertyName(a => a.name)`, `Enum.niceToString("Value")`; **new `Message` enums are declared in C# first, then recompiled**; `formatHtml`/`joinHtml` for React nodes. | `Skills/Localization.md:27-44`; AGENTS.md:59 |
22 | Import framework code via the `@framework/*` path alias → `../../Signum/React/*`. | `Extensions/Signum.Chart/tsconfig.json`; `Extensions/Signum.Chart/Signum.Chart.t4s:1` |

### SQL / migrations

| # | Rule | Source |
|---|---|---|
23 | **Never create, edit, or delete `.sql` files under any `*.Terminal/Migrations/` folder unless the user explicitly asks.** *"They are generated automatically by the framework and are likely already executed in the database."* | AGENTS.md:60-61 |
24 | Migration filenames are machine-generated and must match `yyyy.MM.dd-HH.mm.ss_OptionalComment.sql`. | `Extensions/Signum.Migrations/SqlMigrationRunner.cs:198,206,278` |

### Repo hygiene / process

| # | Rule | Source |
|---|---|---|
25 | **LF line endings for every file type** (`.cs`, `.ts`, …) — one-line `.gitattributes`. | `.gitattributes`; `README.md:70` |
26 | **Never modify the `Framework/` submodule from the app repo**; upgrade scripts skip it. | `Upgrade_20260212_UpdateCopilotInstructions3.cs:29`; `UpgradeContext.cs:122` |
27 | Upgrade scripts are authored **against Southwind**; skip pure submodule-pointer bumps; only include Framework changes that also appear in Southwind files. Class name pattern `Upgrade_yyyyMMdd_Description : CodeUpgradeBase` (auto-discovered and ordered **by type name**). | `Skills/CreatingSignumUpgrades.md:3-6`; `Signum.Upgrade/CodeUpgradeRunner.cs:15-22` |
28 | *"Respect existing folder and module structure: code is organized by feature/module, not by technical concern."* Vertical slices (entities + logic + `.tsx` + `.t4s` together per module) — cf. `README.md:8,26`. | AGENTS.md:10 |
29 | *"Add minimal comments only if necessary."* | AGENTS.md:9 |
30 | **When a React UI test fails, read `Skills/ReactTesting.Debugging.md` before attempting any diagnosis**; never silently delete a failing assertion. | AGENTS.md:24; `ReactTesting.Debugging.md:128` |
31 | Proxy classes carry a comment naming the equivalent `.tsx`. | `ReactTesting.Writing.md:203` |
32 | Prefer `.Then(...)` over bare `using var` in modal-heavy Playwright tests. | `ReactTesting.Writing.md:106-108` |
33 | Design principles that shape reviews: *"Promote simple and clean code, avoiding astronautical architectures"*, *"Favor compile-time checked code over dynamic code"*, *"Encourage a more functional way of programming"*, *"Avoid code duplication."* | `README.md:35-41` |

---

## 7. Prerequisites checklist for a Linux dev environment

Measured on this machine:

| Tool | Required | Present here | Notes |
|---|---|---|---|
| **.NET SDK 10.x** | **yes** | **NO** | Every csproj is `net10.0`. `dotnet` is not on PATH → **nothing builds today**. Install: `dnf install dotnet-sdk-10.0` (RHEL 9 / this box is `5.14.0-687.26.1.el9_8`) or the `dotnet-install.sh` script with `--channel 10.0`. |
| **Node.js 22.x** | yes | **v22.23.1** ✅ | The app Dockerfile pins Node **22** (`nsolid_setup_deb.sh 22`, `Upgrade_20251218_DockerfileFix.cs`). `tsconfig.base.json` requires `@types/node`. |
| **yarn** | **yes (npm is forbidden)** | **NO** (`npm 10.9.8` present but must not be used) | `AGENTS.md:46-49`. Install `npm install -g yarn` (that's what the Dockerfile does) or `corepack enable` (corepack also absent). Needed by `TSC_BuildAll` (`Signum.TSGenerator.targets:25,37`) and by `yarn dev`. |
| **A database** | yes, for the ~643 DB-bound tests and for running any app | **none installed** | See below. |
| **PostgreSQL 14+ with `ltree` + `pgvector`** | recommended on Linux | not installed | `MusicStarter.cs:65-71` enables arrays, **LTree**, ranges, **Vector**. Postgres is a first-class target (`README.md:6`, `README.md:162` "PostgreSQL support is here!"). Easiest: `docker run -d --name signum-pg -e POSTGRES_PASSWORD=… -p 5432:5432 pgvector/pgvector:pg17`, then `CREATE DATABASE "SignumTest";` and `CREATE EXTENSION ltree; CREATE EXTENSION vector;`. Docker 29.6.2 is available. |
| SQL Server 2019+ | optional | not installed | `mcr.microsoft.com/mssql/server:2022-latest` runs on Linux. Needed only for the SQL-Server-specific tests (`FullTextSearchTest_SqlServer` also needs the Full-Text feature, absent from the standard Linux image → it self-skips) and for the SQL-Server *snapshot* form of the UI-test reset. `Integrated Security=true` in the committed `appsettings.SqlServer.json` is **Windows-only** — override via user secrets / `ConnectionStrings__SignumTest`. |
| `psql` / `sqlcmd` | convenient | **NO** | Not needed if you exec into the container. |
| **Playwright Chromium** | only for UI tests | n/a | `Microsoft.Playwright 1.60.0`. Bootstrap via `bin/Debug/net10.0/playwright.ps1 install chromium` (needs **pwsh — also absent**) or `dotnet tool install --global Microsoft.Playwright.CLI && playwright install chromium`. Set `PLAYWRIGHT_MODE=headless` on a headless box. |
| `pwsh` | optional | **NO** | Only for `playwright.ps1` and the app's `deploy*.ps1`. |
| git ≥ 2.x | yes | 2.52.0 ✅ | `git clone --recurse-submodules` for a real app repo. |

### Windows-only pieces (cannot be built or used on Linux — and are not needed for a CLI dev loop)

1. **`Signum.TSCBuild/`** — VSIX, `v4.7.2`, `Microsoft.VisualStudio.SDK` + `Microsoft.VSSDK.BuildTools`, `StartProgram = $(DevEnvDir)devenv.exe /rootsuffix Exp` (`Signum.TSCBuild.csproj:18-33`). Its two commands are trivially replaced on Linux by `yarn tsc -b <dir>/tsconfig.json` and `dotnet build -p:TSGeneratorDisabled=false`.
2. **`Signum.VSIX/`** — VSIX packaging of `Snippets/` + `SnippetsTS/`, same constraints (`Signum.VSIX.csproj:4,18`).
3. `AGENTS.md:28-31` `run_build` instruction — Visual Studio Copilot only.
4. `Skills/ReactTesting.Debugging.md:26-39` IIS `appcmd.exe` app-pool handling — irrelevant under Kestrel.
5. `.vscode/tasks.json` shipped by the template declares commands under a `"windows"` key only (`Upgrade_20251207_SimplifyVSCode.cs`) → must be edited for Linux.
6. `appsettings.SqlServer.json` `Integrated Security=true` → needs SQL auth on Linux.
7. `Signum/Signum.csproj:28` `Microsoft.SqlServer.Types 170.1000.7` — spatial/hierarchy CLR types; restores fine on Linux, but some members require SQL Server.
8. SQL Server database **snapshots** (`Administrator.Snapshots`, `Administrator.cs:993-1027`) are a SQL Server feature; on Postgres the equivalent is `CREATE DATABASE … WITH TEMPLATE` (`:983`) — **so the UI-test reset path does work on Linux, via Postgres.**

**`Signum.MSBuildTask` is *not* Windows-only** — despite the name, both `.targets` files invoke `dotnet <tool>.dll` (`Signum.MSBuildTask.targets:4`, `Signum.TSGenerator.targets:16`), so both run on any platform with the .NET SDK.

### Is a Linux-only dev loop viable?

**Yes** — with three caveats:

- ✅ **Build**: `dotnet build Signum.Framework.sln` (and per-project builds) work on Linux once the .NET 10 SDK is installed; IL weaving and TSGenerator are `dotnet`-invoked. TypeScript type-check via `yarn tsc -b` / `yarn tsgo -b` is platform-neutral.
- ✅ **Test**: `Signum.Analyzer.Test` (54, MSTest) and `Signum.Extensions.Test` (5, xUnit) need **no database**. `Signum.Test` (669) runs fully against **PostgreSQL only** — `ASPNETCORE_ENVIRONMENT=Postgres`, `Administrator.TotalGeneration` builds the schema, `MusicLoader` seeds it, and every SQL-Server-only test self-skips via `SkipException`. Postgres needs `ltree` + `pgvector`.
- ✅ **Run**: Kestrel (`dotnet run --project MyApp.Server`) + `yarn dev` (Vite) is fully cross-platform; the app's own Dockerfile is a **Linux** image (`mcr.microsoft.com/dotnet/aspnet:10.0`).
- ⚠️ **Caveat 1 — nothing is runnable on *this* machine right now**: no `dotnet`, no `yarn`, no database. Install the .NET 10 SDK + yarn + a Postgres (pgvector) container first.
- ⚠️ **Caveat 2 — you cannot build the two VSIX projects**, and you lose their VS-integrated shortcuts (replaceable with the CLI equivalents above) plus the code snippets.
- ⚠️ **Caveat 3 — the "official" IDE experience is Visual Studio on Windows.** `AGENTS.md`, the launch/tasks templates (`"windows"`-keyed), the `.runsettings` (a VSTest concept), `Integrated Security` connection strings, `playwright.ps1`, and the IIS troubleshooting steps all assume it. Expect to translate. There is **no CI in this repo** to crib a canonical Linux invocation from, so treat the commands in §2.3/§3.5/§4.3 as reconstructed-from-source rather than as a proven pipeline.
