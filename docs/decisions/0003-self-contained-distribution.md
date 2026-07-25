# ADR 0003 — Self-contained distribution

**Status:** ACCEPTED
**Date:** 2026-07-25
**Requirement (owner):** the CLI must be a **self-contained executable with no
dependencies** — one file, dropped anywhere, runs. No .NET runtime install, no `node_modules`,
no PATH prerequisites.

Language decision: [ADR 0005 — Rust](0005-rust-implementation.md), which supersedes ADR 0001.

> **Updated 2026-07-25.** The *requirement* — one file, no dependencies — is unchanged. Only the
> mechanics below changed with the move from C#/NativeAOT to Rust. Where this document still describes
> `PublishAot`, `IL2xxx`, or `dotnet publish`, read it as historical; the Rust equivalents are:
>
> | Was (C#/AOT) | Now (Rust) |
> |---|---|
> | `dotnet publish -r <rid> -p:PublishAot=true` | `cargo build --release --target <triple>` |
> | `PublishSingleFile` fallback | no fallback needed — static linking is the default output |
> | `IL2xxx`/`IL3xxx` warnings as errors | `deny(warnings)` + clippy in CI; `#![forbid(unsafe_code)]` |
> | no reflection / no `Expression.Compile()` | not applicable — Rust has no reflection |
> | `InvariantGlobalization=false` to keep ICU | no ICU dependency; culture handling is explicit in code |
> | per-RID, one CI runner per OS family | `x86_64-unknown-linux-musl` first; Linux+Windows from one host via `cargo-zigbuild`/`cross`, macOS still wants a macOS runner |
>
> Two Rust-specific hard requirements are recorded in ADR 0005: **`rustls` never OpenSSL** (an OpenSSL
> dependency breaks static self-containment) and **`serde_json` with `preserve_order`** (needed for
> AC-31.4's key ordering).

## Decision

Ship **NativeAOT, per-RID single-file binaries**.

```
signum            (linux-x64, linux-arm64, osx-x64, osx-arm64)
signum.exe        (win-x64, win-arm64)
```

Publish shape:

```xml
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <InvariantGlobalization>false</InvariantGlobalization>
  <StackTraceSupport>false</StackTraceSupport>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

```bash
dotnet publish src/Signum.Cli -r linux-x64 -c Release
```

Expectation: ~15–30 MB per binary, ~5–20 ms startup. **Unmeasured** — no SDK on the dev
machine yet.

### `InvariantGlobalization` stays **off**

Tempting for size (drops ICU, several MB), but wrong here. The CLI formats dates, numbers and
decimals that came from a business database, and Signum apps are multi-culture by design —
the framework ships `Translations/*.{de,es,fr,it,pt}.xml` and derives CSV separators from the
current culture. Silently invariant formatting would corrupt output in ways users would not
immediately notice. Size is the cheaper thing to give up.

## What "no dependencies" forbids

Binding constraints on all code in this repo, from the first commit:

| Forbidden | Why | Instead |
|---|---|---|
| `ProjectReference` to `Signum.Utilities` / `Signum` | expression-tree `.Compile()` and reflection break AOT | write it; framework is reference-only |
| `Expression.Compile()`, `System.Reflection.Emit` | dynamic codegen unsupported | precompute or hand-write |
| `Assembly.Load`, plugin loading | no runtime assembly loading | compile features in |
| Reflection-based `JsonSerializer.Serialize<T>(obj)` | trimmer cannot prove shape | `JsonNode`/`JsonDocument`, or a source-generated `JsonSerializerContext` |
| `Activator.CreateInstance(Type)` on open-ended types | not statically known | explicit factories |
| Shelling out to `dotnet`, `curl`, `jq`, `git` | not a self-contained binary | in-process |
| Reading config from a required external file | must run with zero setup | flags + env vars, optional config file |

`IL2xxx`/`IL3xxx` trim and AOT analyzer warnings are **errors**. Retrofitting AOT-cleanliness
costs far more than maintaining it.

## Cross-compilation is the real cost

NativeAOT does **not** cross-compile comfortably: each target needs a matching native
toolchain and linker. Practical consequence — a release needs **one CI runner per OS family**:

| Runner | Targets |
|---|---|
| `ubuntu-latest` | linux-x64 (+ linux-arm64 via cross toolchain) |
| `macos-latest` | osx-arm64, osx-x64 |
| `windows-latest` | win-x64 |

This is the one place Go would have been materially easier (one runner, `GOOS`/`GOARCH`) and
it is recorded as a reversal trigger in ADR 0001. Since the framework repo has **no CI at
all**, this repo's release workflow is greenfield — no house pattern to copy.

Start with `linux-x64` only. Add platforms when someone needs them.

## Documented fallback

If AOT constraints force ugly workarounds in more than a couple of places, retreat to
**self-contained single-file, JIT** before changing language:

```xml
<PublishSingleFile>true</PublishSingleFile>
<SelfContained>true</SelfContained>
<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
```

Still satisfies "one file, no runtime install" — ~70–80 MB, ~50–80 ms startup, full
reflection available, and it cross-compiles trivially (`-r <any-rid>` from any host). Strictly
worse as an artifact, strictly easier to build. Deliberately kept as an escape hatch: staying
AOT-clean costs little if decided early, and this retreat is one property away.

## Not chosen

- **`dotnet tool install -g`** — the idiomatic .NET CLI distribution, but requires the SDK.
  Violates the requirement. Could be offered *additionally* later for developers who have it.
- **Docker image** — not a dropped-in executable.
- **Framework-dependent publish** — needs a matching runtime installed.

## Open

- Which argument parser is AOT-clean. `System.CommandLine` is the candidate; **verify its
  current AOT/trim story before adopting it**, and be ready to hand-roll — the parsing surface
  for a verb-based client is small.
- Checksums and signing for releases. Unsigned macOS binaries are quarantined by Gatekeeper;
  Windows SmartScreen warns on unsigned executables. Decide before the first public release,
  not after.
- Whether to also publish a `dotnet tool` for convenience.
