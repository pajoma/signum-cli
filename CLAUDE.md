# CLAUDE.md

See [`AGENTS.md`](AGENTS.md) for all shared agent context, hard rules, and conventions.

Quick orientation:

- **What this is:** a CLI that talks to running Signum Framework apps over HTTP.
- **Status:** pre-implementation — currently collecting requirements
  ([`docs/requirements.md`](docs/requirements.md), tracked as GitHub issues labelled
  `requirement`).
- **Decided:** **TypeScript + Bun**, compiled to a single executable
  ([ADR 0006](docs/decisions/0006-typescript-bun.md), superseding ADR 0005/0001). Measured: 91 MB,
  24 ms startup, five targets cross-compiled from one Linux host. The framework is a **reference to
  read, never a dependency**.
- **Privacy:** caller detection is **not** a security boundary, and m1 refuses to emit row data under a
  detected AI caller without an explicit flag
  ([ADR 0007](docs/decisions/0007-ai-caller-detection-and-pseudonymization.md)).
- **Still open:** [ADR 0002](docs/decisions/0002-mcp-vs-http.md) — MCP relationship.
- **Before writing request code:** read [`docs/http-api.md`](docs/http-api.md).
- **The framework** is a sibling checkout at `../signum-framework` — read it, never modify it.

The three rules most likely to be violated by accident:

1. API key goes in the `X-ApiKey` **header**, never a query string (it gets logged to the
   customer's database).
2. Auth failures are **403, never 401**.
3. `ResultTable` columns may be **indices into an intern table**, not values.
