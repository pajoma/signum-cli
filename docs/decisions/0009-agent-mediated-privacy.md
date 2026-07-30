# ADR 0009 — Agent-mediated queries: who decides what gets pseudonymized

**Status:** PROPOSED — design for m2, supersedes nothing but **corrects the shape of REQ-057/058**
**Date:** 2026-07-28
**Owner scenario:** a Signum instance managing employee competencies. The human asks Claude Code
*"gib mir alle User mit Skill Java"*, and the agent works it out through the CLI: `types` →
`explain Skill` (assess which fields are privacy-relevant — here none) → query Skill → `explain User`
(name and id must be pseudonymized) → query users, *stating that name and id must be pseudonyms* →
analyse → finally either pipe the data out itself, or print the command for the human to run.

## Short answer

The flow is right about the hard part and wrong about the load-bearing part.

**Right:** ending with a choice between *emitting the data* and *emitting the command that would emit
the data*. That is a genuinely new idea, it is not in any requirement, and it is the cleanest answer
anyone has offered to "an agent needs to work with data it should not read".

**Wrong:** steps 3, 5 and 6 make the **agent** classify the fields and then **pass the policy as a
parameter**. That puts the protection in the hands of the party whose interest is to see the data.
Whoever can pass `--pseudonymize name,id` can also not pass it.

[ADR 0007](0007-ai-caller-detection-and-pseudonymization.md) already decided this, and the wording is
worth repeating because the proposed flow contradicts it directly:

> pseudonymization must be a property of *the data and the configured policy*, not a consequence of
> *guessing who is asking*.

## Decision 1 — invert the trust: the CLI classifies, the agent may only read the classification

| | Proposed flow | Decision |
|---|---|---|
| Who classifies fields | the agent, per call | the **CLI**, from configured policy + heuristics |
| How the policy travels | agent passes "pseudonymize name, id" | it does not travel — it is resolved locally |
| Agent's access to it | sets it | **reads** it (`explain <Type> --privacy`) |
| Default under `agent` | agent must remember | **fail closed**: pseudonymized unless a human overrode |

The agent keeps everything it actually needs: it can see *what will be* pseudonymized, explain that
to the user, and reason about the surrogates. It loses only the ability to turn the protection off —
which is the one capability it must not have.

This also removes a class of prompt-injection: a malicious row value cannot talk the agent into
dropping a flag that the agent was never able to set.

**Escape hatch stays human.** `--i-understand-data-goes-to-a-model` (AC-51.2) already exists and is
deliberately unmissable. Under this ADR it remains the *only* way to get real values into an agent's
context, and a human types it.

## Decision 2 — two new requirements

Both are genuinely absent from the current set.

**REQ-059 — Privacy policy introspection.** `signum explain <Type> --privacy` reports, per member,
whether it would be pseudonymized and *why* (heuristic match / explicit policy / allowlisted under
`strict`). Read-only, no data values, so it is safe under `agent` for the same reason structured help
is (AC-62.5). This is what makes steps 3 and 5 of the scenario work **without** handing the agent
control: it can say "Name and Id will be surrogates, Level will not" and be right, because it asked
rather than decided.

**REQ-078 — Emit the command instead of the data.** An output mode that prints a runnable
`signum …` invocation rather than rows, so an agent can hand the human an exact, inspectable command
and never see the result. The human runs it in their own terminal, where the caller context is
`interactive` and no gate applies.

> Numbering note: REQ numbers are append-only and section boundaries are not numeric ranges.
> REQ-059 completes the privacy block in section F; REQ-078 is the next free number and is filed in
> section F as an output requirement.

## Decision 3 — the corrected flow

```bash
signum types                                        # m1 ✓
signum explain Skill --privacy                      # REQ-059 — nothing sensitive here
signum query Skill --filter "Name = Java"           # m1 ✓ — exact Lite, see below
signum explain User --privacy                       # REQ-059 — Name → surrogate, Id → ref_
signum query UserSkill --filter "Skill = Skill;2440" --resolve
                                                    # pseudonymization applies AUTOMATICALLY
# …agent analyses surrogates…
signum unmask ref_7f3a1c2b4d5e                      # REQ-058 — human only
```

Note what is **not** in that list: any flag by which the agent asks for or waives pseudonymization.

### Why the scenario's two-step query is correct

The scenario resolves the Skill first and only then queries users, which is better than filtering
`Skill.ToString ~ Java` in one request: **`~` is contains, so "Java" also matches "JavaScript"**.
Resolving to an exact `Lite` and filtering `Skill = Skill;2440` cannot. Recorded because the
single-request form is the obvious thing to reach for and it is subtly wrong.

## Consequences

- **REQ-057 and REQ-058 change shape.** Both currently read as though the policy is configured
  locally *and* supplied per call. The per-call half is removed: an agent-supplied policy parameter
  must not exist. REQ-057's `off`/`heuristic`/`strict` modes stay, but `off` is settable only by a
  human, never by the caller under `agent`.
- **STORY-52/53 gain criteria** for introspection and for command-emission.
- **The scenario is m2-blocked, not m1-blocked.** Today it stops at the first data query: under a
  detected agent, m1 refuses row data outright (STORY-51), so there is no middle ground between
  "refused" and "everything". REQ-057 is exactly the missing middle.
- **This flow argues for MCP** (REQ-060/061, ADR 0002 still open). Five CLI invocations with metadata
  reasoning between them is precisely what a tool surface is for. It does not *need* MCP — the CLI
  is the contract either way — but the ergonomics point that way.

## Limits that survive this design

Stated because the scenario's step 7 — *"then it analyses…"* — is exactly where they bite, and
because REQ-057 forbids the CLI from ever claiming compliance.

- **Aggregates leak.** "The only user with both Java and COBOL" re-identifies a person even when
  every value on the row is a surrogate. Pseudonymization does not survive inference over a small
  population, and an agent doing analysis is an inference engine.
- **Free text defeats heuristics.** A `Comments` field containing a name is not caught by
  member-name matching, and never will be.
- **Metadata identifies.** Type and query names carry context — "Kompetenzen", a customer-specific
  entity name — even with every value replaced.
- **Detection is spoofable**, which is why the default fails closed and why `strict` exists.
- **This is not a compliance control.** It reduces exposure. Whether a given use is lawful stays the
  controller's decision, and pseudonymized data remains personal data under GDPR Art. 4(5).

## Open questions

1. **Surrogate scope for this workflow.** Per-run is the REQ-057 default, but the scenario spans
   several invocations, so the agent would see a different surrogate for the same person in step 4
   and step 6 and could not correlate them. Per-profile scope (AC-52.2) is likely required for
   agent-mediated flows to work at all — needs deciding before implementation, not during.
2. **Does REQ-078 emit one command or a script?** A multi-step analysis may need several. One
   command is inspectable at a glance; a script is more useful and less reviewable.
3. **Is a user id personal data here?** The scenario says pseudonymize it. REQ-058's `ref_` handles
   already do, so the answer is yes by construction — but it is worth stating that this is a
   deliberate choice rather than an accident of the handle design.
