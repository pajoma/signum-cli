# signum-cli

A command-line client for [Signum Framework](https://github.com/signumsoftware/framework)
applications — run dynamic queries, retrieve and save entities, and execute operations
against a running Signum app.

> **Status: pre-implementation.** This repository currently contains the architecture
> analysis and design groundwork. No CLI code exists yet — we are collecting requirements
> (see [`docs/requirements.md`](docs/requirements.md) and the issues labelled
> [`requirement`](https://github.com/pajoma/signum-cli/labels/requirement)).

Planned shape: a **self-contained executable** — one file, no runtime to install — written in
**TypeScript** and compiled with **Bun** ([ADR 0006](docs/decisions/0006-typescript-bun.md)).
Measured: 91 MB, 24 ms startup, and all five release targets cross-compiled from one Linux host.

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
| [`docs/requirements.md`](docs/requirements.md) | What the CLI must do — 48 requirements, mirrored as GitHub issues and triaged into milestones `m1`/`m2`/`m3`/`always`. |
| [`docs/stories/`](docs/stories/) | 32 user stories with acceptance criteria (auth, query, entities, operations). |
| [`docs/design/`](docs/design/) | Design specs — currently the filter expression syntax. |
| [`docs/target-application.md`](docs/target-application.md) | The deployment this must work against, and what it rules out. |
| [`docs/decisions/`](docs/decisions/) | ADRs: implementation language, self-contained distribution, and how to relate to the framework's built-in MCP server. |
| [`docs/reference/`](docs/reference/) | ~9,800 lines of deep analysis across seven areas, every claim cited to `file:line`. |
| [`AGENTS.md`](AGENTS.md) | Context and hard rules for coding agents. |

Everything in `docs/` was derived by reading Signum Framework at commit `74bd24693d`
(master, 2026-07). **None of it has been exercised against a live server yet** — treat it as
carefully-sourced hypothesis, and see the verification note at the end of `docs/http-api.md`.

## Decisions

**Settled.** [TypeScript + Bun single executable](docs/decisions/0006-typescript-bun.md).
The API is generic, so the client must be metadata-driven and no framework code is reusable in *any*
language — which left the earlier C# choice resting on audience alone
([ADR 0001](docs/decisions/0001-implementation-language.md), now superseded). Rust was chosen while
reversal was still free, partly because the two highest-stakes correctness risks — `ResultTable`
de-interning and `modified` propagation, both of which fail *silently* — can be made unrepresentable
in the type system rather than merely tested.
[Distribution mechanics](docs/decisions/0003-self-contained-distribution.md) cover the release story.

**Open.** [MCP relationship](docs/decisions/0002-mcp-vs-http.md) — `Extensions/Signum.Agent`
already ships a real MCP server whose skills overlap this CLI's scope. Recommendation: build
the deterministic HTTP client first and depend on nothing server-side, then consider exposing
*this* CLI as an MCP server so agents can drive any Signum app.

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

## License

Not yet chosen — see [#1](https://github.com/pajoma/signum-cli/issues).
