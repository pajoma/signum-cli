# User Stories — Caller context and pseudonymization

Stories for keeping personal data out of a model's context. Unlike
[requirements](../requirements.md), stories carry **acceptance criteria**.

Design and rationale: [ADR 0007](../decisions/0007-ai-caller-detection-and-pseudonymization.md).

> **The framework provides no help here.** There is no `[PersonalData]` attribute, no sensitivity flag,
> nothing GDPR-aware anywhere in Signum. The CLI is also generic, so it cannot know that `Customer.Name`
> is personal data while `Product.Name` is not. Every story below is built on that constraint rather
> than pretending around it.

---

## STORY-50 — Know who is asking

Traces to: REQ-056 · Priority: `m1`

**As a data controller**, I want the CLI to recognise when it is being driven by an AI agent rather than
a human, so that it can default to safer behaviour without me having to remember a flag.

**Acceptance Criteria:**
- AC-50.1: The CLI resolves a caller context of `interactive`, `automated`, or `agent` on every run.
- AC-50.2: `agent` is concluded when a known agent marker is present (`AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE_*`, or a recognised parent process). A future `signum mcp` mode would be the only *definitive* signal, but it does not exist while [ADR 0002](../decisions/0002-mcp-vs-http.md) is open — so **every detection this CLI performs today is heuristic**, which is consistent with AC-50.6 and is why the default fails closed.
- AC-50.3: `interactive` requires stdout to be a TTY **and** no agent marker. Anything else is at least `automated`. **Fail closed.**
- AC-50.4: `--caller-context` / `SIGNUM_CALLER_CONTEXT` can override. Tightening is silent; **loosening is logged**, because it is a deliberate act with consequences.
- AC-50.5: The resolved context and the signals behind it are reported by `auth status`, and the signals are named in a refusal message so a blocked caller can see what was concluded. Adding them to `--explain` output is `m2`.
- AC-50.6: Detection is **never** described in help text or docs as a security boundary. It is spoofable in both directions and its only job is to pick a stricter default.
- AC-50.7: Parent-process inspection is best-effort and platform-specific; its absence degrades to the other signals rather than erroring.

---

## STORY-51 — Do not leak data to a model by default

Traces to: REQ-056 · Priority: `m1`

**As a data controller**, I want the m1 read-only CLI to refuse to stream personal data into an agent's
context unless someone has consciously allowed it, so that there is no window where it happens silently.

m1 has no pseudonymization engine yet (that is REQ-057, m2), so the m1 behaviour is deliberately blunt:
detect, and stop.

**Acceptance Criteria:**
- AC-51.1: Under caller context `agent`, any command that would emit entity or query **data** fails by default with a clear explanation and the exact flag needed to proceed.
- AC-51.2: `--i-understand-data-goes-to-a-model` (or `SIGNUM_ALLOW_AGENT_DATA=1`) permits it. The name is deliberately unambiguous; no one should be able to pass it by accident or claim they did not know.
- AC-51.3: Commands emitting **no** data — `auth status`, `--explain`, help, and discovery of type, query and token *names* — are unaffected. Metadata is not row data. *(Amended: **`--count` removed from the exempt list.** A count over a filtered population is an aggregate over personal data, and this story set's own limits section says so: "Aggregates leak. Row counts and distributions are informative even with every value replaced." The implementation gates it; the AC now agrees.)*
- AC-51.4: The refusal names pseudonymization (m2) as the intended remedy, so the message ages into something useful rather than becoming a lie.
- AC-51.5: `interactive` and `automated` contexts are unaffected: a human at a terminal and a cron job keep working with no new flag. Only the `agent` path is gated.
- AC-51.6: The gate is enforced in one place, at the output boundary, so no future command can bypass it.

> **Deliberately blunt.** A hard stop with an explicit override is the honest m1 answer. The alternative —
> shipping a read-only CLI that quietly pipes citizen data into a model context — is not acceptable just
> because the pseudonymizer is not written yet.

---

## STORY-52 — Pseudonymize, do not redact

Traces to: REQ-057 · Priority: `m2`

**As a data controller**, I want sensitive values replaced by stable surrogates rather than blanked, so
that an agent can still group and reason across rows without seeing real personal data.

**Acceptance Criteria:**
- AC-52.1: Pseudonymization replaces a value with a **stable surrogate** (e.g. `Customer-7f3a`), consistent within the run so the same input maps to the same surrogate across rows and commands.
- AC-52.2: Surrogate scope is configurable: per-run (default) or per-profile for stability across invocations.
- AC-52.3: Three modes — `off`, `heuristic` (default under `agent`), and `strict` (allowlist only; everything not explicitly permitted is pseudonymized).
- AC-52.12: An **entity reference is always an identity**, judged by VALUE rather than by member name, and becomes a `ref:` handle under any pseudonymizing mode. Name-based rules cannot catch these: an entity-valued column is called `User`, `Customer` or `Owner` — none of which matches a heuristic — while its value denotes a person and renders as that person's label. Two individually-correct behaviours (label rendering, name-based classification) therefore combined to print real names under `heuristic`; the leak was only visible once both were in the same build. Columns whose values are an entity's label because `--resolve` rewrote them to `.ToString` are treated the same way, since the CLI knows it asked for them.
- AC-52.4: Heuristics cover common personal-data member names in **English and German** at minimum (`name`/`nachname`, `email`, `phone`/`telefon`, `address`/`anschrift`, `birthdate`/`geburtsdatum`, `iban`, `taxid`/`steuernummer`), because the target deployment is German-language.
- AC-52.5: An explicit per-profile policy can add and remove tokens and types, and **overrides** heuristics.
- AC-52.10: The policy is **resolved locally and is never a per-call parameter.** A caller cannot request, weaken or waive pseudonymization; only a human can, via `--i-understand-data-goes-to-a-model` or by editing the profile. Rationale: an agent-supplied policy puts the protection in the hands of the party whose interest is to read the data, and a malicious row value could talk an agent into omitting a flag it should never have been able to set ([ADR 0009](../decisions/0009-agent-mediated-privacy.md) Decision 1).
- AC-52.11: `signum explain <Type> --privacy` must agree with what a query actually does — introspection that contradicts behaviour is worse than none, because an agent would confidently tell a human that a field is safe while it is being replaced. In particular a member whose type resolves to another reflected type is an entity reference, and is reported as an identity (AC-52.12). It reports per member whether it would be pseudonymized and **why** — heuristic match, explicit policy, or allowlisted under `strict` (REQ-059). Read-only and value-free, so it is safe under `agent`. This is how an agent explains what will be hidden without being able to change it.
- AC-52.6: Output **states** what was pseudonymized and warns that heuristic coverage is incomplete. Silent partial protection is worse than none, because it invites false confidence.
- AC-52.7: Type preservation where it matters: a pseudonymized date stays date-shaped and a number stays numeric, so downstream parsing does not break.
- AC-52.8: `strict` mode is available for anyone needing a defensible position rather than best effort.
- AC-52.9: The CLI **never** claims compliance. Help text states plainly that pseudonymized data remains personal data under GDPR Art. 4(5) and that lawfulness is the controller's decision.

---

## STORY-53 — Keep agents capable without showing them real ids

Traces to: REQ-058 · Priority: `m2`

**As an operator**, I want an agent to be able to act on a record it cannot personally identify, so that
pseudonymization does not make the CLI useless for automation.

An agent needs a handle to act (`--lite "Order;42"`). A real `Lite` key is directly re-identifying against
the app; pseudonymizing it naively would break the ability to act at all.

**Acceptance Criteria:**
- AC-53.1: In pseudonymizing mode, `Lite` keys are emitted as opaque local handles instead of `TypeName;id`. *(Amended: the handle carries **48 bits** — `ref:7f3a1c2b4d5e`, not the illustrative `ref:7f3a`. 16 bits collide at a few hundred entries by the birthday bound, and a handle collision means two people sharing one identity — precisely the silent mismatch AC-53.6 forbids. The store also detects a collision on write rather than trusting the arithmetic.)*
- AC-53.2: Any argument accepting a `Lite` also accepts `ref:…`, resolving it locally **before** the request is built.
- AC-53.3: The surrogate→real mapping is stored locally with `0600` permissions and is **never** included in stdout, `--json`, MCP tool results, traces, logs, or telemetry.
- AC-53.4: An `unmask` command lets a **human** resolve surrogates locally, for auditing what an agent acted on. It needs a check of its own rather than the shared data gate: since REQ-057 landed, a detected agent passes `openData` whenever pseudonymization is active — correct for pseudonymized rows, and exactly wrong here, because resolving a handle is the act of *removing* the protection. So it refuses an agent unless the human-typed acknowledgement is present.
- AC-53.8: Surrogate scope defaults to **per-profile** where the caller context is `agent`, not per-run. A multi-invocation workflow — discover the type, resolve a lookup entity, then query rows — otherwise sees a different surrogate for the same person at each step and cannot correlate them at all, which defeats the purpose of surrogates over redaction ([ADR 0009](../decisions/0009-agent-mediated-privacy.md) open question 1).
- AC-53.9: An output mode emits a **runnable `signum` command instead of rows** (REQ-078), so an agent can hand a human an exact, inspectable invocation and never see the result. The human runs it where the context is `interactive` and no gate applies. This is the sound half of "pipe it or print the command": an agent that can pipe real values has not been constrained at all. **One command, not a script** (ADR 0009 open question 2, decided): the whole value is that a human can read it before running it, and a script trades that away — an agent needing several steps emits several commands, each inspectable on its own. The echo reproduces arguments **as given**, so a `ref:` handle stays a handle and `--as-command` sits after key validation, because handing someone a broken command they trusted an agent to compose is its own failure.
- AC-53.5: An unresolvable or expired `ref:` fails clearly rather than being forwarded as a literal string.
- AC-53.6: Handle scope and lifetime are documented; a stale handle after a scope change is an explicit error, never a silent mismatch. **Scope:** per profile, valid only for the surrogate secret that produced it. **Lifetime:** until `unmask --clear`, which is total and irreversible. Both are stated in the failure message, so a reader learns them at the moment they need them rather than from a document.
- AC-53.7: `m2` — Mutations performed via a `ref:` handle are recorded in the local audit log (AC-46.6) with the **real** target, so an operator can reconstruct what actually happened. **Not reachable yet:** this milestone has no write commands, so there is no mutation to log. The handle-resolution half it depends on is in place.

---

## Limits these stories do not overcome

Stated here and required in the CLI's help text (AC-52.6, AC-52.9), because otherwise someone will assume
more protection than exists:

- **Free text is not covered.** A `Comments` field containing "call Herr Müller on 0170…" defeats name-based heuristics entirely.
- **Heuristics are incomplete and locale-dependent**, always.
- **Metadata can identify.** Type names, query names, and validation messages carry context even when values are surrogates.
- **Aggregates leak.** Row counts and distributions are informative even with every value replaced.
- **Low cardinality defeats a stable surrogate.** Counting rows per surrogate re-identifies the mapping
  when a column has few distinct values — `3 / 1 / 1` over a `State` column is enough. Inherent to
  AC-52.1's stability requirement, so it is stated in the AC-52.6 disclosure rather than pretended
  away, and it is why `strict` protects a low-cardinality column less than its name suggests.
- **Detection is spoofable**, which is precisely why the default fails closed and why `strict` exists.
- **This is not a compliance control.** It reduces exposure; it does not make a given use lawful.

---

## Traceability

| Story | Requirements | Milestone |
|---|---|---|
| STORY-50 Know who is asking | REQ-056 | `m1` |
| STORY-51 No data to a model by default | REQ-056 | `m1` |
| STORY-52 Pseudonymize, do not redact | REQ-057 | `m2` |
| STORY-53 Capable agents without real ids | REQ-058, REQ-059, REQ-078 | `m2` |
