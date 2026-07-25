# Requirements

Source of truth for what `signum-cli` must do. Every requirement is mirrored as a GitHub
issue labelled [`requirement`](https://github.com/pajoma/signum-cli/labels/requirement);
this document and the issues must stay in sync.

**Status:** DRAFT — collected 2026-07-25, not yet reviewed.

## What a requirement is here

A requirement states **what the CLI must do**. It is not a user story and carries **no
acceptance criteria** — do not add them to this document or to the mirroring issues.

Implementation work is tracked separately and references a requirement ID. One requirement may
spawn several pieces of work, or none; the register describes the system, not the plan.

Requirement IDs (`REQ-nnn`) are stable and permanent. Issue numbers are a convenience and are
not a substitute for them.

## Scope

A **self-contained native executable** that talks to a running Signum Framework application
over HTTP: dynamic queries, entity retrieve/save, operation execution — plus an MCP server
mode so agents can drive any Signum app.

Decided: [C# / .NET 10 + NativeAOT](decisions/0001-implementation-language.md) ·
[self-contained distribution](decisions/0003-self-contained-distribution.md) ·
[MCP relationship](decisions/0002-mcp-vs-http.md).

### Consumers

Four, in no strict priority order — the CLI must serve all of them, which is why
"machine-first with a human-readable default" (REQ-050) is a core requirement rather than a
nicety.

| Consumer | Implies |
|---|---|
| Ops / admin scripting | exit codes, `--json`, dry-run, no prompts, audit-friendly |
| Human ops at a terminal | readable tables, confirmations before writes, discoverability |
| AI agents via MCP | structured errors, self-describing tools, strict JSON |
| Claude Code invoking the binary directly | stable output contract, no interactivity required |

### Non-goals

Explicitly out of scope. Recorded so they are not re-proposed:

- **Scaffolding and code generation.** `Signum.Upgrade` (223 scripts) and
  `Signum/CodeGeneration/` own this.
- **Schema synchronization and migrations.** Needs a DB connection and the app's entity
  assemblies; belongs in the app's own `*.Terminal` host.
- **Any dependency on `Extensions/Signum.Agent`** being installed server-side.
- **Surfacing `Signum.Dynamic` / `Signum.Eval` evaluation endpoints.** These are remote code
  execution paths with known authorization gaps
  ([overview §14](architecture-overview.md)); a convenient CLI wrapper around them would be
  materially worse than the web endpoint. Requires explicit discussion to revisit.
- **A "typed mode"** that loads an app's entity assemblies. Incompatible with NativeAOT; would
  be a different tool.

### Priority key

| | |
|---|---|
| **v1** | required for a first usable release |
| **v2** | wanted, not blocking |
| **spike** | research needed before it can be specified — outcome may be "not feasible" |

---

## A. Connection and authentication

The owner's guidance: **behave like `gh`** — authenticate either by pasting an API token
(terminal-only) or by opening a browser.

| ID | Priority | Requirement |
|---|---|---|
| REQ-001 | v1 | **Connection profiles.** Named profiles for multiple target apps/environments, resolved in the order: `--url`/`--profile` flag → env var → config file → error. `signum auth login`, `auth status`, `auth logout`, `auth switch`. Never require a config file to exist. |
| REQ-002 | v2 | **API-key authentication.** **Not available on the target application — it has no `Signum.Rest`**, so there is no `X-ApiKey` authenticator and `api/restApiKey/*` is absent; retained because the CLI must work against any Signum app (REQ-075). `X-ApiKey` header. **Never** the `apiKey` query parameter — `RestLogFilter.cs:36-38` persists whole query strings into `RestLogEntity.QueryString`, so a key in a URL is written to the customer's database in plaintext. Detect and report clearly when the target app lacks `Signum.Rest`. |
| REQ-003 | v2 | **Username/password → bearer.** **Cannot work for the target application:** `AzureADAuthorizer.Login()` delegates to the local password check (`AzureADAuthorizer.cs:15-18`) and Entra-provisioned users get `PasswordHash = null` (`:43`), which `AuthLogic.cs:434` turns into `IncorrectPasswordException`. Must never be attempted automatically — failures count toward `MaxFailedLoginAttempts` and can deactivate the account. `POST api/auth/login` → `Authorization: Bearer`. **Must adopt the `New_Token` response header** (`AuthTokensServer.cs:85-94`): tokens never expire, so ignoring it does *not* 403 — it costs a DB hit per request and **freezes the user's role permanently** (`RoleEntity.cs:33`). Token is opaque (not a JWT, no MAC) — never parse it. A bad token degrades silently to anonymous, so verify via `api/auth/currentUser` after loading one. Never auto-retry a failed login: `MaxFailedLoginAttempts` deactivates the account. |
| REQ-004 | v1 | **Browser-based login.** `gh auth login --web` equivalent. **Confirmed feasible with no framework changes** (spike 2026-07-25): `POST api/auth/loginWithOpenID` is `[SignumAllowAnonymous]`, takes `{Code, RedirectUri}`, and Signum does not validate the redirect URI — so a loopback callback works and the CLI needs no `client_secret`. Requires the target app to run `Signum.Authorization.OpenID`. Two known limits: PKCE is unimplemented server-side, and `client_id`/scopes must be configured until a 2-line upstream change exposes them. See [STORY-01](stories/auth.md). |
| REQ-005 | v2 | **External IdP authentication.** The target application uses Entra, but this path is **blocked on an Entra app-registration change we cannot currently make** — Signum validates `aud == ApplicationID` and we control neither the app config nor the tenant, so REQ-008 is the primary path instead ([ADR 0004](decisions/0004-entra-primary-identity-provider.md), [STORY-10](stories/auth.md)); the device code grant is hand-rolled over plain HTTP with no MSAL, to protect the NativeAOT build. `loginWithAzureAD` accepts a raw `idToken` with `aud`/`iss` validation — a genuine token exchange, so the CLI runs its own device-code flow and hands the token over. `WindowsAD` integrated auth is Windows-and-browser only, but its LDAP bind is reachable through plain `api/auth/login` with no client change. SPNEGO is out of scope. |
| REQ-006 | v1 | **Credential handling.** Tokens and keys stored with owner-only file permissions (or OS keychain where available), never in the repo, never in shell history via required flags, never in logs, traces, error messages, or crash output. Prefer env vars for CI. Redaction is REQ-053's responsibility to enforce. |
| REQ-008 | v1 | **Browser token handoff.** `auth login --with-token` accepts a Signum bearer token obtained from an existing browser session (`sessionStorage.authToken`, `AuthClient.tsx:189,198`), read from **stdin only**. **The *only* viable mechanism for the target application** (ADR 0004 Decision 4: no `Signum.Rest` rules out API keys, and null `PasswordHash` rules out password login), because it needs no change to the Signum configuration and none to the Entra tenant — the browser satisfies SSO/MFA/Conditional Access. Auto-upgrades to a durable API key via `GET api/restApiKey/current` where that endpoint exists (a silent no-op on the target app) ([ADR 0004](decisions/0004-entra-primary-identity-provider.md) Decision 3, [STORY-12](stories/auth.md)). |
| REQ-007 | v1 | **Identity check.** `signum auth status` / `whoami` — confirm reachability, auth mechanism in use, authenticated user, and app version, in one call. First thing anyone runs when something is wrong. |

**Note on 403:** every auth failure from a Signum app is **403, never 401**
(`SignumExceptionFilterAttribute.cs:131-146`). Retry/re-auth logic keyed on 401 is dead code.

---

## B. Metadata and discovery

| ID | Priority | Requirement |
|---|---|---|
| REQ-010 | v1 | **Metadata cache.** Fetch `GET api/reflection/types` (anonymous, `Last-Modified` + 304) and cache on disk keyed by `Last-Modified`; revalidate with `If-Modified-Since`. Enables offline completion and pre-flight validation. Cache is per-profile and explicitly invalidatable. |
| REQ-011 | v1 | **Discovery commands.** List and describe what the target app offers: types, their members and entity kinds, available queries, operations, enums, permissions. Human tables and `--json`. This is how a user (or agent) learns an unfamiliar app. |
| REQ-012 | v1 | **Token discovery and validation.** `POST api/query/subTokens` to enumerate valid next segments; `POST api/query/parseTokens` to validate. Must handle the bracket-aware split (`QueryUtils.cs:370`), the `#` escape in operation tokens, and reject `.Nested` early — it is discoverable but unusable in `executeQuery` (`FilterJsonConverter.cs:87-153`). |
| REQ-013 | v2 | **Shell completion.** bash/zsh/fish/pwsh, driven by the REQ-010 cache so completion works without a round trip. |

---

## C. Queries

| ID | Priority | Requirement |
|---|---|---|
| REQ-020 | v1 | **Execute dynamic queries.** `POST api/query/executeQuery/{queryKey}` with filters, orders, columns, pagination. The core read capability. |
| REQ-021 | v1 | **Filter/column/order expression syntax.** A human- and agent-writable surface that lowers to `QueryRequestTS`. Must cover the full `FilterOperation` set, `And`/`Or` groups including nesting, and `IsIn`. Note `IsIn` **cannot express null**. Design the syntax deliberately — this is the CLI's primary user interface. |
| REQ-022 | v1 | **De-intern `ResultTable`.** Correctness requirement, not a feature. `rows[i].columns[j]` may be an **index into `uniqueValues[columns[j]]`** rather than a value, and the `Entity` column is hoisted to `rows[i].entity` (`ResultTableConverter.cs:71-78`). Must be normalized in exactly one place, before any output path. Getting this wrong produces plausible-looking wrong data. |
| REQ-023 | v2 | **Aggregates and grouping.** `groupResults: true` with `Count`/`Sum`/`Min`/`Max`/`Average`/`CountDistinct`/`CountNull`/`CountNotNull`/`CountTrue`. Aggregate tokens require `groupResults`, and `SubTokensOptions` differ per slot. |
| REQ-024 | v1 | **Pagination and result variants.** `All`/`Firsts`/`Paginate` modes, plus `--all` that pages transparently and streams rather than buffering. Also expose the `lites`, `entities`, and `queryValue` endpoint variants. |
| REQ-025 | v2 | **Temporal queries.** `systemTime` for `Signum.TimeMachine`-enabled apps. |
| REQ-026 | v2 | **Entity autocomplete.** `api/query/findLiteLike` for resolving a human string to a `Lite` — needed to make write commands usable without knowing ids. |

---

## D. Entities

| ID | Priority | Requirement |
|---|---|---|
| REQ-030 | v1 | **Retrieve.** By type + id and by `Lite` key (`"Order;42"` — `TypeName;id`). Support `entityPack`/`entityPackLight` to get `canExecute` alongside the entity. Also `exists` and `fetchAll`. |
| REQ-031 | v1 | **Entity JSON round-trip fidelity.** Read an entity, modify it, write it back without corruption. Must respect: `Type` on entities (clean name — `RoleEntity` → `"Role"`) vs `EntityType` on Lites (mixing throws); `ticks` as a **string**; `MList` as `[{rowId, element}]`; special properties **first** in the object; unknown keys rejected. |
| REQ-032 | v1 | **Propagate `modified`.** `modified: true` must be set up the **whole entity graph**, not just the changed leaf — the browser client does this via `GraphExplorer.propagateAll` in `ajaxPostRaw`. Missing it makes saves silently drop changes. Quiet-failure risk; needs explicit tests. |
| REQ-033 | v1 | **Optimistic concurrency.** Round-trip `ticks` and detect conflict: HTTP 500 with `exceptionType == "Signum.Engine.ConcurrencyException"`. Report as a distinct, actionable error with its own exit code — never as a generic 500. |
| REQ-034 | v2 | **Pre-flight validation.** `POST api/validateEntity` before attempting a save, so failures surface before mutation. |

---

## E. Operations

**There is no save endpoint.** All mutation is an operation — this shapes the whole write surface.

| ID | Priority | Requirement |
|---|---|---|
| REQ-040 | v1 | **Execute operations.** `executeEntity` and `executeLite`. Must choose the right variant: `…Entity` when the local graph has unsaved changes, `…Lite` when only an identity is held. Includes save, via e.g. `UserOperation.Save`. |
| REQ-041 | v1 | **operationKey resolution.** Keys are `ContainerClassName.FieldName`, **not** namespace-qualified (`Signum/Basics/Symbol.cs:22`). Resolve friendly input against cached metadata, and disambiguate rather than guess when ambiguous. |
| REQ-042 | v1 | **`args` encoding.** `args` is discriminated **by JSON shape** (`OperationController.cs:164-200`): an object with `EntityType` is a `Lite`, with `Type` is an entity, a bare number is `decimal`. The CLI must let a user express each unambiguously. |
| REQ-043 | v1 | **Dry-run.** `--dry-run` using `canExecute` from `entityPack` (and `stateCanExecutes`) to report whether an operation would be permitted, without invoking it. Essential for both ops safety and agent use. |
| REQ-044 | v2 | **Construct and delete.** `construct`, `constructFromEntity`/`Lite`/`Many`, `deleteEntity`/`Lite`. |
| REQ-045 | v2 | **Bulk operations with progress.** `executeMultiple`, `deleteMultiple`, `constructFromMultiple`, and the NDJSON-streaming `executeLiteWithProgress`. Must stream progress, report per-item outcomes, and not abort the batch on one failure. |
| REQ-046 | v1 | **Destructive-action guard.** Confirm before mutating when stdout is a TTY; `--yes` to bypass; never prompt when not a TTY (fail instead, so a script cannot hang). |

---

## F. Output, errors, and UX

| ID | Priority | Requirement |
|---|---|---|
| REQ-050 | v1 | **TTY-aware output.** Aligned tables with colour when stdout is a TTY; structured output when piped. Explicit `--json` / `--csv` / `--tsv` / `--ndjson` always win. Respect `NO_COLOR`. Diagnostics to stderr, data to stdout — always, so piping is safe. |
| REQ-051 | v1 | **Exit-code taxonomy.** A documented, stable set distinguishing at minimum: success, usage error, auth failure, not found, validation failure, concurrency conflict, operation-not-allowed, network/transport error. Scripts and agents branch on these. |
| REQ-052 | v1 | **Actionable error mapping.** Translate the server's vocabulary into remediable messages: 403 covers both "not authenticated" and "not authorized" (there is no 401) — disambiguate them; 400 carries `ValidationProblemDetails`; 500 may be a `ConcurrencyException`. Never surface a bare status code. |
| REQ-053 | v1 | **`--explain` and tracing.** `--explain` prints the exact HTTP request that would be sent, without sending it. `-v`/`--trace` shows real request/response traffic. **Both must redact credentials** — headers, tokens, keys — with redaction tested. |
| REQ-054 | v1 | **Input from files and stdin.** Accept entity JSON and id/Lite lists via `@file` and `-` (stdin), so the CLI composes in pipelines and agents can pass structured input without shell-quoting hazards. |
| REQ-055 | v2 | **Culture handling.** Dates, numbers and decimals come from a business database and Signum apps are multi-culture. Support `--culture`; document the default. Related: `InvariantGlobalization` is deliberately **off** (ADR 0003). |

---

## G. MCP server mode

Resolves [ADR 0002](decisions/0002-mcp-vs-http.md) option C2. Motivated by "AI agents" and
"Claude Code" being primary consumers.

| ID | Priority | Requirement |
|---|---|---|
| REQ-060 | v1 | **MCP server mode.** `signum mcp` exposes the CLI's deterministic commands as MCP tools over stdio, so **any** Signum app becomes agent-drivable with **no server-side module**. Must not require `Signum.Agent` in the target app. |
| REQ-061 | v2 | **Metadata-derived tool schemas.** Generate tool schemas from the REQ-010 cache so tools reflect the actual target app. Consider lazy disclosure — `Signum.Agent` does this via `Describe` + `ToolListChangedNotification`, and a large app's type list will not fit a tool list comfortably. |
| REQ-062 | v1 | **Write guardrails under MCP.** Mutating tools need an explicit opt-in (read-only by default), an allowlist or confirmation path, and audit logging. Rationale: in `Signum.Agent`, prompt injection already reaches the destructive `OperationSkill` write path with `ConfirmUISkill` advisory only — this CLI must not reproduce that. |

---

## H. Non-functional

| ID | Priority | Requirement |
|---|---|---|
| REQ-070 | v1 | **Self-contained, no dependencies.** One executable, dropped anywhere, runs — no runtime install, no external tools, no required config file. Per [ADR 0003](decisions/0003-self-contained-distribution.md). |
| REQ-071 | v1 | **NativeAOT-clean.** No reflection-based JSON, no `Expression.Compile()`, no `Reflection.Emit`, no `Assembly.Load`, no `ProjectReference` to the framework. `IL2xxx`/`IL3xxx` warnings are **errors** from the first commit. |
| REQ-072 | v2 | **Startup budget.** Fast enough for interactive and per-invocation agent use. Set a concrete budget once measured — **no AOT figure in these docs has been measured** (no .NET SDK on the dev machine yet). |
| REQ-073 | v2 | **Cross-platform releases.** linux-x64 first; then linux-arm64, osx-arm64, osx-x64, win-x64. Needs one CI runner per OS family (NativeAOT does not cross-compile comfortably). Publish checksums; decide signing before the first public release — unsigned macOS binaries are Gatekeeper-quarantined. |
| REQ-074 | v1 | **No credential leakage.** No key, token, or password may appear in stdout, stderr, logs, traces, telemetry, crash output, or any file except the credential store. Tested, not merely intended. |
| REQ-075 | v1 | **Works against any Signum app.** No server-side module required. The one documented exception is API-key auth (REQ-002), which needs `Signum.Rest` — degrade to REQ-003 with a clear message. |
| REQ-076 | v2 | **Version and capability detection.** Detect the target app's framework version and available modules; degrade gracefully and say so, rather than failing obscurely, when something is absent. |
| REQ-077 | v1 | **Test strategy without a live server.** Contract tests against recorded fixtures for offline CI, plus an opt-in live suite against a real app. **Nothing in `docs/` has been verified against a running server** — the live suite is what converts these documents from hypothesis to fact. |

---

## Open questions

Not yet answerable; each blocks a requirement.

1. **Is browser-based login possible at all** without framework changes? (REQ-004) — the
   single largest unknown, and it gates the `gh`-like experience the owner asked for.
2. **Which IdP flows work headlessly** for `WindowsAD` / `AzureAD` / `OpenID`? (REQ-005)
3. **Is `System.CommandLine` AOT-clean** in its current release, or do we hand-roll parsing?
   (ADR 0003)
4. **What is the filter expression syntax?** (REQ-021) Needs a concrete proposal — it is the
   primary interface for three of the four consumer types.
5. **Entra integration specifics.** The target app uses Entra, so testing is against it, later.
   Still unknown and blocking STORY-10's criteria: which Signum module fronts Entra (`AzureAD` or
   `OpenID`), which audience strategy the tenant permits, which `AzureADType`, and whether
   Conditional Access allows the device code grant. See ADR 0004.
6. **What is `queryKey`, exactly, in user terms?** Whether users address queries by type name,
   by registered query key, or both, affects REQ-011 and REQ-020 ergonomics.

## Traceability

Requirement IDs are stable; issue numbers are not a substitute for them.

**A. Connection and authentication**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-001 | [#1](https://github.com/pajoma/signum-cli/issues/1) | `v1` | Connection profiles |
| REQ-002 | [#2](https://github.com/pajoma/signum-cli/issues/2) | `v2` | API-key authentication |
| REQ-003 | [#3](https://github.com/pajoma/signum-cli/issues/3) | `v2` | Username/password → bearer |
| REQ-004 | [#4](https://github.com/pajoma/signum-cli/issues/4) | `spike` | Browser-based login |
| REQ-005 | [#5](https://github.com/pajoma/signum-cli/issues/5) | `spike` | External IdP authentication |
| REQ-006 | [#6](https://github.com/pajoma/signum-cli/issues/6) | `v1` | Credential handling |
| REQ-007 | [#7](https://github.com/pajoma/signum-cli/issues/7) | `v1` | Identity check |
| REQ-008 | [#49](https://github.com/pajoma/signum-cli/issues/49) | `v1` | Browser token handoff |

**B. Metadata and discovery**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-010 | [#8](https://github.com/pajoma/signum-cli/issues/8) | `v1` | Metadata cache |
| REQ-011 | [#9](https://github.com/pajoma/signum-cli/issues/9) | `v1` | Discovery commands |
| REQ-012 | [#10](https://github.com/pajoma/signum-cli/issues/10) | `v1` | Token discovery and validation |
| REQ-013 | [#11](https://github.com/pajoma/signum-cli/issues/11) | `v2` | Shell completion |

**C. Queries**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-020 | [#12](https://github.com/pajoma/signum-cli/issues/12) | `v1` | Execute dynamic queries |
| REQ-021 | [#13](https://github.com/pajoma/signum-cli/issues/13) | `v1` | Filter/column/order expression syntax |
| REQ-022 | [#14](https://github.com/pajoma/signum-cli/issues/14) | `v1` | De-intern `ResultTable` |
| REQ-023 | [#15](https://github.com/pajoma/signum-cli/issues/15) | `v2` | Aggregates and grouping |
| REQ-024 | [#16](https://github.com/pajoma/signum-cli/issues/16) | `v1` | Pagination and result variants |
| REQ-025 | [#17](https://github.com/pajoma/signum-cli/issues/17) | `v2` | Temporal queries |
| REQ-026 | [#18](https://github.com/pajoma/signum-cli/issues/18) | `v2` | Entity autocomplete |

**D. Entities**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-030 | [#19](https://github.com/pajoma/signum-cli/issues/19) | `v1` | Retrieve |
| REQ-031 | [#20](https://github.com/pajoma/signum-cli/issues/20) | `v1` | Entity JSON round-trip fidelity |
| REQ-032 | [#21](https://github.com/pajoma/signum-cli/issues/21) | `v1` | Propagate `modified` |
| REQ-033 | [#22](https://github.com/pajoma/signum-cli/issues/22) | `v1` | Optimistic concurrency |
| REQ-034 | [#23](https://github.com/pajoma/signum-cli/issues/23) | `v2` | Pre-flight validation |

**E. Operations**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-040 | [#24](https://github.com/pajoma/signum-cli/issues/24) | `v1` | Execute operations |
| REQ-041 | [#25](https://github.com/pajoma/signum-cli/issues/25) | `v1` | operationKey resolution |
| REQ-042 | [#26](https://github.com/pajoma/signum-cli/issues/26) | `v1` | `args` encoding |
| REQ-043 | [#27](https://github.com/pajoma/signum-cli/issues/27) | `v1` | Dry-run |
| REQ-044 | [#28](https://github.com/pajoma/signum-cli/issues/28) | `v2` | Construct and delete |
| REQ-045 | [#29](https://github.com/pajoma/signum-cli/issues/29) | `v2` | Bulk operations with progress |
| REQ-046 | [#30](https://github.com/pajoma/signum-cli/issues/30) | `v1` | Destructive-action guard |

**F. Output, errors, and UX**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-050 | [#31](https://github.com/pajoma/signum-cli/issues/31) | `v1` | TTY-aware output |
| REQ-051 | [#32](https://github.com/pajoma/signum-cli/issues/32) | `v1` | Exit-code taxonomy |
| REQ-052 | [#33](https://github.com/pajoma/signum-cli/issues/33) | `v1` | Actionable error mapping |
| REQ-053 | [#34](https://github.com/pajoma/signum-cli/issues/34) | `v1` | `--explain` and tracing |
| REQ-054 | [#35](https://github.com/pajoma/signum-cli/issues/35) | `v1` | Input from files and stdin |
| REQ-055 | [#36](https://github.com/pajoma/signum-cli/issues/36) | `v2` | Culture handling |

**G. MCP server mode**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-060 | [#37](https://github.com/pajoma/signum-cli/issues/37) | `v1` | MCP server mode |
| REQ-061 | [#38](https://github.com/pajoma/signum-cli/issues/38) | `v2` | Metadata-derived tool schemas |
| REQ-062 | [#39](https://github.com/pajoma/signum-cli/issues/39) | `v1` | Write guardrails under MCP |

**H. Non-functional**

| ID | Issue | Priority | Title |
|---|---|---|---|
| REQ-070 | [#40](https://github.com/pajoma/signum-cli/issues/40) | `v1` | Self-contained, no dependencies |
| REQ-071 | [#41](https://github.com/pajoma/signum-cli/issues/41) | `v1` | NativeAOT-clean |
| REQ-072 | [#42](https://github.com/pajoma/signum-cli/issues/42) | `v2` | Startup budget |
| REQ-073 | [#43](https://github.com/pajoma/signum-cli/issues/43) | `v2` | Cross-platform releases |
| REQ-074 | [#44](https://github.com/pajoma/signum-cli/issues/44) | `v1` | No credential leakage |
| REQ-075 | [#45](https://github.com/pajoma/signum-cli/issues/45) | `v1` | Works against any Signum app |
| REQ-076 | [#46](https://github.com/pajoma/signum-cli/issues/46) | `v2` | Version and capability detection |
| REQ-077 | [#47](https://github.com/pajoma/signum-cli/issues/47) | `v1` | Test strategy without a live server |
