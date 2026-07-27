# User stories — conventions

Stories are the **testable** form of the [requirements](../requirements.md). A requirement says what
must be true; a story says how you would know. Work is accepted against **acceptance criteria**
(`AC-nn.n`), never against a requirement's prose.

Each story is also a GitHub issue labelled `user-story`, but **the text is authored here**. The issue
is a pointer and a place to discuss; this directory is the source. Amend the markdown first.

## Reading an AC

| Marker | Meaning |
|---|---|
| *(no marker)* | In the story's own milestone. |
| `m2` / `m3` prefix | Deferred to that milestone, with the reason stated inline. The AC is **not** a gap in the story's own milestone. |
| *(Amended: …)* | The AC was **changed** after implementation showed the original wording was wrong. The note says what changed and why. |

## Why amendments are recorded rather than silently applied

An AC that disagrees with shipped code is a decision, not a bug — and which of the two is wrong
varies. Both directions have happened here:

- **The code was right.** AC-51.3 exempted `--count` from the privacy gate, but a row count over a
  filtered population is an aggregate over personal data, and this story set's own limits section
  says aggregates leak. The implementation gates it; the AC changed.
- **The AC described something unverifiable.** AC-06.1 asked `auth status` to report a role. Nothing
  in this project claims a wire fact without a source citation or a live response, and that one
  could have neither. The field was removed rather than guessed at.
- **The AC over-reached its milestone.** AC-24.2 needed a live endpoint; AC-61.1 needed a metadata
  path in help that does not exist. Both were marked rather than quietly left looking unmet.

Recording the reasoning is the point. A closed milestone whose ACs were bent to fit is worth less
than an open one, and a reader six months from now cannot tell the difference without the note.

## Files

| File | Stories |
|---|---|
| [`auth.md`](auth.md) | STORY-01..12 — authentication, credential handling, identity |
| [`query.md`](query.md) | STORY-20..27 — querying, result correctness, output, pagination, discovery |
| [`entities.md`](entities.md) | STORY-30..34 — retrieval and round-trip fidelity |
| [`operations.md`](operations.md) | STORY-40..46 — operations and writes |
| [`privacy.md`](privacy.md) | STORY-50..53 — caller context and pseudonymization |
| [`help.md`](help.md) | STORY-60..63 — discoverability |
