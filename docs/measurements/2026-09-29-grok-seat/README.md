# Does Grok earn a fifth seat? Measurement, 2026-09-29

The Grok Build spike (`docs/spike-2026-09.md` §12) found that the CLI can be
a provider. This measurement asks whether it is worth one in the council:
does a fifth member, from a fifth family, change what `capitoline` answers,
for the better, often enough to pay for two more calls per deliberation and
a subscription of its own?

## Why new questions

The questions of `2026-09-23-council/` cannot answer this: all 24 member
answers of the reference panel were correct on them, so a fifth member could
only agree or be wrong. The six questions in `questions.json` were chosen
where a member is more likely to slip — four with one checkable answer, each
built around a step models commonly get wrong (a documented kernel figure, an
admission-time default, the order of two best-path criteria, the effect of a
watchdog), and two open design questions, where a council's value is the
range of considerations rather than a single fact. The correct answers were
checked against the sources named beside them before registering. Every
question is generic: xAI's consumer terms take an irrevocable licence on
inputs, so nothing of the owner's goes to it.

## Registered before running

`questions.json` and this protocol were committed before any question was
sent.

## How it is run

For each question, one after the other:

1. **The panel as it is.** `capitoline`, the full council, nine calls,
   through the gateway on the host. Its synthesis is **S4**.
2. **Grok's answer.** `grok -p` as the `runner` user in an empty temporary
   directory, with the stage-1 prompt of `src/council/prompts.ts`
   (`answerPrompt`), the default model (`grok-4.7`) and effort, and the tool
   lockdown the spike found necessary (`--deny` for every tool family, no
   subagents, no web search, `--max-turns 4`).
3. **The panel with Grok seated**, replayed by a throwaway script with the
   engine's own prompts and aggregation (`rankingPrompt`, `parseRanking`,
   `aggregate`, `synthesisPrompt` from the build): the four answers of step 1
   and Grok's under five shuffled labels; each of the five ranks all five,
   blind, the four seated models called by name through the gateway exactly
   as the council calls them (one user message, no effort); then the judge
   of step 1 writes the synthesis, blind. That synthesis is **S5**.

Reusing the four stage-1 answers keeps the comparison to one variable: S4
and S5 differ only by Grok's presence in stages 2 and 3. Seven calls more
per question, 96 in all.

## How it is read

For every question:

- **Grok's answer**: correct, partial or wrong (checkable questions, against
  `questions.json`); its average rank among the five, and whether it was
  ranked first, alone or tied.
- **What only Grok said**: every substantive point in Grok's answer that none
  of the four seated answers contains, listed so the reading can be checked,
  each marked correct, wrong or unverifiable.
- **Whether it reached the answer**: which of those points S5 carries, and
  whether S5 differs from S4 in its verdict (correct, partial, wrong) or its
  recommendation.
- **Harm**: a wrong claim in S5 that came from Grok, or S5 less correct than
  S4.
- **Cost**: Grok's wall time, tokens, and any run lost to the tool lockdown
  (a denied tool attempt that ends in "max turns reached").

## The decision, written before the runs

Grok **earns the fifth seat** if there is no harm on any question and at
least one of these holds on two or more of the six questions:

- **E1, a better answer**: Grok is correct on a checkable question where a
  seated member is not, or the five-member blind ranking puts Grok's answer
  first, alone or tied.
- **E2, something new that reaches the answer**: S5 carries a substantive,
  correct point that appears only in Grok's answer.

It **does not** if neither holds on two questions, or if there is harm on
any. Six questions is a small sample: a result that turns on one question
is recorded and not acted on, as in the previous measurement. A seat earned
at the margin is weighed against its price — eleven calls per deliberation
instead of nine, one more subscription, and the lockdown's cost in lost runs.

Where Grok's answers are kept in `results/`, they were written with Grok, as
xAI's brand guidelines ask of Grok-generated material.
