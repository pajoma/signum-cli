# ADR 0005 — Rust as the implementation language

**Status:** ⚠️ **SUPERSEDED** by [ADR 0006 — TypeScript + Bun](0006-typescript-bun.md) on 2026-07-25.

> Superseded after the TypeScript route was **actually built and measured** on this hardware, which no
> prior language decision had been. Bun cross-compiles all five release targets from one Linux host —
> the release-engineering problem recorded below as a secondary reversal trigger. The trade accepted in
> exchange is ~10× binary size and the loss of compile-time enforcement described in "Why Rust suits
> *these* requirements", which is why the correctness tests are now release-blocking.

**Original status:** ACCEPTED — supersedes [ADR 0001](0001-implementation-language.md)
**Date:** 2026-07-25
**Owner decision:** Rust, with "might upstream to Signum" noted as a possibility.

## Context

ADR 0001 chose C# / .NET 10 + NativeAOT. It is superseded, not deleted — its analysis of *why the
obvious arguments for C# do not apply* remains valid and is the foundation of this decision.

Revisited now because **no source code exists**. All 15,000+ lines in this repo are requirements,
stories, and design notes, of which only ADR 0001, ADR 0003, and a section of `AGENTS.md` are
language-specific. Reversal cost is effectively zero today and rises sharply after the first commit
of implementation.

### What ADR 0001 established

- The Signum HTTP API is **generic** — type names, query keys, dotted token strings — so the client
  must be metadata-driven in any language. No DTO or `EntityJsonConverter` reuse is possible.
- NativeAOT forbids what `Signum.Utilities` does (`Expression.Compile()`, reflection-driven `Csv`,
  `DescriptionManager`, `GenericInvoker`), so no console-infrastructure reuse either.
- Conclusion: C# won on **audience and ecosystem fit alone**, with no technical advantage.

### What has changed since

1. **The AOT constraint has cost us twice.** It forced hand-rolling the Entra device-code grant
   rather than taking MSAL (ADR 0004 Decision 1), and — now that MCP server mode is a **v1**
   requirement (REQ-060) — the same audit applies to the C# MCP SDK, which does attribute-based tool
   discovery and is likely reflection-driven. A constraint that vetoes dependencies twice in a week is
   a structural tax, not an incident.
2. **The workload is fully specified and needs nothing platform-specific.** HTTP client, dynamic JSON,
   a small expression parser ([filter syntax](../design/filter-expression-syntax.md)), table/CSV/NDJSON
   rendering, stdio JSON-RPC, and a file credential store. The v1 auth path reduced to "read a token
   from stdin, store it, send a header" ([ADR 0004](0004-entra-primary-identity-provider.md)
   Decision 4).
3. **Two silent-corruption risks became the highest-stakes requirements** — `ResultTable`
   de-interning (STORY-21) and `modified` propagation (STORY-32). Both produce output that looks
   correct while being wrong. See "Why Rust suits *these* requirements" below.

## Decision

**Rust**, producing a statically linked single binary per target.

## Why Rust suits *these* requirements

Not generic advocacy — three specifics tied to what this CLI must do.

### 1. The two silent-corruption risks become type errors

The worst failure modes here are not crashes but plausible-looking wrong output:

- `ResultTable` columns may be *indices into an intern table* rather than values
  (`ResultTableConverter.cs:71-78`). Rendering a raw row emits wrong data silently.
- `modified: true` must be propagated to every ancestor or the server accepts the write, reports
  success, and discards the change.

Both can be made **unrepresentable** rather than merely tested: a newtype (`RawResultTable` vs
`ResolvedResultTable`) so no renderer can accept an un-de-interned row, and a constructor-guarded
type for a write payload that can only be produced by the propagating serializer. C# can approximate
this; Rust's move semantics and exhaustive matching enforce it at compile time, and there is no
reflection escape hatch to bypass it.

### 2. `serde` is exactly the dual model the API demands

The API is generic, so payloads are dynamic — but our own DTOs are fixed. `serde_json::Value` handles
the former and `#[derive(Serialize, Deserialize)]` the latter, both with **zero reflection**, which is
precisely the combination NativeAOT made awkward in C#. `#[serde(deny_unknown_fields)]` also maps
directly onto the server's rejection of unknown keys (AC-31.4).

### 3. Typed errors map cleanly to the exit-code taxonomy

REQ-051 demands a stable exit-code taxonomy distinguishing auth, not-found, validation, concurrency,
permission, and transport failures. A single error enum with exhaustive matching makes an unmapped
variant a compile error rather than a silent fallthrough to a generic code.

Plus the structural wins: no runtime, ~5–10 MB stripped, fast startup, and **no AOT-style audit on
every dependency** — the constraint that has already vetoed two libraries simply does not exist.

## Consequences

### Hard technical requirements

These are not preferences; each one serves a specific acceptance criterion.

| Requirement | Why |
|---|---|
| **`serde_json` with the `preserve_order` feature** | Default `Map` is a `BTreeMap` (alphabetical). AC-31.4 requires special properties **first** in entity JSON. Without `preserve_order` (IndexMap, insertion order) we cannot control key order and writes may be rejected. |
| **`rustls`, never `native-tls`/OpenSSL** | An OpenSSL dependency breaks the statically linked self-contained binary (REQ-070) and reintroduces a system dependency. |
| **`x86_64-unknown-linux-musl`** for Linux | Fully static; no glibc version coupling. |
| **No `unsafe`** (`#![forbid(unsafe_code)]`) | Nothing here needs it; it removes a class of risk outright. |
| **Warnings and clippy lints deny in CI** | Replaces the `IL2xxx`-as-errors discipline with the equivalent Rust hygiene. |

### Crate direction

Deliberately minimal; every dependency is a supply-chain and audit cost.

| Concern | Choice |
|---|---|
| CLI parsing | `clap` (derive) |
| JSON | `serde`, `serde_json` (+`preserve_order`) |
| HTTP | start with `ureq` (blocking, rustls, small); `reqwest`+rustls only if async/HTTP2 is genuinely needed |
| Filter DSL | **hand-rolled** Pratt parser — the grammar is small and a parser-combinator dependency is not worth it |
| TTY / colour | `std::io::IsTerminal` + `anstream`/`anstyle` (handles `NO_COLOR` per REQ-050) |
| Tables | `comfy-table`, or hand-rolled if it proves heavy |
| MCP | official `rmcp` SDK if mature enough — **verify**; otherwise hand-roll JSON-RPC over stdio (~300 lines) |
| Credentials | file with `0600` via `PermissionsExt`; OS keyring deferred, it adds platform coupling |
| Errors | `thiserror` for the typed enum; no `anyhow` in library paths where exit-code mapping matters |

### Distribution

[ADR 0003](0003-self-contained-distribution.md) is updated rather than superseded — the *requirement*
(one file, no dependencies) is unchanged; only the mechanics differ. Cross-compilation is **better
than NativeAOT but worse than Go**: Linux and Windows targets are reachable from one host via
`cargo-zigbuild` or `cross`, while macOS realistically still wants a macOS runner. Start with
`x86_64-unknown-linux-musl` only.

### Costs accepted

- **Contributor pool.** Signum developers read C# and TypeScript. A Rust CLI is unfamiliar territory
  for the ecosystem it serves.
- **Development pace.** Slower to a first working version than Go or TypeScript.
- **No framework code reuse** — but this was already true in every language (ADR 0001).

## Reversal triggers

**Primary: upstreaming becomes a real goal.** The owner flagged that this *might* be upstreamed into
Signum. If that becomes the intent, **this decision should be revisited immediately** — Signum is a
C#/TypeScript project, and asking its maintainers to adopt a Rust toolchain for one tool is a hard
sell regardless of technical merit. The tension was raised explicitly when the decision was taken and
was accepted knowingly; it is recorded here because the cost of switching grows with every commit.

Secondary triggers:

- Multi-platform release engineering (specifically macOS) proves more painful than expected → Go,
  which cross-compiles trivially.
- The Rust MCP ecosystem turns out to be immature enough that hand-rolling JSON-RPC becomes a
  significant burden → reassess.
- Outside contribution becomes important and Rust demonstrably deters it.

## Unvalidated

No Rust toolchain has been exercised on this machine and none of these crates has been compiled here.
Binary size, startup time, cross-compilation ergonomics, and `rmcp`'s maturity are all **expectations,
not measurements**. First implementation task: a hello-world static musl build with the real
dependency set, and record actual numbers here.
