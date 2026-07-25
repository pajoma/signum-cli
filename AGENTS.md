# AGENTS.md

Shared context for coding agents in `signum-cli`.

## What this repo is

A command-line client for **Signum Framework** applications. Scope: talk to a *running*
Signum app over HTTP — run dynamic queries, retrieve and save entities, execute operations.

It is **not** a scaffolding or code-generation tool. That job already belongs to
`Signum.Upgrade` (source-code migration engine, 223 scripts) and `Signum/CodeGeneration/`.
Do not rebuild those here.

**Status: pre-implementation.** No code exists yet. Two decisions are open and block
coding — read them first:

- [`docs/decisions/0001-implementation-language.md`](docs/decisions/0001-implementation-language.md) — C# vs TypeScript
- [`docs/decisions/0002-mcp-vs-http.md`](docs/decisions/0002-mcp-vs-http.md) — relationship to the built-in MCP server

If you are asked to write CLI code and these are still `OPEN`, say so and ask — do not pick
silently.

## Read before working

| Doc | When |
|---|---|
| [`docs/architecture-overview.md`](docs/architecture-overview.md) | Always. Orientation on the framework. |
| [`docs/http-api.md`](docs/http-api.md) | **Before writing any request code.** The contract. |
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
**`New_Token` response header** (`AuthTokensServer.cs:66-102`). The client must adopt it.
Not doing this produces a working client that mysteriously 403s after ~30 minutes.

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

Node v22.23.1 present. **No .NET SDK and no yarn installed** — if ADR 0001 lands on C#,
nothing builds until .NET 10 is installed. A full framework dev loop additionally needs
PostgreSQL with `ltree` + `pgvector`.
