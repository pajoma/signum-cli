# ADR 0006 — TypeScript compiled with Bun

**Status:** ACCEPTED — supersedes [ADR 0005](0005-rust-implementation.md)
**Date:** 2026-07-25
**Owner decision:** switch to TypeScript with Bun.

## Context

ADR 0005 chose Rust; ADR 0001 before it chose C#. Both are superseded. This one is different in kind:
it is the first language decision backed by **measurements taken on the target hardware** rather than
expectations.

Still no source code exists, so reversal remains cheap.

## Measurements

A representative probe — argument parsing, HTTPS + dynamic JSON, `ResultTable` de-interning, TTY-aware
output switching, exit-code taxonomy; no external dependencies — compiled with
`bun build --compile --minify` on this Linux host, 2026-07-25, Bun 1.3.14.

| Target | Size | Cross-compiled from Linux? |
|---|---|---|
| linux-x64 | **91 MB** (35 MB gzipped) | native |
| linux-x64-musl | 87 MB | ✅ |
| linux-arm64 | 90 MB | ✅ |
| darwin-arm64 | 121 MB | ✅ |
| windows-x64 | 188 MB | ✅ |

Verified behaviour, not merely a successful build:

- Runs under `env -i` with no Node on `PATH` — genuinely self-contained (REQ-070).
- Real TLS request to a public HTTPS endpoint succeeded.
- `ResultTable` de-interning produced correct values from an interned payload.
- TTY detection switched to JSON when piped (REQ-050).
- Usage error returned exit code 2 (REQ-051).
- **Startup: 24 ms** averaged over 10 runs.

## Decision

**TypeScript, compiled to a single executable with `bun build --compile`.**

### The deciding factor: cross-compilation

Every prior candidate had a release-engineering problem. NativeAOT needed one CI runner per OS family.
Rust needed `cargo-zigbuild`/`cross` for Linux and Windows and realistically **still a macOS runner** —
recorded as ADR 0005's secondary reversal trigger.

Bun cross-compiles to **all five targets from one Linux machine**, with no toolchain, no Docker, and no
second runner. That is measured above, not hoped for. It collapses REQ-073 from a multi-runner CI matrix
into a single `for` loop.

Secondary: it builds *today*. Node 22 is installed, Bun installs from npm in seconds, and no toolchain
is missing — whereas Rust and .NET both required an install that had not happened.

## Costs, accepted explicitly

These are real and are not being minimised.

1. **Size: 91 MB, versus ~5–10 MB expected for Rust.** ~99 % of that is the embedded Bun runtime — the
   `bun` binary alone is 88 MB — so it is nearly constant regardless of how much code we write. 35 MB
   gzipped is the practical download. Windows is 188 MB, which is genuinely large.
2. **Startup 24 ms, versus ~5 ms for Rust.** Irrelevant to a human; it matters if an agent invokes the
   binary hundreds of times in a loop, so it is worth watching (REQ-072).
3. **Not truly static.** The linux-x64 build links `libc.so.6`; the musl target links the musl loader.
   "Self-contained" here means *no runtime to install*, **not** *runs on any kernel*. Rust with `musl`
   would have been genuinely static. REQ-070's wording is accurate but this nuance belongs with it.
4. **Bun is a young runtime**, and it is now both our build toolchain and our runtime.
5. **The strongest argument for Rust is weakened.** ADR 0005's central technical case was making the two
   silent-corruption risks *unrepresentable*: `ResultTable` de-interning (STORY-21) and `modified`
   propagation (STORY-32). TypeScript can approximate this with branded/opaque types, but they **erase at
   runtime**, and `JSON.parse` returns `any` — one cast defeats them. The probe's `deintern` throws at
   runtime on an out-of-range index; Rust would have refused to compile the un-de-interned path.

   **Mitigation, now mandatory rather than optional:** branded types at the boundary, a single
   parse-and-validate layer that is the only producer of the branded values, `strict` plus
   `noUncheckedIndexedAccess`, and — because the compiler cannot enforce it — the round-trip and
   de-interning tests of AC-21.3, AC-21.4, AC-31.6 and AC-32.3 are **release-blocking**, not
   nice-to-have. In Rust they were belt-and-braces; here they are the belt.

## Consequences

| Area | Change |
|---|---|
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Build | `bun build --compile --minify --target=<t>`; five targets from one host |
| Runtime deps | none embedded beyond Bun itself; keep the dependency tree small |
| HTTP | built-in `fetch` — no client library needed (verified working in the probe) |
| JSON | built-in; **key insertion order is preserved** by JS objects, which satisfies AC-31.4 with no special configuration (this was a hard requirement needing an opt-in feature in Rust) |
| Filter DSL parser | still hand-rolled; the grammar is small |
| MCP | the TypeScript MCP SDK is the reference implementation — the most mature of any language, which directly serves REQ-060 |
| Credentials | file with `0600` via `chmod`; no keyring dependency |
| Tests | `bun test`; correctness tests are release-blocking (see mitigation above) |
| Distribution | `bun build --compile` artifacts + checksums; **no** npm-install path, since that would violate REQ-070 |

### Superseded technical rules

ADR 0005's two hard requirements are now moot: `rustls`-not-OpenSSL (Bun's `fetch` handles TLS
in-runtime) and `serde_json/preserve_order` (JS objects preserve insertion order natively). Both existed
to serve REQ-070 and AC-31.4 respectively; both are satisfied by default here.

## Reversal triggers

- **Binary size becomes a genuine blocker** — e.g. distribution constraints, or the 188 MB Windows
  artifact proving unacceptable → Rust or Go.
- **A silent-corruption bug reaches a release.** That would be direct evidence the type-system
  concession in cost 5 was the wrong call.
- **Per-invocation startup becomes a bottleneck** for agent use (REQ-072).
- **Upstreaming to Signum becomes a real goal.** Unchanged from ADR 0005: Signum is C#/TypeScript, so
  TypeScript is *considerably* less alien there than Rust — this trigger is now much weaker, and is
  arguably an argument *for* this decision.

## Unvalidated

Measured: size, cross-compilation, startup, TLS, de-interning, TTY switching, exit codes. **Not**
measured: behaviour of the cross-compiled darwin/windows/arm64 artifacts on their actual platforms (only
that they build and are the right binary format), Bun's long-term stability, and the MCP SDK inside a
`--compile` bundle.
