# ADR 0001 — Implementation language

**Status:** ACCEPTED — C# / .NET 10, built as a NativeAOT single binary
**Date raised:** 2026-07-25
**Date decided:** 2026-07-25
**Constraint added by owner:** the CLI must be a **self-contained executable with no
dependencies** — a user drops one file and runs it, with no runtime to install.

Distribution mechanics that follow from this live in
[ADR 0003](0003-self-contained-distribution.md).

## Context

`signum-cli` is scoped as a **remote API client**: it talks to a running Signum application
over HTTP to run dynamic queries, retrieve and save entities, and execute operations.

The obvious assumption is "it's a .NET framework, write the CLI in C#". Analysis of the API
surface undermined that assumption, and the self-contained requirement then undermined the
remainder of it. The decision still lands on C#, but for narrower reasons than expected, and
those reasons are worth recording so nobody re-litigates it from the wrong premises.

## Finding 1 — the API is generic, so typing buys nothing

Endpoints are parameterised by type *names* (`api/entity/{type}/{id}`), query *keys*, and
dotted *token strings* — never by compiled domain types. A standalone CLI pointed at an
arbitrary customer application does **not** have that application's entity assemblies and
cannot get them.

Therefore:

- The CLI cannot use strongly-typed entity classes. It works with dynamic JSON shaped by
  metadata fetched at runtime from `api/reflection/types`.
- It cannot reuse `EntityJsonConverter`, which depends on `PropertyRoute` and
  `Schema.Current` — i.e. on a loaded schema built from the app's entity assemblies.
- So the usual decisive argument for C# — "you get the real DTOs and converters for free,
  with zero contract drift" — **does not apply.**

## Finding 2 — self-contained + AOT forbids the remaining reuse

The fallback argument for C# was free console infrastructure from `Signum.Utilities`
(`SafeConsole`, `ConsoleSwitch`, `Csv`, `ToConsoleTable`) — attractive because that project is
`net10.0` with one NuGet dependency and zero project references.

NativeAOT removes it:

- `Signum.Utilities/ExpressionTrees/` calls `Expression.Compile()` — dynamic codegen, which
  NativeAOT does not support.
- `Csv` typed mapping, `DescriptionManager`, `GenericInvoker`, and `Polymorphic<T>` are all
  reflection-driven in ways trimming cannot prove safe.
- `SafeConsole.SetConsoleCtrlHandler` is an unannotated **Windows-only P/Invoke**.

So the console layer is written from scratch regardless. **Both concrete technical arguments
for C# are now gone.** What remains is audience, ecosystem, and distribution.

## Finding 3 — what the CLI actually needs is AOT-clean

Fortunately the workload is a good AOT fit:

| Need | AOT status |
|---|---|
| `HttpClient` + JSON over HTTPS | fully supported |
| Dynamic JSON (`JsonNode` / `JsonDocument`) | fully supported, no reflection |
| Typed DTOs where we do have them | supported via `System.Text.Json` **source-generated** contexts |
| Console output, colour, tables | plain `Console` APIs |
| Argument parsing | greenfield either way (see below) |

Dynamic-JSON-first is not a compromise here — it is what a metadata-driven client wants
anyway. The design constraint and the design preference coincide.

## Not a differentiator

There is **no argument-parsing prior art anywhere in the framework**. A repo-wide grep finds
no `System.CommandLine` and no verb/flag/`--help`/usage/exit-code machinery — only `args[0]`
string comparisons in three MSBuild-task programs, and `Signum.Upgrade/Program.cs:8` accepts
`args` and ignores them entirely. Greenfield in any language.

## Options considered

### A. C# / .NET 10 + NativeAOT — **chosen**

- **For:** matches the framework and its contributor base — every Signum developer already has
  the .NET SDK and reads C#. Produces a true native binary (~15–30 MB, no runtime, ~5–20 ms
  startup) which satisfies the constraint exactly. Documented one-property retreat to
  `PublishSingleFile` if AOT proves painful (ADR 0003).
- **Against:** no .NET SDK on the current dev machine. Cross-compilation is awkward — needs a
  matching toolchain/linker per target, so multi-platform releases need per-platform CI
  runners. Forecloses a future "typed mode" that loads an app's entity assemblies, since that
  needs reflection and JIT.

### B. Go

- **For:** the best fit for the literal requirement — trivially self-contained, ~8–15 MB, and
  cross-compiles to every platform from a single machine with one env var. Excellent CLI
  ecosystem. Dynamic JSON is idiomatic.
- **Against:** ecosystem mismatch. A Go binary in a .NET framework's tooling orbit is an odd
  artifact that Signum contributors are less likely to maintain. This is the only reason it
  loses, and it is not a technical one.

### C. Rust

Smallest binary (~5–10 MB) and the strongest correctness story, but the steepest contribution
barrier of the three for this audience. Rejected on the same grounds as Go, more so.

### D. TypeScript / Node

Now the weakest option. "Self-contained, no dependencies" requires `bun build --compile`,
`deno compile`, or Node SEA — all producing 50–100 MB binaries via less mature toolchains,
while also forfeiting ecosystem fit. The one advantage that remained — that the framework's
browser client is a TypeScript reference implementation — is a *reading* aid only: the
de-interning logic lives in `Finder.tsx` and the surrounding modules are
React/`window`/`sessionStorage`-coupled, so reusing it means forking it.

## Decision

**C# / .NET 10, NativeAOT, published per-RID.**

The technical case between C#, Go, and Rust is close to neutral once you accept that the
client must be dynamic and metadata-driven in every language, and that no framework code can
be reused. The tie is broken on **audience**: this is a tool for Signum developers, in a .NET
ecosystem, and it should be a codebase they can contribute to without learning a new
language.

Go would be the choice if the priority were minimum release-engineering effort or the smallest
possible binary. That is a legitimate reversal trigger — see below.

## Consequences

- Install .NET SDK 10.x — nothing builds until then.
- **Do not reference `Signum.Utilities` or `Signum`.** The framework is a *reference to read*,
  not a dependency. This repo takes no `ProjectReference` on it and needs no submodule.
- Write the console layer (colour, tables, progress, prompts) from scratch, respecting
  `NO_COLOR`.
- Pick an AOT-compatible argument parser. Verify AOT support before committing to one;
  `System.CommandLine` is the default candidate but confirm its current AOT/trim story.
- `System.Text.Json`: `JsonNode`/`JsonDocument` for the dynamic entity/result payloads,
  source-generated `JsonSerializerContext` for our own fixed DTOs. **Never** reflection-based
  `JsonSerializer.Serialize<T>` without a context.
- Treat `IL2xxx`/`IL3xxx` trim and AOT warnings as **errors**, from the first commit. Retrofitting
  AOT-compatibility is far more expensive than maintaining it.
- Accept that "typed mode" is off the table. If it is ever wanted, it is a separate non-AOT
  tool, not a flag on this one.

## Reversal triggers

Revisit this ADR if any of these become true:

- Multi-platform release engineering (especially macOS arm64) proves more painful than the
  ecosystem benefit is worth → Go.
- AOT constraints force ugly workarounds in more than a couple of places → fall back to
  `PublishSingleFile` self-contained (ADR 0003) before changing language.
- A typed mode against app assemblies becomes a real requirement → that is a different tool.

## Unvalidated

No .NET SDK is installed on the current machine, so **none of the AOT claims here have been
compiled or measured** — binary size, startup time, and trim-warning cleanliness are all
expectations from documented .NET behaviour, not observations. Validate them with a
hello-world AOT publish before building anything substantial on them, and correct this ADR
with real numbers.
