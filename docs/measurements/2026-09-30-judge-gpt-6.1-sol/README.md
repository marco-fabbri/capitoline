# Judge measurement: GPT-6.1-Sol against GPT-6-Sol, 2026-09-30

Codex 0.159.1 lists a new model, GPT-6.1-Sol (`codex-gpt-6.1-sol`). The
shipped judge chain holds GPT-6-Sol third, behind `claude-opus` and
`antigravity-claude-opus`: the model that writes the answer when neither
Claude seat can. The question is whether GPT-6.1-Sol takes that place.

The judge is what is measured, not a member's answer: a capability ladder
(`docs/measure-a-model.md`) would compare the two models answering, while the
judge's work is reading four answers and writing one.

## Registered before running

- **The councils** (`overlay-councils.yaml`): `capitoline-fast`'s four seats,
  no ranking stage, and a judge chain of one model: `codex-gpt-6.1-sol` in
  `capitoline-judge-sol61`, `codex-gpt-6-sol` in `capitoline-judge-sol6`.
  Five calls a question each, sixty in all.
- **The questions**: the six of `../2026-09-23-council/questions.json`, with
  their registered answers, unchanged except one address in the IPv4 test
  list replaced by another valid one on 2026-09-29 (any correct expression
  accepts either).
- **The run**: `scripts/measure-council.sh`, question-major, both councils on
  each question within minutes of each other.
- **The scoring**, as on 2026-09-23: each synthesis correct, partial or wrong
  against the registered answer, and each factual claim in it that none of the
  four members made classed as derived, unsourced and correct, or unsourced
  and wrong.
- **The rule**: GPT-6.1-Sol replaces GPT-6-Sol in the shipped judge chains if
  it is no worse on either count, correct syntheses and unsourced-wrong
  claims. A tie goes to GPT-6.1-Sol, the newer model at the same price on the
  same subscription; that is a preference, and it is declared as one. Worse on
  either count keeps GPT-6-Sol.

What it cannot say: the members' answers differ between the two councils,
since each council asks them afresh, so a synthesis is judged against its own
four answers. Six questions show a failure that happens often, not a rare one.

## Result

Not run yet.
