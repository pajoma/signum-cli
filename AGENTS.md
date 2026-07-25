# AGENTS.md

Shared context for coding agents in `signum-cli`.

## What this repo is

A command-line client for **Signum Framework** applications. Scope: talk to a *running*
Signum app over HTTP — run dynamic queries, retrieve and save entities, execute operations.

It is **not** a scaffolding or code-generation tool. That job already belongs to
`Signum.Upgrade` (source-code migration engine, 223 scripts) and `Signum/CodeGeneration/`.
Do not rebuild those here.

**Status: pre-implementation.** No code exists yet.

**Decided:** C# / .NET 10, shipped as a **NativeAOT self-contained single binary** — one file,
no runtime to install ([ADR 0001](docs/decisions/0001-implementation-language.md),
[ADR 0003](docs/decisions/0003-self-contained-distribution.md)).

**Decided:** deterministic HTTP core, depending on nothing server-side; the CLI additionally
exposes *itself* as an MCP server so agents can drive any Signum app
([ADR 0002](docs/decisions/0002-mcp-vs-http.md)).

**Requirements** are collected in [`docs/requirements.md`](docs/requirements.md) — 48 of them,
mirrored as issues `#1`–`#47` and `#49`, labelled
[`requirement`](https://github.com/pajoma/signum-cli/labels/requirement) plus `v1`/`v2`. That
document is the source of truth; keep it and the issues in sync. Both former spikes are resolved,
so the `spike` label is currently empty.

**User stories** live in [`docs/stories/`](docs/stories/) and *do* carry acceptance criteria,
tracing back to requirement ids. Written so far: [`auth.md`](docs/stories/auth.md) (STORY-01…12),
[`query.md`](docs/stories/query.md) (STORY-20…27), [`entities.md`](docs/stories/entities.md)
(STORY-30…34), [`operations.md`](docs/stories/operations.md) (STORY-40…46). All of REQ-001…REQ-046 is
now storied; output/UX (REQ-050…055), MCP (REQ-060…062) and non-functional (REQ-070…077) are not.

**Design specs** live in [`docs/design/`](docs/design/) — currently
[`filter-expression-syntax.md`](docs/design/filter-expression-syntax.md), the CLI's primary
interface. Read it before touching anything query-related.

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

### Stay NativeAOT-clean

The binary must be self-contained with no dependencies, which forbids a specific list of
things. Full table and rationale in [ADR 0003](docs/decisions/0003-self-contained-distribution.md);
the ones you will actually reach for by reflex:

- **No `ProjectReference` to `Signum.Utilities` or `Signum`.** The framework is a reference to
  *read*, not a dependency — its `ExpressionTrees/` calls `.Compile()` and its `Csv`/
  `DescriptionManager`/`GenericInvoker` are reflection-driven, none of which survives AOT. This
  repo needs no framework submodule. Write the console layer.
- **No `Expression.Compile()`, `Reflection.Emit`, `Assembly.Load`, or
  `Activator.CreateInstance` on open-ended types.**
- **No reflection-based `JsonSerializer.Serialize<T>(obj)`.** Use `JsonNode`/`JsonDocument`
  for the dynamic entity and `ResultTable` payloads, and a source-generated
  `JsonSerializerContext` for our own fixed DTOs.
- **No shelling out** to `dotnet`, `curl`, `jq`, or `git`. In-process only.
- **Must run with zero setup** — flags and env vars, never a required external config file.

`IL2xxx`/`IL3xxx` trim and AOT warnings are **errors**. Do not suppress them to make a build
pass; fix the cause or raise it. Retrofitting AOT-cleanliness is far more expensive than
maintaining it.

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

**No .NET SDK installed** — nothing builds until .NET 10.x is present. Node v22.23.1 exists but
is irrelevant now that ADR 0001 chose C#.

Before building anything substantial, do a hello-world `PublishAot=true` publish and record the
real binary size, startup time, and warning cleanliness in ADR 0003 — every AOT number in these
docs is a documented-behaviour expectation, **not a measurement**.

Reading the framework needs no toolchain at all.
