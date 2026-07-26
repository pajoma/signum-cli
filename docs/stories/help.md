# User Stories — Help

Stories for discoverability. Unlike [requirements](../requirements.md), stories carry **acceptance
criteria**.

Design: [`../design/cli-surface.md`](../design/cli-surface.md) §2.2.

> **Why this needs its own story set.** Half this CLI's command tree does not exist until it is pointed
> at an application. `signum query --help` can be authored; `signum ship order --help` must be
> *generated* from the target app's metadata. Help is therefore a feature with a data dependency, not a
> block of prose.

---

## STORY-60 — Find my way in with no setup

Traces to: REQ-014 · Priority: `m1`

**As someone who just downloaded the binary**, I want `signum` and `signum --help` to tell me what this
is and what to do next, so that I can get oriented without reading a README or authenticating.

**Acceptance Criteria:**
- AC-60.1: Bare `signum` and `signum --help` both print the overview: what the tool is, the command groups, global flags, and a concrete "next step" line.
- AC-60.2: Static help works with **no configuration, no context, no credentials, and no network**.
- AC-60.3: `--help` prints to **stdout** and exits **0**. An unknown command prints to **stderr** and exits **2** — help asked for is output; help after a mistake is a diagnostic.
- AC-60.4: Every command's help carries examples that are **executable exactly as written**.
- AC-60.5: Help honours `NO_COLOR` and `--no-color`, and never depends on a pager being present.
- AC-60.6: `signum help <topic>` covers `filter`, `tokens`, `output`, `exit-codes`, `auth`, `contexts`, and `pseudonymization` — the things too long for flag help but needed before first use.

---

## STORY-61 — Help that knows my application

Traces to: REQ-014, REQ-010 · Priority: `m1`

**As a developer meeting an undocumented Signum app**, I want `--help` on a concrete type or operation
to describe *that app's* schema, so that I do not have to read the application's source to use it.

**Acceptance Criteria:**
- AC-61.1: `signum query <queryKey> --help` shows that query's columns, default ordering, and filterable tokens.
- AC-61.2: `signum <verb> <Type> --help` (e.g. `signum ship order --help`) shows the operation's arguments, expected target kind (entity / lite / none), and any `canExecute` reasons available.
- AC-61.3: Dynamic help is sourced from the REQ-010 metadata cache, so with a warm cache it works **fully offline**.
- AC-61.4: **Dynamic help requires no authentication.** `api/reflection/types` is anonymous, so `signum --url <url> query Order --help` works before any login. This property is protected by a test — it is the difference between evaluating the tool and having to be onboarded first.
- AC-61.5: With no metadata available, help **degrades rather than fails**: it prints the static portion plus one line naming what it could not resolve and how to fix it (`--url`, or refresh the cache). Never an error.
- AC-61.6: A stale cache is used and flagged, not discarded — help that is slightly old beats no help.
- AC-61.7: An operation verb shadowed by a built-in (§2.1) is disclosed both in `signum operations <Type>` and in the shadowing built-in's help, so the collision is discoverable rather than mysterious.

---

## STORY-62 — Help I can parse

Traces to: REQ-014, REQ-061 · Priority: `m1`

**As an agent, an MCP tool layer, or a completion script**, I want help as structured data, so that I do
not have to scrape prose or reimplement knowledge the CLI already has.

**Acceptance Criteria:**
- AC-62.1: `-o json` works on **any** help invocation and emits a structured description of commands, flags, arguments, and — where resolvable — the app's types, queries, and operations.
- AC-62.2: That structure is the **single source** from which MCP tool schemas (REQ-061) are generated. Help and tool discovery must never become two hand-maintained descriptions of one command set.
- AC-62.3: The schema is stable and versioned; a breaking change to it is a breaking change to the CLI.
- AC-62.4: Shell completion (REQ-013) is driven from the same structure, not a parallel list.
- AC-62.5: Structured help contains **no data values** — only names, kinds, and descriptions — so it is safe to emit under an agent context without engaging the pseudonymization gate (STORY-51).

---

## STORY-63 — Be told what I should have done

Traces to: REQ-014, REQ-052 · Priority: `m1`

**As anyone who just made a mistake**, I want the error to point me at the specific help that resolves
it, so that I recover in one step instead of going hunting.

This is where help is actually read. A message that merely reports failure wastes the one moment the
user is definitely paying attention.

**Acceptance Criteria:**
- AC-63.1: An unknown query token lists the nearest valid tokens and points at `signum explain <Type>`.
- AC-63.2: An unparseable filter cites the rule it broke — for example the quoted-cast rule — and points at `signum help filter`.
- AC-63.3: An ambiguous operation verb lists the candidate canonical keys and exits non-zero, never guessing (AC-41.3).
- AC-63.4: An unknown type or query suggests near matches from cached metadata.
- AC-63.5: A namespace-qualified operation key is met with the actual key format, since that is a common wrong guess (AC-41.5).
- AC-63.6: An auth failure names which of the two 403 cases it was and what to do — re-authenticate, or stop because it is a permission problem (AC-08.2).
- AC-63.7: Suggestions come from the **cached metadata**, so a typo costs no round trip.

---

## Traceability

| Story | Requirements | Milestone |
|---|---|---|
| STORY-60 Find my way in with no setup | REQ-014 | `m1` |
| STORY-61 Help that knows my application | REQ-010, REQ-014 | `m1` |
| STORY-62 Help I can parse | REQ-014, REQ-061 | `m1` |
| STORY-63 Be told what I should have done | REQ-014, REQ-052 | `m1` |
