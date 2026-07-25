# ADR 0002 — Relationship to the built-in `Signum.Agent` MCP server

**Status:** OPEN — decide before designing the command set
**Date raised:** 2026-07-25

## Context

While analysing `Extensions/`, we found that the framework already ships an agentic access
layer that is **not** just an in-app chatbot:

`Extensions/Signum.Agent` exposes a real **MCP server** (`AgentLogic.cs:269`). Its design:

- A *skill* pairs an `.md` prompt file with a `.cs` tool class, matched by filename —
  e.g. `SearchSkill` ↔ `Skills/Search.md` (`SkillCode.cs:38`).
- Tools are `[McpServerTool]`-attributed methods, reflected into `AIFunction`s **using the
  Signum JSON converters**, so entities and `Lite<T>` round-trip natively rather than being
  flattened to strings.
- Lazy tool disclosure via `Describe` + `ToolListChangedNotification`.
- Prompts are database-editable business objects (`SkillCustomizationEntity`).
- Existing skills already cover the operations a remote client wants: `Search`, `Retrieve`,
  `Operation`, `Autocomplete`, `Chart`, `EntityUrl`, `GetUIContext`, `CurrentServerContext`.

So there is already a remote, typed, entity-aware access path into a Signum application —
overlapping substantially with the CLI's stated scope.

## Why this matters

The CLI's scope (query / retrieve / save / execute operations) is close to the union of the
`Search`, `Retrieve`, and `Operation` skills. Building a raw HTTP client duplicates work that
the framework already did, and duplicates its bug surface.

But MCP is not a free win either — it is designed for LLM consumption, is only present if
`Signum.Agent` is started in the target app, and routes through an LLM-oriented tool layer
rather than giving direct deterministic access.

## Options

### A. Raw HTTP client only (the current implicit plan)

Talk directly to `api/query/*`, `api/entity/*`, `api/operation/*`.

- **For:** works against *any* Signum app, including ones without `Signum.Agent`. Fully
  deterministic. No LLM in the path. Complete control over output formatting and exit codes.
- **Against:** must reimplement every wire subtlety ourselves (`New_Token` rotation,
  `ResultTable` de-interning, `modified` propagation, `Type` vs `EntityType`).

### B. MCP client only

Speak MCP to the target app's `Signum.Agent` server.

- **For:** reuses the framework's own serialization; skills are maintained upstream;
  automatically gains new skills.
- **Against:** requires `Signum.Agent` to be installed *and* started *and* configured with an
  LLM provider in the target app — a hard dependency most apps will not satisfy. Tool
  granularity is chosen for LLMs, not for scripts. Non-deterministic if any skill routes
  through a model. **Security:** analysis found that prompt injection already reaches the
  destructive `OperationSkill` write path, with `ConfirmUISkill` advisory only — a scripting
  tool should not sit downstream of that.

### C. HTTP core, optional MCP bridge

Build the deterministic HTTP client as the foundation. Separately, and later, allow the CLI
to *act as* or *speak to* MCP.

Two distinct sub-ideas worth keeping apart:

- **C1 — CLI as MCP client:** an escape hatch for apps where `Signum.Agent` is present, for
  natural-language-ish commands. Low priority.
- **C2 — CLI as MCP server:** expose the CLI's own deterministic HTTP commands as MCP tools,
  so Claude Code and other agents can drive a Signum app *without* the target app needing
  `Signum.Agent` at all. This inverts the dependency and is arguably the more valuable
  direction.

## Recommendation

**Option C, with C2 as the interesting follow-on.**

Build the HTTP client first — it is the only option that works universally and
deterministically, and it is a prerequisite for everything else. Do not take a dependency on
`Signum.Agent`.

Then consider C2: a `signum-cli mcp` subcommand turning the deterministic client into an MCP
server. That gives agentic access to *any* Signum app, needs no server-side module, keeps a
human-auditable CLI as the single implementation, and avoids the prompt-injection-to-write-path
concern by keeping the LLM outside the tool rather than inside it.

## Consequences

- Read `Extensions/Signum.Agent/Skills/*.md` before designing the command set — those skills
  are upstream's considered answer to "what operations does a remote consumer need". Nine
  files; treat them as a requirements document.
- Mirror their granularity where it is sensible, so the two surfaces stay conceptually
  aligned.
- Keep serialization concerns in one layer, so a later MCP server can sit on top without
  reimplementing anything.
