# ADR 0001 — Implementation language

**Status:** OPEN — needs a decision before any code is written
**Date raised:** 2026-07-25

## Context

`signum-cli` is scoped as a **remote API client**: it talks to a running Signum application
over HTTP to run dynamic queries, retrieve and save entities, and execute operations.

The obvious assumption is "it's a .NET framework, write the CLI in C#". Analysis of the API
surface undermines that assumption, so the decision deserves an explicit record.

## The finding that changes the calculus

**The Signum HTTP API is fully generic.** Endpoints are parameterised by type *names*
(`api/entity/{type}/{id}`), query *keys*, and dotted *token strings* — never by compiled
domain types. A standalone CLI pointed at an arbitrary customer application does **not**
have that application's entity assemblies, and cannot get them.

Consequences:

- The CLI cannot use strongly-typed entity classes. It must work with dynamic JSON shaped
  by metadata fetched at runtime from `api/reflection/types`.
- It cannot reuse `EntityJsonConverter`, because that converter depends on `PropertyRoute`
  and `Schema.Current` — i.e. on a loaded schema built from the app's entity assemblies.
- Therefore the usual decisive argument for C# — "you get the real DTOs and converters for
  free, with zero contract drift" — **does not apply here.**

What remains is a genuine trade-off on ergonomics, distribution, and audience.

## Options

### A. C# / .NET 10

**For**
- Matches the framework and its contributor base; every Signum developer already has the
  .NET 10 SDK installed.
- `dotnet tool install -g` is a clean distribution story.
- Can reference `Signum.Utilities` for free console infrastructure — it is `net10.0` with
  **one** NuGet dependency and **zero** project references, so this does *not* drag in
  ASP.NET or a database. Gets `SafeConsole` (colour, prompts, same-line status, wait
  spinners), `ConsoleSwitch` (interactive menus), `Csv`/`Tsv`, and
  `EnumerableExtensions.ToConsoleTable`.
- Leaves the door open to an **optional** typed mode later, for the case where the CLI *is*
  run from inside an application repo and can reference its entity assemblies.
- Can reuse the 8 Roslyn analyzer rules if the CLI ever generates C#.

**Against**
- No .NET SDK on the current development machine — setup cost before the first build.
- `Signum.Utilities` is only usable by adding the framework as a submodule (it is not on
  NuGet), which couples this repo to a framework checkout.
- Dynamic JSON manipulation is more ceremonious in C# than in TypeScript.
- One caveat found in analysis: `SafeConsole.SetConsoleCtrlHandler` is an unannotated
  **Windows-only P/Invoke** — needs care on Linux.

### B. TypeScript / Node

**For**
- Node v22.23.1 is already installed here — zero setup, immediate first build.
- Dynamic, metadata-driven JSON is TypeScript's native idiom, which is exactly the shape
  this API forces on us.
- `npx signum-cli` distribution needs no runtime install for users.
- The framework's own browser client already implements every wire subtlety in
  TypeScript — token handling, `New_Token` rotation, `GraphExplorer.propagateAll`,
  `ResultTable` de-interning — so it is available as a **reference implementation** to read.

**Against**
- That reference implementation cannot be *imported*: the de-interning logic lives in
  `Finder.tsx` and the surrounding modules are React/`window`/`sessionStorage`-coupled.
  Reusing it means forking it, which then drifts from upstream.
- Ecosystem mismatch: a TypeScript CLI in a .NET framework's tooling orbit is a slightly
  odd artifact for contributors.
- Nothing to reuse from `Signum.Utilities`; all console infrastructure written from scratch.
- Rules out any future typed mode.

## Not a differentiator

There is **no argument-parsing prior art anywhere in the framework** to inherit. A repo-wide
grep finds no `System.CommandLine` and no verb/flag/`--help`/usage/exit-code machinery — only
`args[0]` string comparisons in three MSBuild-task programs, and `Signum.Upgrade/Program.cs:8`
accepts `args` and ignores them entirely. Argument parsing is greenfield in either language.

## Recommendation

**Option A, C# / .NET 10** — on ecosystem fit rather than on technical reuse.

The technical case is close to neutral once you accept that the client must be
metadata-driven in either language. The tie is broken by audience and distribution: this is
a tool for Signum developers, who all have the .NET SDK, in an ecosystem where a
`dotnet tool` is the idiomatic shape. The optional-typed-mode escape hatch is worth
preserving, and free reuse of `SafeConsole`/`ConsoleSwitch`/`Csv`/`ToConsoleTable` is a real
if modest head start.

Choose Option B instead if any of these matter more: shipping something usable this week,
avoiding a framework submodule in this repo, or expecting non-.NET users.

## Consequences if A is chosen

- Install .NET SDK 10.x on the dev machine (nothing builds until then).
- Add `signum-framework` as a submodule at `Framework/`, matching the convention that
  `UpgradeContext.GetRootFolder()` expects, and `ProjectReference` only
  `Framework/Signum.Utilities/Signum.Utilities.csproj` — **not** `Signum.csproj`, which
  would pull in ASP.NET and the SQL clients.
- Pick an argument parser (`System.CommandLine` is the default choice) and build
  `--help`/exit codes/non-interactive mode from scratch.
- Guard the Windows-only `SetConsoleCtrlHandler` path.
