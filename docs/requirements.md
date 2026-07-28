# Requirements

Source of truth for what `signum-cli` must do. Every requirement is mirrored as a GitHub
issue labelled [`requirement`](https://github.com/pajoma/signum-cli/labels/requirement);
this document and the issues must stay in sync.

**Status:** DRAFT — collected 2026-07-25, not yet reviewed.

## Milestone is not priority

The tables below carry a **Milestone** column (`m1`/`m2`/`m3`/`always`) — *when* a requirement is
scheduled. That column was previously headed "Priority", which is a different axis and caused
exactly the confusion you would expect.

**Priority lives on the [project board](https://github.com/users/pajoma/projects/2)** as `P0`/`P1`/`P2`:

| | Meaning |
|---|---|
| **P0** | Must be right, or the tool is dangerous or pointless. Correctness, credential safety, silent-wrong-data, and the few requirements that define what the product *is*. |
| **P1** | Needed for the tool to be good. A user or agent would reasonably expect it. |
| **P2** | Valuable, but the tool is fine without it. Narrow audience, convenience, or a path that cannot work on the target application anyway. |

The two axes are deliberately independent, and they disagree often:

- `always` + **P0** — REQ-074 (no credential leakage) is not scheduled, it is a standing condition.
- `m1` + **P0** — REQ-022 (de-intern `ResultTable`) is the correctness requirement; getting it wrong
  emits plausible-looking wrong data, which is the worst failure available to a tool people script
  against. A defect of exactly this kind shipped and was caught in review.
- `m3` + **P0** — REQ-062 (write guardrails under MCP). Late, because MCP is late; P0, because in
  `Signum.Agent` prompt injection already reaches a destructive write path.
- `m2` + **P0** — REQ-031/032/033/042/046, the write-integrity set. Every one of them fails
  *silently*: dropped changes, overwritten concurrent edits, `args` that become `null` with no error.
- `m3` + **P2** — REQ-002/003/004/005, the auth mechanisms that **cannot work on the target
  application** and are retained only because REQ-075 says the CLI must work against any Signum app.

A requirement is closed only once **delivered**, not once implemented — and nothing here has been
verified against a live Signum application yet (REQ-077, itself P0 for that reason). Implemented
requirements sit at Status *In review* on the board.

---

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

Decided: [TypeScript + Bun single executable](decisions/0006-typescript-bun.md) ·
[self-contained distribution](decisions/0003-self-contained-distribution.md) ·
[MCP relationship](decisions/0002-mcp-vs-http.md).

### Target application

The deployment driving priorities — Entra SSO, no `Signum.Rest`, no `Signum.Agent`, no control over
the Signum config — is profiled in [`target-application.md`](target-application.md). It leaves
exactly one reachable auth mechanism (REQ-008) and makes the CLI the only agent-facing entry point
to that app. Requirements unusable there are kept, not dropped: REQ-075 requires the CLI to work
against any Signum application.

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
- **A "typed mode"** that loads an app's entity assemblies. Impossible in Rust and pointless besides — the API is generic; it would be a different tool.

### Milestones

Triaged 2026-07-25. The earlier v1/v2 split had 33 requirements in "v1", which was not a first
release — it was the whole product. This replaces it.

| | Count | Meaning |
|---|---|---|
| **m1** | 14 | **Read-only core.** The smallest CLI that is genuinely useful and safe to point at production. No mutations at all. |
| **m2** | 14 | **Writes and ergonomics.** Operations, entity round-trip fidelity, concurrency, profiles, tracing. |
| **m3** | 18 | **MCP, scale, and other deployments.** Includes the four auth mechanisms unreachable on the target app. |
| **always** | 6 | **Cross-cutting constraints**, not scheduled features. They apply from the first commit and are never "done". |

**Why m1 is read-only.** Every write hazard in this API is a *quiet* one — `modified` propagation
(STORY-32), `ticks` concurrency (STORY-33), and `args` coercion (STORY-42) all fail by appearing to
succeed. A read-only m1 can be trusted against production while those are still being got right, and
it is the shortest path to something that earns that trust.

**Why MCP is m3, despite agents being a primary consumer.** Claude Code can drive the binary
*directly* from m1 — `--json` (REQ-050) plus a stable exit-code taxonomy (REQ-051) is all that needs.
MCP server mode adds tool discovery, and its write guardrails (REQ-062) presuppose that writes exist
(m2). So it lands naturally after both. **If MCP matters more than writes, swap m2 and m3** — that is
the one call in this triage most worth overriding.

**m3 contains work that is blocked, not merely deferred.** REQ-002/003/004/005 are the API-key,
password, OpenID and Entra-device-code auth paths, none of which is reachable on the target
deployment ([target profile](target-application.md)). They stay specified because REQ-075 requires the
CLI to work against any Signum app.

---

## A. Connection and authentication

The owner's guidance: **behave like `gh`** — authenticate either by pasting an API token
(terminal-only) or by opening a browser.

| ID | Milestone | Requirement |
|---|---|---|
| REQ-001 | m2 | **Connection profiles.** Named profiles for multiple target apps/environments, resolved in the order: `--url`/`--profile` flag → env var → config file → error. `signum auth login`, `auth status`, `auth logout`, `auth switch`. Never require a config file to exist. |
| REQ-002 | m3 | **API-key authentication.** **Not available on the target application — it has no `Signum.Rest`**, so there is no `X-ApiKey` authenticator and `api/restApiKey/*` is absent; retained because the CLI must work against any Signum app (REQ-075). `X-ApiKey` header. **Never** the `apiKey` query parameter — `RestLogFilter.cs:36-38` persists whole query strings into `RestLogEntity.QueryString`, so a key in a URL is written to the customer's database in plaintext. Detect and report clearly when the target app lacks `Signum.Rest`. |
| REQ-003 | m3 | **Username/password → bearer.** **Cannot work for the target application:** `AzureADAuthorizer.Login()` delegates to the local password check (`AzureADAuthorizer.cs:15-18`) and Entra-provisioned users get `PasswordHash = null` (`:43`), which `AuthLogic.cs:434` turns into `IncorrectPasswordException`. Must never be attempted automatically — failures count toward `MaxFailedLoginAttempts` and can deactivate the account. `POST api/auth/login` → `Authorization: Bearer`. **Must adopt the `New_Token` response header** (`AuthTokensServer.cs:85-94`): tokens never expire, so ignoring it does *not* 403 — it costs a DB hit per request and **freezes the user's role permanently** (`RoleEntity.cs:33`). Token is opaque (not a JWT, no MAC) — never parse it. A bad token degrades silently to anonymous, so verify via `api/auth/currentUser` after loading one. Never auto-retry a failed login: `MaxFailedLoginAttempts` deactivates the account. |
| REQ-004 | m3 | **Browser-based login.** `gh auth login --web` equivalent. **Feasible in the framework, but NOT REACHABLE on the target application:** `GET api/auth/openIDEndpoints` returns **404** there (observed 2026-07-28), and 404 rather than 500 means the controller is unregistered — `Signum.Authorization.OpenID` is **not installed**. That blocker comes *before* the Entra redirect-URI one and is harder: installing a module in someone else's production app is a bigger ask than registering a URI. Where the module *is* installed this works with no framework change: `POST api/auth/loginWithOpenID` is `[SignumAllowAnonymous]` and takes `{Code, RedirectUri}`; Signum does not validate the redirect URI and supplies `client_id`+`client_secret` itself, so the CLI needs no secret. PKCE being unimplemented server-side is **not** a limit — sending a `client_secret` makes this a confidential client, which Entra does not force PKCE on. `client_id`/scopes must still be configured, as no API exposes them. For the target app, [ADR 0008](decisions/0008-browser-driven-token-capture.md) proposes driving a browser instead. See [STORY-01](stories/auth.md). |
| REQ-005 | m3 | **External IdP authentication.** The target application uses Entra, but this path is **blocked on an Entra app-registration change we cannot currently make** — Signum validates `aud == ApplicationID` and we control neither the app config nor the tenant, so REQ-008 is the primary path instead ([ADR 0004](decisions/0004-entra-primary-identity-provider.md), [STORY-10](stories/auth.md)); the device code grant is hand-rolled over plain HTTP (no identity SDK), keeping the dependency set minimal. `loginWithAzureAD` accepts a raw `idToken` with `aud`/`iss` validation — a genuine token exchange, so the CLI runs its own device-code flow and hands the token over. `WindowsAD` integrated auth is Windows-and-browser only, but its LDAP bind is reachable through plain `api/auth/login` with no client change. SPNEGO is out of scope. |
| REQ-006 | always | **Credential handling.** Tokens and keys stored with owner-only file permissions (or OS keychain where available), never in the repo, never in shell history via required flags, never in logs, traces, error messages, or crash output. Prefer env vars for CI (`SIGNUM_TOKEN`, never persisted). Redaction is REQ-053's responsibility to enforce. **Platform limit:** owner-only *modes* are POSIX-only — on Windows Node cannot set or read them (`chmod` toggles only the read-only attribute; `stat().mode` is synthesized), so protection there comes from the profile directory's inherited ACL and the CLI reports that instead of claiming a mode it cannot enforce (#84). |
| REQ-008 | m1 | **Browser token handoff.** `auth login --with-token` accepts a Signum bearer token obtained from an existing browser session (`sessionStorage.authToken`, `AuthClient.tsx:189,198`), read from **stdin only**. **The *only* viable mechanism for the target application** (ADR 0004 Decision 4: no `Signum.Rest` rules out API keys, and null `PasswordHash` rules out password login), because it needs no change to the Signum configuration and none to the Entra tenant — the browser satisfies SSO/MFA/Conditional Access. Auto-upgrades to a durable API key via `GET api/restApiKey/current` where that endpoint exists (a silent no-op on the target app) ([ADR 0004](decisions/0004-entra-primary-identity-provider.md) Decision 3, [STORY-12](stories/auth.md)). |
| REQ-007 | m1 | **Identity check.** `signum auth status` / `whoami` — confirm reachability, auth mechanism in use, authenticated user, and app version, in one call. First thing anyone runs when something is wrong. |

**Note on 403:** every auth failure from a Signum app is **403, never 401**
(`SignumExceptionFilterAttribute.cs:131-146`). Retry/re-auth logic keyed on 401 is dead code.

---

## B. Metadata and discovery

| ID | Milestone | Requirement |
|---|---|---|
| REQ-010 | m1 | **Metadata cache.** Fetch `GET api/reflection/types` (anonymous, `Last-Modified` + 304) and cache on disk keyed by `Last-Modified`; revalidate with `If-Modified-Since`. Enables offline completion and pre-flight validation. Cache is per-profile and explicitly invalidatable. |
| REQ-011 | m1 | **Discovery commands.** List and describe what the target app offers: types, their members and entity kinds, available queries, **operations** (`signum operations [<Type>]`, `signum explain <OperationKey>` — read-only, so they ship in m1 even though invoking an operation is m2), enums, permissions. Human tables and `--json`. This is how a user (or agent) learns an unfamiliar app. |
| REQ-012 | m2 | **Token discovery and validation.** `POST api/query/subTokens` to enumerate valid next segments; `POST api/query/parseTokens` to validate. Must handle the bracket-aware split (`QueryUtils.cs:370`), the `#` escape in operation tokens, and reject `.Nested` early — it is discoverable but unusable in `executeQuery` (`FilterJsonConverter.cs:87-153`). |
| REQ-014 | m1 | **Help at every level.** Static help (commands, flags, `signum help <topic>`) works with **no config, no credentials and no network**; dynamic help (`signum query <queryKey> --help`, `signum <verb> <Type> --help`) is generated from the metadata cache and **needs no authentication**, since `api/reflection/types` is anonymous. Degrades rather than failing when metadata is unavailable. `--help` → stdout, exit 0; unknown command → stderr, exit 2. `-o json` works on any help and is the **single source** for MCP tool schemas (REQ-061) and completion (REQ-013). Errors route to the help that would have prevented them. See [CLI surface](design/cli-surface.md) §2.2, [STORY-60…63](stories/help.md). |
| REQ-013 | m3 | **Shell completion.** bash/zsh/fish/pwsh, driven by the REQ-010 cache so completion works without a round trip. |

---

## C. Queries

| ID | Milestone | Requirement |
|---|---|---|
| REQ-020 | m1 | **Execute dynamic queries.** `POST api/query/executeQuery/{queryKey}` with filters, orders, columns, pagination. The core read capability. |
| REQ-021 | m1 | **Filter/column/order expression syntax.** A human- and agent-writable surface that lowers to `QueryRequestTS`. Must cover all **25** `FilterOperation` values (`Filter.cs:558-615`), `And`/`Or` groups including nesting, and `IsIn`. Note `IsIn` **cannot express null**, and there is **no NOT** — `FilterGroupOperation` is `And|Or` only, so negation exists solely as negated operators. **Designed:** [`design/filter-expression-syntax.md`](design/filter-expression-syntax.md); criteria in [STORY-20](stories/query.md). |
| REQ-022 | m1 | **De-intern `ResultTable`.** Correctness requirement, not a feature. `rows[i].columns[j]` may be an **index into `uniqueValues[columns[j]]`** rather than a value, and the `Entity` column is hoisted to `rows[i].entity` (`ResultTableConverter.cs:71-78`). Must be normalized in exactly one place, before any output path. Getting this wrong produces plausible-looking wrong data. |
| REQ-023 | m3 | **Aggregates and grouping.** `groupResults: true` with `Count`/`Sum`/`Min`/`Max`/`Average`/`CountDistinct`/`CountNull`/`CountNotNull`/`CountTrue`. Aggregate tokens require `groupResults`, and `SubTokensOptions` differ per slot. |
| REQ-024 | m1 | **Pagination and result variants.** `All`/`Firsts`/`Paginate` modes, plus `--all` that pages transparently and streams rather than buffering. Also expose the `lites`, `entities`, and `queryValue` endpoint variants. |
| REQ-025 | m3 | **Temporal queries.** `systemTime` for `Signum.TimeMachine`-enabled apps. |
| REQ-026 | m3 | **Entity autocomplete.** `api/query/findLiteLike` for resolving a human string to a `Lite` — needed to make write commands usable without knowing ids. |

---

## D. Entities

| ID | Milestone | Requirement |
|---|---|---|
| REQ-030 | m1 | **Retrieve.** By type + id and by `Lite` key (`"Order;42"` — `TypeName;id`). Support `entityPack`/`entityPackLight` to get `canExecute` alongside the entity. Also `exists` and `fetchAll`. |
| REQ-031 | m2 | **Entity JSON round-trip fidelity.** Read an entity, modify it, write it back without corruption. Must respect: `Type` on entities (clean name — `RoleEntity` → `"Role"`) vs `EntityType` on Lites (mixing throws); `ticks` as a **string**; `MList` as `[{rowId, element}]`; special properties **first** in the object; unknown keys rejected. |
| REQ-032 | m2 | **Propagate `modified`.** `modified: true` must be set up the **whole entity graph**, not just the changed leaf — the browser client does this via `GraphExplorer.propagateAll` in `ajaxPostRaw`. Missing it makes saves silently drop changes. Quiet-failure risk; needs explicit tests. |
| REQ-033 | m2 | **Optimistic concurrency.** Round-trip `ticks` and detect conflict: HTTP 500 with `exceptionType == "Signum.Engine.ConcurrencyException"`. Report as a distinct, actionable error with its own exit code — never as a generic 500. |
| REQ-034 | m3 | **Pre-flight validation.** `POST api/validateEntity` before attempting a save, so failures surface before mutation. |

---

## E. Operations

**There is no save endpoint.** All mutation is an operation — this shapes the whole write surface.

| ID | Milestone | Requirement |
|---|---|---|
| REQ-040 | m2 | **Execute operations.** `executeEntity` and `executeLite`. Must choose the right variant: `…Entity` when the local graph has unsaved changes, `…Lite` when only an identity is held. Includes save, via e.g. `UserOperation.Save`. **Constraint:** `OperationController.cs:142` hardcodes `inUserInterface: true`, so operations hidden from the web UI **cannot be invoked over the API at all** — by this CLI or any client. See [STORY-40](stories/operations.md). |
| REQ-041 | m2 | **operationKey resolution.** Keys are `ContainerClassName.FieldName`, **not** namespace-qualified (`Signum/Basics/Symbol.cs:22`). **Operations are first-class commands** in verb-noun form — `signum ship order 42`, `signum create order` — resolved against metadata, with the dotted key as the canonical unambiguous equivalent. Built-ins win dispatch, so a shadowed operation verb must be flagged in discovery output ([CLI surface](design/cli-surface.md) §2.1). Resolve friendly input against cached metadata; disambiguate rather than guess. |
| REQ-042 | m2 | **`args` encoding.** `args` is discriminated **by JSON shape** (`BaseOperationRequest.ConvertObject`, `OperationController.cs:~165-200`): object with `EntityType` → `Lite`, with `Type` → `ModifiableEntity`, number → **always `decimal`**, array → recursive list. **Two silent traps the CLI must guard:** a string that parses as a date is coerced to `DateTime`, so a date-shaped value can never be sent as a string; and an object carrying neither `EntityType` nor `Type` falls through to app-registered `CustomOperationArgsConverters` and becomes **`null`** if none exists — no error, no warning. See [STORY-42](stories/operations.md). |
| REQ-043 | m2 | **Dry-run.** `--dry-run` using `canExecute` from `entityPack` (and `stateCanExecutes`) to report whether an operation would be permitted, without invoking it. Essential for both ops safety and agent use. |
| REQ-044 | m3 | **Construct and delete.** `construct`, `constructFromEntity`/`Lite`/`Many`, `deleteEntity`/`Lite`. |
| REQ-045 | m3 | **Bulk operations with progress.** `executeMultiple`, `deleteMultiple`, `constructFromMultiple`, and the NDJSON-streaming `executeLiteWithProgress`. Must stream progress, report per-item outcomes, and not abort the batch on one failure. |
| REQ-046 | m2 | **Destructive-action guard.** Confirm before mutating when stdout is a TTY; `--yes` to bypass; never prompt when not a TTY (fail instead, so a script cannot hang). |

---

## F. Output, errors, and UX

| ID | Milestone | Requirement |
|---|---|---|
| REQ-050 | m1 | **TTY-aware output.** Output selector is `-o/--output` (kubectl-style), specified in [`design/cli-surface.md`](design/cli-surface.md) §4. Aligned tables with colour when stdout is a TTY; structured output when piped. Explicit `--json` / `--csv` / `--tsv` / `--ndjson` always win. Respect `NO_COLOR`. Diagnostics to stderr, data to stdout — always, so piping is safe. |
| REQ-051 | m1 | **Exit-code taxonomy.** A documented, stable set. **Specified** in [`design/cli-surface.md`](design/cli-surface.md) §5: `0` ok, `1` unexpected, `2` usage, `3` not authenticated, `4` not authorized, `5` not found, `6` validation, `7` concurrency conflict, `8` transport, `9` blocked by policy. Codes 3 and 4 must be distinguished even though **the server returns 403 for both** — discriminate on `exceptionType` (AC-08.2). |
| REQ-052 | m1 | **Actionable error mapping.** Translate the server's vocabulary into remediable messages: 403 covers both "not authenticated" and "not authorized" (there is no 401) — disambiguate them; 400 carries `ValidationProblemDetails`; 500 may be a `ConcurrencyException`. Never surface a bare status code. |
| REQ-053 | m2 | **`--explain` and tracing.** `--explain` prints the exact HTTP request that would be sent, without sending it. `-v`/`--trace` shows real request/response traffic. **Both must redact credentials** — headers, tokens, keys — with redaction tested. |
| REQ-054 | m2 | **Input from files and stdin.** Accept entity JSON and id/Lite lists via `@file` and `-` (stdin), so the CLI composes in pipelines and agents can pass structured input without shell-quoting hazards. |
| REQ-056 | m1 | **Caller-context detection.** Resolve `interactive` / `automated` / `agent` from TTY state, agent env markers (`AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE_*`), parent process, and `signum mcp` mode. **Fail closed** — anything not provably interactive is at least `automated`. Overridable, with loosening logged. **Never a security boundary:** every signal is spoofable in both directions and absent for unknown agents; its only job is to pick a stricter default. Under `agent`, m1 refuses to emit row data without an explicit acknowledgement flag. See [ADR 0007](decisions/0007-ai-caller-detection-and-pseudonymization.md), [STORY-50/51](stories/privacy.md). |
| REQ-057 | m2 | **Pseudonymization.** Replace sensitive values with **stable surrogates** (not redaction), so agents can still group and correlate. Modes `off`/`heuristic`/`strict`. **The framework offers no sensitivity metadata whatsoever** — no `[PersonalData]`, nothing GDPR-aware — and the CLI is generic, so correct automatic classification is impossible in principle; heuristics (English + German member names) are a default, an explicit per-profile policy overrides them, and `strict` is allowlist-only. **The policy is resolved locally and is never a per-call parameter** — an agent may read the classification (REQ-059) but must not be able to set or waive it, or the protection rests on the party that wants the data ([ADR 0009](decisions/0009-agent-mediated-privacy.md)). `off` is settable by a human, never by the caller under `agent`. Must state what it pseudonymized, warn that coverage is incomplete, and **never claim compliance** — pseudonymized data remains personal data under GDPR Art. 4(5). See [STORY-52](stories/privacy.md). |
| REQ-058 | m2 | **Local re-identification mapping.** Emit opaque `ref:…` handles in place of `Lite` keys so an agent can act on a record it cannot identify; accept `ref:…` wherever a `Lite` is taken and resolve locally before the request. Mapping stored `0600` and **never** emitted in stdout, `--json`, MCP results, traces, or telemetry. Human-only `unmask` command; mutations via a handle are audit-logged against the real target. *(The command is `unmask` — short and guessable, since CLI verbs are typed daily. The concept keeps its precise name: this is **re-identification**, not un-redaction, because a pseudonym was substituted rather than a value hidden.)* Surrogate scope must be **per-profile, not per-run**, for agent-mediated flows — a multi-invocation workflow otherwise sees a different surrogate for the same person in each step and cannot correlate them ([ADR 0009](decisions/0009-agent-mediated-privacy.md) open question 1). See [STORY-53](stories/privacy.md). |
| REQ-059 | m2 | **Privacy policy introspection.** `signum explain <Type> --privacy` reports, per member, whether it would be pseudonymized and **why** — heuristic match, explicit policy, or allowlisted under `strict`. Read-only and value-free, so it is safe under `agent` for the same reason structured help is (AC-62.5). This is what lets an agent *explain* what will be hidden without being able to *change* it: it asks rather than decides ([ADR 0009](decisions/0009-agent-mediated-privacy.md) Decision 1). |
| REQ-078 | m2 | **Emit the command instead of the data.** An output mode that prints a runnable `signum …` invocation rather than rows, so an agent can hand a human an exact, inspectable command and never see the result — the human runs it in their own terminal, where the caller context is `interactive` and no gate applies. Numbering: REQ numbers are append-only and section boundaries are not numeric ranges ([ADR 0009](decisions/0009-agent-mediated-privacy.md) Decision 2). |
| REQ-055 | m3 | **Culture handling.** Dates, numbers and decimals come from a business database and Signum apps are multi-culture. Support `--culture`; document the default. Related: `InvariantGlobalization` is deliberately **off** (ADR 0003). |

---

## G. MCP server mode

Resolves [ADR 0002](decisions/0002-mcp-vs-http.md) option C2. Motivated by "AI agents" and
"Claude Code" being primary consumers.

| ID | Milestone | Requirement |
|---|---|---|
| REQ-060 | m3 | **MCP server mode.** `signum mcp` exposes the CLI's deterministic commands as MCP tools over stdio, so **any** Signum app becomes agent-drivable with **no server-side module**. Must not require `Signum.Agent` in the target app. |
| REQ-061 | m3 | **Metadata-derived tool schemas.** Generate tool schemas from the REQ-010 cache so tools reflect the actual target app. Consider lazy disclosure — `Signum.Agent` does this via `Describe` + `ToolListChangedNotification`, and a large app's type list will not fit a tool list comfortably. |
| REQ-062 | m3 | **Write guardrails under MCP.** Mutating tools need an explicit opt-in (read-only by default), an allowlist or confirmation path, and audit logging. Rationale: in `Signum.Agent`, prompt injection already reaches the destructive `OperationSkill` write path with `ConfirmUISkill` advisory only — this CLI must not reproduce that. |

---

## H. Non-functional

| ID | Milestone | Requirement |
|---|---|---|
| REQ-070 | always | **Self-contained, no dependencies.** One executable, dropped anywhere, runs — no runtime install, no external tools, no required config file. Per [ADR 0003](decisions/0003-self-contained-distribution.md). |
| REQ-071 | always | **Self-contained build hygiene.** `bun build --compile` single executable per target; TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; branded types at the parse boundary with a single parse-and-validate layer as their only producer; minimal dependency tree; no npm-install distribution path (that would violate REQ-070). Because TS types erase at runtime, the correctness tests (AC-21.3/21.4, AC-31.6, AC-32.3) are **release-blocking** — see [ADR 0006](decisions/0006-typescript-bun.md) cost 5. |
| REQ-072 | m3 | **Startup budget.** Fast enough for interactive and per-invocation agent use. Set a concrete budget once measured — **no AOT figure in these docs has been measured** (no .NET SDK on the dev machine yet). |
| REQ-073 | m3 | **Cross-platform releases.** linux-x64 first; then linux-arm64, osx-arm64, osx-x64, win-x64. **Measured 2026-07-25:** Bun cross-compiles linux-x64, linux-x64-musl, linux-arm64, darwin-arm64 and windows-x64 from a single Linux host, so this collapses to one CI job rather than a per-OS matrix. Publish checksums; decide signing before the first public release — unsigned macOS binaries are Gatekeeper-quarantined. |
| REQ-074 | always | **No credential leakage.** No key, token, or password may appear in stdout, stderr, logs, traces, telemetry, crash output, or any file except the credential store. Tested, not merely intended. |
| REQ-075 | always | **Works against any Signum app.** No server-side module required. The one documented exception is API-key auth (REQ-002), which needs `Signum.Rest` — degrade to REQ-003 with a clear message. |
| REQ-076 | m3 | **Version and capability detection.** Detect the target app's framework version and available modules; degrade gracefully and say so, rather than failing obscurely, when something is absent. |
| REQ-077 | always | **Test strategy without a live server.** Contract tests against recorded fixtures for offline CI, plus an opt-in live suite against a real app. **Nothing in `docs/` has been verified against a running server** — the live suite is what converts these documents from hypothesis to fact. First live run is scripted in [`reference/live-verification-runbook.md`](reference/live-verification-runbook.md); it is the standing blocker on every other requirement's closure, which is why it is P0. |

---

## Open questions

Not yet answerable; each blocks a requirement.

1. **Is browser-based login possible at all** without framework changes? (REQ-004) — the
   single largest unknown, and it gates the `gh`-like experience the owner asked for.
2. **Which IdP flows work headlessly** for `WindowsAD` / `AzureAD` / `OpenID`? (REQ-005)
3. **Is the `rmcp` Rust MCP SDK mature enough** for REQ-060, or do we hand-roll JSON-RPC over stdio?
   (ADR 0005)
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

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-001 | [#1](https://github.com/pajoma/signum-cli/issues/1) | `m2` | Connection profiles |
| REQ-002 | [#2](https://github.com/pajoma/signum-cli/issues/2) | `m3` | API-key authentication |
| REQ-003 | [#3](https://github.com/pajoma/signum-cli/issues/3) | `m3` | Username/password → bearer |
| REQ-004 | [#4](https://github.com/pajoma/signum-cli/issues/4) | `m3` | Browser-based login |
| REQ-005 | [#5](https://github.com/pajoma/signum-cli/issues/5) | `m3` | External IdP authentication |
| REQ-006 | [#6](https://github.com/pajoma/signum-cli/issues/6) | `always` | Credential handling |
| REQ-007 | [#7](https://github.com/pajoma/signum-cli/issues/7) | `m1` | Identity check |
| REQ-008 | [#49](https://github.com/pajoma/signum-cli/issues/49) | `m1` | Browser token handoff |

**B. Metadata and discovery**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-010 | [#8](https://github.com/pajoma/signum-cli/issues/8) | `m1` | Metadata cache |
| REQ-011 | [#9](https://github.com/pajoma/signum-cli/issues/9) | `m1` | Discovery commands |
| REQ-012 | [#10](https://github.com/pajoma/signum-cli/issues/10) | `m2` | Token discovery and validation |
| REQ-013 | [#11](https://github.com/pajoma/signum-cli/issues/11) | `m3` | Shell completion |
| REQ-014 | [#53](https://github.com/pajoma/signum-cli/issues/53) | `m1` | Help at every level |

**C. Queries**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-020 | [#12](https://github.com/pajoma/signum-cli/issues/12) | `m1` | Execute dynamic queries |
| REQ-021 | [#13](https://github.com/pajoma/signum-cli/issues/13) | `m1` | Filter/column/order expression syntax |
| REQ-022 | [#14](https://github.com/pajoma/signum-cli/issues/14) | `m1` | De-intern `ResultTable` |
| REQ-023 | [#15](https://github.com/pajoma/signum-cli/issues/15) | `m3` | Aggregates and grouping |
| REQ-024 | [#16](https://github.com/pajoma/signum-cli/issues/16) | `m1` | Pagination and result variants |
| REQ-025 | [#17](https://github.com/pajoma/signum-cli/issues/17) | `m3` | Temporal queries |
| REQ-026 | [#18](https://github.com/pajoma/signum-cli/issues/18) | `m3` | Entity autocomplete |

**D. Entities**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-030 | [#19](https://github.com/pajoma/signum-cli/issues/19) | `m1` | Retrieve |
| REQ-031 | [#20](https://github.com/pajoma/signum-cli/issues/20) | `m2` | Entity JSON round-trip fidelity |
| REQ-032 | [#21](https://github.com/pajoma/signum-cli/issues/21) | `m2` | Propagate `modified` |
| REQ-033 | [#22](https://github.com/pajoma/signum-cli/issues/22) | `m2` | Optimistic concurrency |
| REQ-034 | [#23](https://github.com/pajoma/signum-cli/issues/23) | `m3` | Pre-flight validation |

**E. Operations**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-040 | [#24](https://github.com/pajoma/signum-cli/issues/24) | `m2` | Execute operations |
| REQ-041 | [#25](https://github.com/pajoma/signum-cli/issues/25) | `m2` | operationKey resolution |
| REQ-042 | [#26](https://github.com/pajoma/signum-cli/issues/26) | `m2` | `args` encoding |
| REQ-043 | [#27](https://github.com/pajoma/signum-cli/issues/27) | `m2` | Dry-run |
| REQ-044 | [#28](https://github.com/pajoma/signum-cli/issues/28) | `m3` | Construct and delete |
| REQ-045 | [#29](https://github.com/pajoma/signum-cli/issues/29) | `m3` | Bulk operations with progress |
| REQ-046 | [#30](https://github.com/pajoma/signum-cli/issues/30) | `m2` | Destructive-action guard |

**F. Output, errors, and UX**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-050 | [#31](https://github.com/pajoma/signum-cli/issues/31) | `m1` | TTY-aware output |
| REQ-051 | [#32](https://github.com/pajoma/signum-cli/issues/32) | `m1` | Exit-code taxonomy |
| REQ-052 | [#33](https://github.com/pajoma/signum-cli/issues/33) | `m1` | Actionable error mapping |
| REQ-053 | [#34](https://github.com/pajoma/signum-cli/issues/34) | `m2` | `--explain` and tracing |
| REQ-054 | [#35](https://github.com/pajoma/signum-cli/issues/35) | `m2` | Input from files and stdin |
| REQ-055 | [#36](https://github.com/pajoma/signum-cli/issues/36) | `m3` | Culture handling |
| REQ-056 | [#50](https://github.com/pajoma/signum-cli/issues/50) | `m1` | Caller-context detection |
| REQ-057 | [#51](https://github.com/pajoma/signum-cli/issues/51) | `m2` | Pseudonymization |
| REQ-058 | [#52](https://github.com/pajoma/signum-cli/issues/52) | `m2` | Local re-identification mapping |
| REQ-059 | [#89](https://github.com/pajoma/signum-cli/issues/89) | `m2` | Privacy policy introspection |
| REQ-078 | [#90](https://github.com/pajoma/signum-cli/issues/90) | `m2` | Emit the command instead of the data |

**G. MCP server mode**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-060 | [#37](https://github.com/pajoma/signum-cli/issues/37) | `m3` | MCP server mode |
| REQ-061 | [#38](https://github.com/pajoma/signum-cli/issues/38) | `m3` | Metadata-derived tool schemas |
| REQ-062 | [#39](https://github.com/pajoma/signum-cli/issues/39) | `m3` | Write guardrails under MCP |

**H. Non-functional**

| ID | Issue | Milestone | Title |
|---|---|---|---|
| REQ-070 | [#40](https://github.com/pajoma/signum-cli/issues/40) | `always` | Self-contained, no dependencies |
| REQ-071 | [#41](https://github.com/pajoma/signum-cli/issues/41) | `always` | Statically self-contained build |
| REQ-072 | [#42](https://github.com/pajoma/signum-cli/issues/42) | `m3` | Startup budget |
| REQ-073 | [#43](https://github.com/pajoma/signum-cli/issues/43) | `m3` | Cross-platform releases |
| REQ-074 | [#44](https://github.com/pajoma/signum-cli/issues/44) | `always` | No credential leakage |
| REQ-075 | [#45](https://github.com/pajoma/signum-cli/issues/45) | `always` | Works against any Signum app |
| REQ-076 | [#46](https://github.com/pajoma/signum-cli/issues/46) | `m3` | Version and capability detection |
| REQ-077 | [#47](https://github.com/pajoma/signum-cli/issues/47) | `always` | Test strategy without a live server |
