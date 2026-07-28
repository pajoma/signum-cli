# ADR 0007 — AI-caller detection and pseudonymization

**Status:** ACCEPTED (design); implementation staged across m1/m2
**Date:** 2026-07-25
**Owner question:** *"Can we detect if the CLI is called by AI? If yes, we need to make sure any
sensitive data is pseudonymized."*

## Short answer

**Detection: partially, never reliably.** There are real signals, they are all spoofable, and they are
absent for unknown callers. Detection is therefore usable **only to tighten defaults**, never as a
security boundary.

**Pseudonymization: yes, but it cannot be automatic-and-correct.** The Signum framework exposes **no
sensitivity metadata at all**, so nothing tells the CLI which fields are personal data. That forces an
explicit policy.

The load-bearing conclusion: **decouple the two.** Pseudonymization must be a property of *the data and
the configured policy*, not a consequence of *guessing who is asking*. Detection only picks a safer
default.

## Part 1 — Can we detect an AI caller?

### What is actually observable

Measured on this machine, running under Claude Code:

| Signal | Observed | Reliability |
|---|---|---|
| `AI_AGENT` env var | set | generic, but purely advisory |
| `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, +3 more | set | strong for this vendor; absent for others |
| Parent process name | literally `claude` | Linux `/proc` only; laundered by any intermediate `bash -c` |
| `stdout`/`stdin` not a TTY | both non-TTY | necessary, not sufficient — also true of cron, CI, and `| jq` |
| `CI` env var | unset | orthogonal |
| **Our own `signum mcp` subcommand** | n/a | **definitive** — if we are serving MCP, the consumer *is* a program |

### Why this cannot be a security control

1. **Trivially spoofable in both directions.** `env -u CLAUDECODE` hides it; `AI_AGENT=1` fakes it.
2. **Vendor-specific.** A bespoke agent, or any vendor we have not enumerated, looks exactly like a shell
   script.
3. **Laundered by indirection.** An agent invoking `bash -lc 'signum …'` makes the parent `bash`.
4. **A heuristic that fails open produces false assurance** — worse than no check, because someone will
   rely on it.

### Decision — fail closed, and never rely on it

- Compute a **caller context**: `interactive` | `automated` | `agent`.
- `agent` when an agent marker is present **or** we are in `signum mcp` mode.
- `automated` when no TTY and no marker.
- `interactive` **only** when stdout is a TTY *and* no agent marker.
- **Fail closed:** anything not provably `interactive` is treated as at least `automated`, and the
  privacy default for `agent`/`automated` is the *stricter* one.
- `--caller-context` / `SIGNUM_CALLER_CONTEXT` may **override**, and overriding *toward* stricter is
  always honoured. Loosening is honoured too — but logged, because it is a deliberate act.
- The detection result is **reported** (`auth status`, `--explain`) so nobody has to guess what the CLI
  concluded.

Detection is allowed to make things safer. It is never permitted to be the *reason* something is safe.

## Part 2 — Pseudonymization

### The core problem: no sensitivity metadata exists

Verified by searching the framework: there is **no** `[PersonalData]`, no sensitivity attribute, no PII
marker, nothing GDPR-aware anywhere in `Signum/` or `Extensions/`. `ReflectionServer` ships a display
`Format` string and type information only.

And the CLI is **generic** — it has no domain knowledge. It cannot know that `Customer.Name` is personal
data while `Product.Name` is not. So automatic, correct classification is **impossible in principle**,
not merely unimplemented.

### Options considered

| Option | Verdict |
|---|---|
| **A. Name heuristics** — match member names (`name`, `email`, `phone`, `iban`, `birthdate`, …) | Useful default, **never sufficient**. Locale-dependent: a German app has `Nachname`, `Geburtsdatum`, `Anschrift`, `Steuernummer`. Misses free text entirely. |
| **B. Explicit policy** — per-profile config listing tokens/types to pseudonymize | Most reliable. Costs setup, which is acceptable for a privacy control even though REQ-070 otherwise demands zero-setup operation. |
| **C. Deny by default** — pseudonymize everything except an allowlist | Safest, and it makes output nearly useless without configuration. Right choice for a *strict* mode. |
| **D. Upstream a sensitivity attribute** in Signum | Correct long-term fix, out of our control, and we cannot change the target app's config anyway. Worth proposing; useless now. |

### Decision — layered, with the honest default

1. **Heuristics (A) on by default** for `agent` context, and reported: the CLI states which fields it
   pseudonymized *and* warns that the list is heuristic and certainly incomplete.
2. **Explicit policy (B)** overrides and extends heuristics, per profile.
3. **Strict mode (C)** available as `--pseudonymize=strict` — allowlist only — for anyone who needs a
   defensible position rather than a best effort.
4. **Never claim compliance.** The CLI's own documentation must say this reduces exposure and is *not* by
   itself a GDPR control. Pseudonymized data remains personal data under GDPR Art. 4(5).

### Pseudonymization, not redaction

The user asked for pseudonymization, and the distinction matters:

- **Redaction** destroys the value — output becomes unusable for correlation.
- **Pseudonymization** replaces it with a **stable surrogate** — `Customer-7f3a` — so an agent can still
  group, join, and reason across rows without seeing the real value.
- **Anonymization** is irreversible and effectively unachievable on relational business data; we do not
  claim it.

Surrogates are derived from a **per-run (or per-profile, if the user wants stability) secret** and are
stable *within* that scope, so the same person is the same surrogate across rows and across commands.

### Identifiers are the hard part

An agent needs a handle to *act* on a record — `signum operation Order.Ship --lite "Order;42"`. Pseudonymize
the id and the agent cannot act; leave it and the agent sees a real database identifier that is directly
re-identifying against the app.

**Resolution: opaque local handles.** In pseudonymizing mode the CLI emits `ref:7f3a` instead of
`Order;42`, keeps the mapping **locally**, and accepts `ref:7f3a` wherever a `Lite` is expected, resolving
it before the request. The model never sees a real id, and the agent stays fully capable. This is the one
piece of the design that is genuinely elegant rather than merely careful.

### The mapping never leaves the machine

The surrogate→real mapping is written to a local store with `0600`, is never printed unless explicitly
asked for, and is never included in `--json` output, MCP tool results, traces, or telemetry. A
`unmask` command lets a **human** resolve surrogates locally. (Named `de-pseudonymize` in this ADR's original text; renamed for typability, with the *concept* still called re-identification — see REQ-058.)

## Known limits — to be stated in the CLI's own help

Someone will otherwise assume more than this delivers.

1. **Free-text fields can contain anything.** A `Comments` field holding "call Herr Müller on 0170…" will
   not be caught by name heuristics.
2. **Heuristics are locale-dependent and incomplete.**
3. **Metadata itself can be identifying** — type names, query names, and validation messages may leak
   context even when values are surrogates.
4. **Row counts and distributions leak information** even with every value pseudonymized.
5. **Detection is spoofable**, so a caller that suppresses its markers gets `automated`, not `agent`
   treatment. This is why strict mode exists and why the default must fail closed.
6. **This is not a compliance control.** It reduces exposure. Whether a given use is lawful is a decision
   for the data controller, not this tool.

## Requirements added

| | Milestone | |
|---|---|---|
| REQ-056 | **m1** | Caller-context detection, fail-closed, reported |
| REQ-057 | **m2** | Pseudonymization engine — heuristics, policy, strict mode |
| REQ-058 | **m2** | Local re-identification mapping and opaque `ref:` handles |

**Why REQ-056 is m1 while the engine is m2:** agent exposure exists from m1, because Claude Code can
invoke the binary directly (that is the stated reason MCP itself is m3). So m1 must at minimum *detect*
the agent context and **fail closed** — refuse to emit data under a detected agent unless the user passes
an explicit acknowledgement flag. That is cheap, honest, and safe, and it avoids shipping a read-only m1
that quietly streams personal data into a model. The full engine can then follow in m2 without a window
of silent exposure.

Stories: [`../stories/privacy.md`](../stories/privacy.md).
