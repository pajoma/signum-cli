# signum-cli

A command-line client for [Signum Framework](https://github.com/signumsoftware/framework)
applications — run dynamic queries, retrieve and save entities, and execute operations
against a running Signum app.

> **Status: `v0.2.1`, milestone `m1` (read-only core).** A patch release of `v0.2.0`, the first
> full release, which followed the pre-releases `v0.1.0-b.*`; see [`CHANGELOG.md`](CHANGELOG.md). It can discover, query and read;
> it cannot write yet — saving entities and executing operations are milestone `m2`. Requirements live in
> [`docs/requirements.md`](docs/requirements.md) and the issues labelled
> [`requirement`](https://github.com/pajoma/signum-cli/labels/requirement).

Shape: a **self-contained executable** — one file, no runtime to install — written in
**TypeScript** and compiled with **Bun** ([ADR 0006](docs/decisions/0006-typescript-bun.md)).
Measured: 91 MB, 24 ms startup, and all five release targets cross-compiled from one Linux host.

## Usage

```
signum --url https://your-app types                  # explore; entities may need a login
signum auth login --url https://your-app --with-token
signum auth status                                   # who am I, against what
signum queries                                       # what can I query?
signum explain Order.Entity.Customer                 # walk the query-token schema
signum query Order --filter 'Customer.Name ~ "Acme"' --json
signum get Order 42
signum help                                          # commands, topics, exit codes
```

| Command | Purpose |
|---|---|
| `auth login` / `status` / `logout` | Store, check or remove a credential for a target |
| `types`, `queries`, `operations` | Discover what the application exposes |
| `explain` | Describe a type, a query-token path, or an operation |
| `query` | Run a dynamic query (filter syntax: `signum help filter`) |
| `get` | Retrieve one entity by type and id, or by Lite key |
| `unmask` | Resolve local `ref_` pseudonym handles back to the records they stand for |
| `cache` | Inspect or clear cached application metadata |
| `instance` | Register short names for target URLs, then use `-i <name>` instead of `--url` |
| `version` | CLI version, and the target's when reachable |

Configuration is flags and environment variables — `SIGNUM_URL`, `SIGNUM_INSTANCE`, `SIGNUM_TOKEN`,
`SIGNUM_OFFLINE`, `SIGNUM_CONFIG_DIR`, `SIGNUM_CALLER_CONTEXT`, `SIGNUM_PSEUDONYMIZE`,
`SIGNUM_ALLOW_AGENT_DATA` — plus named instances (`signum instance add app https://app.example.org`,
then `signum -i app types`), stored in the config directory. Output is a table on a terminal and JSON when piped; override with `-o`.

**Under an AI agent.** The CLI detects agent callers (e.g. `CLAUDECODE`, `AI_AGENT`) and then
refuses to print row data unless pseudonymization is on or the data is explicitly acknowledged
([ADR 0007](docs/decisions/0007-ai-caller-detection-and-pseudonymization.md),
[ADR 0009](docs/decisions/0009-agent-mediated-privacy.md)). Detection only picks a stricter default;
it is not a security boundary. See `signum help pseudonymization`.

## Why

Signum's HTTP API is fully generic: endpoints are parameterised by type *names*, query
*keys*, and dotted *token strings*, never by compiled domain types. That means a single
client binary can work against **any** Signum application, discovering its domain at runtime
from `api/reflection/types`. There is no such client today, and no argument-parsing surface
anywhere in the framework to build on.

Out of scope: scaffolding and code generation. `Signum.Upgrade` (a source-code migration
engine with 223 scripts) and `Signum/CodeGeneration/` already own that.

## What's here

| | |
|---|---|
| [`docs/architecture-overview.md`](docs/architecture-overview.md) | How the framework works — entity model, ORM, LINQ provider, operations, DynamicQuery, the 57 extension modules. Start here. |
| [`docs/http-api.md`](docs/http-api.md) | The API contract this CLI is built against: auth, endpoints, serialization rules, QueryToken grammar. |
| [`docs/requirements.md`](docs/requirements.md) | What the CLI must do — 54 requirements, mirrored as GitHub issues and triaged into milestones `m1`/`m2`/`m3`/`always`. |
| [`docs/stories/`](docs/stories/) | 40 user stories with acceptance criteria (auth, query, entities, operations, privacy, help). |
| [`docs/design/`](docs/design/) | Design specs — the [CLI surface](docs/design/cli-surface.md) (command tree, flags, exit codes) and the [filter expression syntax](docs/design/filter-expression-syntax.md). |
| [`docs/target-application.md`](docs/target-application.md) | The deployment this must work against, and what it rules out. |
| [`docs/decisions/`](docs/decisions/) | ADRs: implementation language, self-contained distribution, the MCP relationship, Entra identity, privacy under AI callers, and browser token capture. |
| [`src/`](src/), [`test/`](test/) | The CLI: `cli.ts` dispatches to `commands/`; shared logic (HTTP, auth tokens, filter parser, `ResultTable` de-interning, privacy gate) is in `core/`. |
| [`docs/reference/`](docs/reference/) | ~9,800 lines of deep analysis across seven areas, every claim cited to `file:line`. |
| [`AGENTS.md`](AGENTS.md) | Context and hard rules for coding agents. |

Everything in `docs/` was derived by reading Signum Framework at commit `74bd24693d`
(master, 2026-07). **None of it has been exercised against a live server yet** — the CLI's tests run
against mocked responses. Treat the docs as carefully-sourced hypothesis, and see the verification
note at the end of `docs/http-api.md` and the
[live verification runbook](docs/reference/live-verification-runbook.md).

## Decisions

**Settled.** [TypeScript + Bun single executable](docs/decisions/0006-typescript-bun.md).
The API is generic, so the client must be metadata-driven and no framework code is reusable in *any*
language — which left the earlier C# choice resting on audience alone
([ADR 0001](docs/decisions/0001-implementation-language.md), now superseded). Rust
([ADR 0005](docs/decisions/0005-rust-implementation.md)) came next and was superseded by measurements.
The price of leaving it: the two silent-failure risks — `ResultTable` de-interning and `modified`
propagation — are guarded by release-blocking tests rather than by the type system.
[Distribution mechanics](docs/decisions/0003-self-contained-distribution.md) cover the release story.

**Settled.** [MCP relationship](docs/decisions/0002-mcp-vs-http.md) — a deterministic HTTP core that
depends on nothing server-side, with the CLI itself exposed as an MCP server (milestone `m3`).
Privacy for agent callers ([ADR 0007](docs/decisions/0007-ai-caller-detection-and-pseudonymization.md),
[ADR 0009](docs/decisions/0009-agent-mediated-privacy.md)) and
[browser-driven token capture](docs/decisions/0008-browser-driven-token-capture.md) have their own
ADRs.

## Two things to know before writing any request code

- **The API key goes in the `X-ApiKey` header, never a query string.** The framework's
  `RestLogFilter` persists whole query strings into the application database.
- **Auth failures are `403`, never `401`.** And bearer tokens rotate via a `New_Token`
  response header the client must adopt.

## Development

Requires a sibling checkout of the framework for reference:

```
git/sfcl/
├── signum-framework/   ← read-only reference
└── signum-cli/         ← this repo
```

Common commands (Bun). Bun is also a pinned devDependency: if it is not on your `PATH`, `npm ci`
installs it and `npx bun …` runs it.

```
bun install            # or: npm ci
bun run check          # typecheck + tests (the CI gate)
bun run build          # single binary for this host → dist/signum
bun run build:all      # all platform binaries + SHA256SUMS → dist/
```

## Building & releasing

CI is GitHub Actions (`.github/workflows/`):

- **`ci.yml`** — runs `check` (typecheck + `bun test`) on every PR into `develop`/`main`
  (issue #57). No PR merges red.
- **`release.yml`** — on a pushed tag, builds the self-contained binaries for linux/macOS/
  windows (all cross-compiled from one Linux job) and publishes a GitHub Release with a
  `SHA256SUMS` manifest (issue #56).

Versioning is **SemVer**, and **`package.json` is the source of truth** — a tag must match it.

| Channel | Cut from | Tag | Result |
|---|---|---|---|
| Pre-release | `develop` | `v0.1.0-b.1` (SemVer pre-release) | GitHub Release marked *pre-release* |
| Release | `main` | `v0.1.0` (plain SemVer) | full GitHub Release |

To cut a release: bump `version` in `package.json`, commit, then tag `v<that-version>` and push
the tag. The pipeline refuses a tag that doesn't match `package.json`, a PEP 440 tag
(`0.1.0b1`), or a channel mismatch (a pre-release tag on `main`, or vice versa).

**Installing:** download the binary for your platform from the
[releases page](https://github.com/pajoma/signum-cli/releases), check it against `SHA256SUMS`, then:

```
chmod +x signum-<version>-linux-x64
./signum-<version>-linux-x64 --url https://your-app types   # explore; entities may need a login
```

> **Maintainer setup (one-time):** require the `check` status on `develop` and `main` in branch
> protection so the PR gate actually blocks merges. A workflow can't configure its own protection
> rule (issue #57).

## License

Not yet chosen — see [#1](https://github.com/pajoma/signum-cli/issues).
