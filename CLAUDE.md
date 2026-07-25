# CLAUDE.md

See [`AGENTS.md`](AGENTS.md) for all shared agent context, hard rules, and conventions.

Quick orientation:

- **What this is:** a CLI that talks to running Signum Framework apps over HTTP.
- **Status:** pre-implementation. Two open ADRs block coding —
  [language](docs/decisions/0001-implementation-language.md) and
  [MCP relationship](docs/decisions/0002-mcp-vs-http.md).
- **Before writing request code:** read [`docs/http-api.md`](docs/http-api.md).
- **The framework** is a sibling checkout at `../signum-framework` — read it, never modify it.

The three rules most likely to be violated by accident:

1. API key goes in the `X-ApiKey` **header**, never a query string (it gets logged to the
   customer's database).
2. Auth failures are **403, never 401**.
3. `ResultTable` columns may be **indices into an intern table**, not values.
