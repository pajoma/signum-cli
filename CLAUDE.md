# CLAUDE.md

See [`AGENTS.md`](AGENTS.md) for all shared agent context, hard rules, and conventions.

Quick orientation:

- **What this is:** a CLI that talks to running Signum Framework apps over HTTP.
- **Status:** pre-implementation — currently collecting requirements
  ([`docs/requirements.md`](docs/requirements.md), tracked as GitHub issues labelled
  `requirement`).
- **Decided:** **Rust**, as a statically linked single binary
  ([ADR 0005](docs/decisions/0005-rust-implementation.md), superseding ADR 0001;
  [ADR 0003](docs/decisions/0003-self-contained-distribution.md)). The framework is a **reference to
  read, never a dependency** — nothing is reusable from it in any language, because the API is
  generic. Hard rules: `rustls` never OpenSSL, and `serde_json` with `preserve_order`.
- **Still open:** [ADR 0002](docs/decisions/0002-mcp-vs-http.md) — MCP relationship.
- **Before writing request code:** read [`docs/http-api.md`](docs/http-api.md).
- **The framework** is a sibling checkout at `../signum-framework` — read it, never modify it.

The three rules most likely to be violated by accident:

1. API key goes in the `X-ApiKey` **header**, never a query string (it gets logged to the
   customer's database).
2. Auth failures are **403, never 401**.
3. `ResultTable` columns may be **indices into an intern table**, not values.
