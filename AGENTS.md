# AGENTS.md

Shared context for coding agents in `signum-cli`.

## What this repo is

A command-line client for **Signum Framework** applications. Scope: talk to a *running*
Signum app over HTTP — run dynamic queries, retrieve and save entities, execute operations.

It is **not** a scaffolding or code-generation tool. That job already belongs to
`Signum.Upgrade` (source-code migration engine, 223 scripts) and `Signum/CodeGeneration/`.
Do not rebuild those here.

**Status: pre-implementation.** No code exists yet.

**Decided:** **TypeScript compiled with Bun** to a single executable — one file, no runtime to
install ([ADR 0006](docs/decisions/0006-typescript-bun.md), superseding ADR 0005 and ADR 0001;
[ADR 0003](docs/decisions/0003-self-contained-distribution.md) for distribution). This is the first
language choice backed by **measurements on this hardware**: 91 MB, 24 ms startup, and all five release
targets cross-compiled from one Linux host.

**Decided:** deterministic HTTP core, depending on nothing server-side; the CLI additionally
exposes *itself* as an MCP server so agents can drive any Signum app
([ADR 0002](docs/decisions/0002-mcp-vs-http.md)).

**Requirements** are collected in [`docs/requirements.md`](docs/requirements.md) — 51 of them,
mirrored as issues `#1`–`#47` and `#49`–`#52`, labelled
[`requirement`](https://github.com/pajoma/signum-cli/labels/requirement) plus a milestone. That
document is the source of truth; keep it and the issues in sync, via
`tools/sync-requirement-issues.py`.

**Milestones** (triaged 2026-07-25, replacing an earlier v1/v2 split that had 33 items in "v1"):

| | Count | Scope |
|---|---|---|
| [`m1`](https://github.com/pajoma/signum-cli/labels/m1) | 13 | **Read-only core.** No mutations. Safe to point at production. |
| [`m2`](https://github.com/pajoma/signum-cli/labels/m2) | 14 | Writes, entity fidelity, concurrency, profiles, tracing. |
| [`m3`](https://github.com/pajoma/signum-cli/labels/m3) | 18 | MCP, scale, and the auth paths unreachable on the target app. |
| [`always`](https://github.com/pajoma/signum-cli/labels/always) | 6 | Cross-cutting constraints; apply from the first commit, never "done". |

**Build m1 first, and do not smuggle writes into it.** Every write hazard in this API fails *quietly*
(`modified` propagation, `ticks` concurrency, `args` coercion), so a read-only m1 is what earns the
right to be pointed at production.

**User stories** live in [`docs/stories/`](docs/stories/) and *do* carry acceptance criteria,
tracing back to requirement ids. Written so far: [`auth.md`](docs/stories/auth.md) (STORY-01…12), [`privacy.md`](docs/stories/privacy.md) (STORY-50…53),
[`query.md`](docs/stories/query.md) (STORY-20…27), [`entities.md`](docs/stories/entities.md)
(STORY-30…34), [`operations.md`](docs/stories/operations.md) (STORY-40…46). All of REQ-001…REQ-046 is
now storied; output/UX (REQ-050…055), MCP (REQ-060…062) and non-functional (REQ-070…077) are not.

**Design specs** live in [`docs/design/`](docs/design/):

- [`cli-surface.md`](docs/design/cli-surface.md) — the command tree, global flags, output model, and
  exit codes. Modelled on `gh` and `kubectl`. **Read this before adding any command**, and keep it in
  step with the stories; the two drifted once already.
- [`filter-expression-syntax.md`](docs/design/filter-expression-syntax.md) — the filter DSL, the CLI's
  primary interface. Read before touching anything query-related.

**Command naming is settled** (cli-surface §8): verb-first for app nouns discovered at runtime
(`query`, `get`, `explain`), noun-verb for fixed tooling nouns (`auth`, `config`), and **operations are
first-class commands** — the key *is* the command (`signum Order.Ship …`), never `run` or `operation`.
Dispatch rule: **a first argument containing a `.` is an operation key**; built-ins never contain one
(`Symbol.cs:22`). Preserve that invariant — do not add a dotted built-in command.

**Requirements are not user stories.** They state what the CLI must do and carry **no
acceptance criteria** — do not add any, to the document or the issues. Implementation work is
tracked separately and references a requirement ID. When editing the register, regenerate the
issue bodies from the document rather than hand-editing both, so wording cannot drift.

## Read before working

| Doc | When |
|---|---|
| [`docs/architecture-overview.md`](docs/architecture-overview.md) | Always. Orientation on the framework. |
| [`docs/http-api.md`](docs/http-api.md) | **Before writing any request code.** The contract. |
| [`docs/target-application.md`](docs/target-application.md) | The deployment we must work against, and what it rules out. Read before designing auth or CI flows. |
| [`docs/reference/`](docs/reference/) | Deep dives, ~9,800 lines, every claim cited to `file:line`. Consult, don't read whole. |

The framework itself is at `/home/patrick.maue/git/sfcl/signum-framework` (sibling
checkout). Read it freely; **never modify it** — it is a fork of `signumsoftware/framework`
and `upstream` push is deliberately disabled.

## Hard rules

### Never put the API key in a URL

`RestLogFilter.cs:36-38` persists the whole query string into `RestLogEntity.QueryString`,
and the global exception logger does the same. A key in a query string is a credential
written to the customer's database in plaintext. **`X-ApiKey` header only.** The framework
exposes an `apiKey` query parameter (`RestApiKeyLogic.cs:9`); we do not use it, ever.

### Never commit credentials

No API keys, tokens, passwords, or connection strings in source, tests, fixtures, or docs.
Use `YOUR_API_KEY_HERE`-style placeholders and read real values from environment variables
or a gitignored local config. Test fixtures use obviously-fake values.

### There is no 401

Every auth failure from a Signum app is **403** (`SignumExceptionFilterAttribute.cs:131-146`).
Retry logic keyed on 401 is dead code.

### Adopt `New_Token`

When using Bearer auth, the server rotates the token by returning a replacement in the
**`New_Token` response header** (`AuthTokensServer.cs:85-94`). Adopt it, atomically.

Tokens **never expire** — `RefreshTokenEvery` (default 30 min) is a *rotation* interval, not a
lifetime. Ignoring the header therefore does **not** break authentication; it costs a database
hit on every request and **freezes the user's role permanently**, because `RoleEntity.Current`
reads the role from the token claim (`RoleEntity.cs:33`). A role change server-side only takes
effect after a rotation.

Also: a malformed, tampered, or wrong-key token is **swallowed server-side and degrades silently
to anonymous** — no distinct error. So after loading a stored token, verify it with
`GET api/auth/currentUser` before trusting it.

### Never auto-attempt password login

Password login must run **only** when the user explicitly selects it — never as an automatic
fallback from another mechanism. Two reasons, and the second is the serious one:

1. For AD/Entra-provisioned users it can never succeed. `AzureADAuthorizer.Login()` delegates to the
   ordinary local password check (`AzureADAuthorizer.cs:15-18`) — Signum never validates a password
   against Entra — and auto-created users get `PasswordHash = null` (`:43`), which
   `AuthLogic.cs:434,453` turns into `IncorrectPasswordException`.
2. Every failure counts toward `MaxFailedLoginAttempts`, which **deactivates the account**. An
   automatic retry chain can lock a real user out of the application.

### De-intern `ResultTable` before rendering

`rows[i].columns[j]` may be an **index into `uniqueValues[columns[j]]`**, not a value
(`ResultTableConverter.cs:71-78`). The `Entity` column is hoisted to `rows[i].entity`. Any
table/CSV/JSON output path must normalize this first, in one place.

### Mutation is always an operation

There is no save endpoint. `POST api/operation/executeEntity/{operationKey}`, where
`operationKey` is `ContainerClassName.FieldName` — not namespace-qualified
(`Signum/Basics/Symbol.cs:22`). E.g. `UserOperation.Save`.

### Propagate `modified`

`modified: true` must be set up the whole entity graph, not just on the changed leaf. The
browser client does this via `GraphExplorer.propagateAll` in `ajaxPostRaw`. Miss it and
saves silently drop changes — a nasty, quiet failure mode.

### `Type` vs `EntityType`

Full entities carry `Type` (clean name: `RoleEntity` → `"Role"`). Lites carry `EntityType`.
Mixing them throws server-side.

### Trust source over sibling docs

The framework's in-repo `.md` files lag the code. Confirmed drift: `[Serializable]` is gone,
`SqlDbTypeAttribute` → `DbTypeAttribute`, `NotNullable` → `ForceNotNullable`, operation
members are `CanBeNew`/`CanBeModified` (docs say `AllowNew`/`Lite`). When a doc and the
source disagree, the source wins — and fix the doc reference here.

### Cite what you verify

`docs/` claims are annotated with `file:line`. When you confirm something against a live
server, mark it `✅ verified against <version>`. When you find a doc claim to be wrong, fix
it in the same change. Nothing in `docs/` has been exercised against a running server yet —
it is all read from source at `74bd24693d`.

### Stay self-contained (TypeScript + Bun)

One executable, no runtime to install (REQ-070,
[ADR 0006](docs/decisions/0006-typescript-bun.md)). Measured: 91 MB linux-x64, 24 ms startup, and
**all five targets cross-compile from one Linux host**.

- **Build with `bun build --compile`.** There is **no npm-install distribution path** — that would
  violate REQ-070.
- **`fetch` and `JSON` are built in.** No HTTP client library, no TLS crate. Verified working inside a
  `--compile` bundle.
- **Keep the dependency tree small.** Every dependency is a supply-chain cost, and it must survive
  bundling.
- **No shelling out** to `curl`, `jq`, or `git`. In-process only.
- **Must run with zero setup** — flags and env vars, never a required config file. (The one accepted
  exception is the *optional* pseudonymization policy, REQ-057.)
- "Self-contained" means **no runtime to install**, not statically linked: the linux build links
  `libc.so.6`. Do not over-claim it.

### Types erase at runtime — so the tests are the safety net

This is the concession made when we moved off Rust
([ADR 0006](docs/decisions/0006-typescript-bun.md) cost 5). The two highest-stakes requirements fail
*quietly*, producing output that looks correct:

- `ResultTable` de-interning (STORY-21) — `rows[i].columns[j]` may be an **index** into
  `uniqueValues[...]`.
- `modified` propagation (STORY-32) — miss an ancestor and the server reports success and discards the
  write.

Required discipline:

- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- **Branded/opaque types at the boundary**, with a single parse-and-validate layer as their *only*
  producer. `JSON.parse` returns `any`; one cast defeats the whole scheme, so keep casts confined to
  that layer.
- **AC-21.3, AC-21.4, AC-31.6 and AC-32.3 are release-blocking tests.** In Rust they were
  belt-and-braces; here they are the belt. Do not downgrade them.

### Never leak personal data to a model

See [ADR 0007](docs/decisions/0007-ai-caller-detection-and-pseudonymization.md) and
[`docs/stories/privacy.md`](docs/stories/privacy.md).

- **Caller detection is not a security boundary.** Every signal (`AI_AGENT`, `CLAUDECODE`, parent
  process, TTY state) is spoofable in both directions and absent for unknown agents. It exists only to
  pick a **stricter** default, and it must **fail closed** — anything not provably `interactive` is at
  least `automated`. Never describe it as a guarantee, in code comments or help text.
- **m1 refuses to emit row data under a detected `agent` context** without an explicit acknowledgement
  flag (AC-51.2). Enforce this at the **output boundary**, in one place, so no new command can bypass it.
- **The framework gives us nothing.** There is no `[PersonalData]` attribute or sensitivity metadata
  anywhere in Signum, and this CLI is generic, so correct automatic classification is **impossible in
  principle**. Heuristics are a default, not a solution — say so in output (AC-52.6).
- **Pseudonymize, never redact** — stable surrogates keep the data usable. The surrogate→real mapping
  **never** appears in stdout, `--json`, MCP results, traces, logs, or telemetry (AC-53.3).
- **Never claim compliance.** Pseudonymized data is still personal data under GDPR Art. 4(5).

## Conventions

- LF line endings, matching the framework (`.gitattributes`: `* text=auto eol=lf`).
- Keep serialization in exactly one layer, so a later MCP server (ADR 0002, option C2) can
  sit on top of it without reimplementation.
- Design for non-interactive use first: real exit codes, machine-readable output
  (`--json`), no prompts unless a TTY is present. The framework's own tooling gets this
  wrong — `Signum.Upgrade` is interactive-only — so there is no house pattern to copy.
- Respect `NO_COLOR`.

## Git

- `main` is the default branch. **Never commit or push directly to it** — feature branch and
  PR, with human review.
- Never run publishing commands (`gh release`, `npm publish`, `dotnet nuget push`).
- The sibling framework checkout is a fork; never push to its `upstream`.

## Upstream security findings

Recorded in [`docs/architecture-overview.md#14`](docs/architecture-overview.md). These are
**pre-existing framework issues**, not ours: unauthenticated C#-executing endpoints in
`Signum.Dynamic`, an unsandboxed `Signum.Eval`, plaintext-stored REST API keys, and an auth
token using AES-CBC with an MD5-derived key and no HMAC.

Consequence for us: do not add CLI commands that surface `Signum.Dynamic` or `Signum.Eval`
evaluation endpoints without an explicit, deliberate discussion first. A convenient CLI
wrapper around remote code execution is a materially worse problem than the web endpoint.

## Environment

Node v22.23.1 is installed. **Bun is not on `PATH`** — install it (`npm i -g bun`, or locally per
project) before building. Nothing else is required; there is no .NET SDK or Rust toolchain and none is
needed.

Unlike every earlier iteration of these docs, the build figures here are **measured**
([ADR 0006](docs/decisions/0006-typescript-bun.md)): 91 MB linux-x64 (35 MB gzipped), 24 ms startup, and
five targets cross-compiled from one Linux host. Still unmeasured: the darwin/windows/arm64 artifacts
running on their actual platforms, and the MCP SDK inside a `--compile` bundle.

Reading the framework needs no toolchain at all.
