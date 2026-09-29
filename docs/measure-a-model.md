# Which model is enough for a task

A **capability ladder** is a council whose members are one family of models
at three levels: the big model, a smaller one, the smallest. The three answer
the same question, rank each other's answers blind, and a judge from another
family writes the synthesis. Run over a handful of real questions from one
task, it answers a narrow and useful question: **is the cheaper model enough
for this task?**

It does not measure how much more capable one model is than another in
general. Two models can differ a great deal and still both answer every
question of a task correctly; the ladder then says "use the cheaper one", which
is the decision you wanted, and says nothing about the gap.

It is a measuring instrument, not a council to use every day. Three models of
one family share their training and their blind spots, so a ladder buys none
of the independent judgment the reference panel `capitoline` is for, and it
costs seven calls per question. For that reason no ladder ships in
`config/capitoline.yaml`: you declare one in your host's overlay when you want
to measure, and remove it when you are done.

## What it measured the first time

`docs/measurements/2026-09-23-council/` is the worked example: the Gemini
ladder below, six questions registered with their correct answers before any
was sent. The middle rung (Gemini Flash at high reasoning) was correct on six
of six, as the top rung was, and the peers ranked it first or tied first every
time; the bottom rung was wrong on two of six, and the blind ranking put it
last each time it was wrong. So on those questions the expensive rung bought
nothing and the cheap one cost correctness — and the ranking alone, without
the registered answers, would have said the same.

That last point is what makes the instrument useful on a task where you have
no registered answers: the peers' blind ranking is a credible sign of which
rung was wrong. Where all three rungs are right, the ranking reflects
presentation, not correctness, and should not be read as a verdict.

## Declaring a ladder

Add one of the blocks below to the host overlay (`/etc/capitoline/overlay.yaml`,
`docs/deploy.md`) and restart the service. The overlay is merged key by key
over the repository file, so a `council:` entry in it adds a council without
touching the shipped ones. `/v1/models` then lists the ladder by its name.

The rules every ladder follows, and why:

- **One model per seat, no fallback chain.** A rung that steps down to another
  model stops being the rung it was declared to measure, and the deliberation
  would report a ladder it never ran. A rung that cannot be seated is a lost
  seat and is declared as one.
- **`min_members: 3`, every rung or nothing.** Without the top rung there is
  nothing to compare the cheap ones against. A rung known unavailable keeps
  the ladder from being seated at all; a rung lost during the run stops the
  deliberation after its first stage (three calls, not seven) and the
  surviving answer is returned as it was written, declared as no council.
- **The ranking stays on** (no `ranking: false`). The blind peer ranking is
  the measurement.
- **The judge is from another family.** The ladder must not synthesize its own
  measurement, and `judge_allow_member: false` requires that no model of the
  judge's chain sits in a seat. The chain has more than one model for the
  reason every chain has: the first refusal of a window is not in the state
  yet, and with nothing behind the head it would throw away six calls already
  spent. Put a strong model at its head — the judge writes the answer, and on
  the first ladder run a cheap judge merged three answers into a claim none of
  them made.
- **Three slots on the provider.** The three rungs start in the same instant,
  so the provider needs `concurrency` of at least three; the configuration
  refuses to load otherwise. The shipped configuration has ten.
- **The family names the rung.** A council normally seats one family once;
  here the three seats are one lineage on purpose, and `family` carries the
  rung's name so the response says which rung answered what.

### Gemini, three reasoning levels

Antigravity serves each Gemini model at several reasoning levels with the
level fixed in the model id, which makes these the cleanest rungs: one model
at two levels, and a bigger one above them. This is the ladder of the
2026-09-23 measurement.

```yaml
council:
  capitoline-gemini:
    seats:
      - { family: pro-high,   models: [antigravity-gemini-pro-high] }
      - { family: flash-high, models: [antigravity-gemini-flash-high] }
      - { family: flash-low,  models: [antigravity-gemini-flash-low] }
    judge: { family: best-available, models: [codex-gpt-6-astra, claude-fable, claude-opus, codex-gpt-5.6-sol] }
    judge_allow_member: false
    judge_blind: true
    min_members: 3
    stage_timeout_s: 300
```

### Claude, three sizes

Claude's rungs are three model sizes rather than three levels of one model.
Six of the seven calls of each question — three answers, three rankings —
come from the Anthropic subscription's windows.

```yaml
council:
  capitoline-claude:
    seats:
      - { family: opus,   models: [claude-opus] }
      - { family: sonnet, models: [claude-sonnet] }
      - { family: haiku,  models: [claude-haiku] }
    judge: { family: best-available, models: [codex-gpt-6-astra, antigravity-gemini-pro, codex-gpt-5.6-sol] }
    judge_allow_member: false
    judge_blind: true
    min_members: 3
    stage_timeout_s: 300
```

### Codex, one generation

The same shape on the ChatGPT subscription: the three GPT-6 models the Codex
CLI lists, in the order it lists them (`test/fixtures/codex/debug-models.json`).
OpenAI does not publish their relative size, so which one is "the cheap rung"
is exactly what the measurement finds out; the seat order only sets the
labels, and the ranking is blind to it.

```yaml
council:
  capitoline-openai:
    seats:
      - { family: astra, models: [codex-gpt-6-astra] }
      - { family: sol,   models: [codex-gpt-6-sol] }
      - { family: luna,  models: [codex-gpt-6-luna] }
    judge: { family: best-available, models: [claude-opus, antigravity-gemini-pro, antigravity-claude-opus] }
    judge_allow_member: false
    judge_blind: true
    min_members: 3
    stage_timeout_s: 300
```

Any other three models work the same way; the blocks above are checked
against the shipped configuration by `test/config.test.ts`, so they stay
valid as the model tables change.

## Running a measurement

1. **Write the questions first, with their answers.** Five to ten real
   questions from the task, in a `questions.json` shaped like the one in
   `docs/measurements/2026-09-23-council/`: the question verbatim, the correct
   answer, what would disqualify an answer, and the source the answer was
   checked against. Commit it before sending anything, so the scoring cannot
   be adjusted to the answers. A question with no registered answer is still
   usable; it is read by the ranking alone.
2. **Run them.**

   ```sh
   scripts/measure-council.sh https://<your-host> questions.json results/ capitoline-gemini
   ```

   It keeps every full response and appends each run's calls, tokens and wall
   time to `results/run.log`. The Cloudflare Access headers come from
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
3. **Score them.** For each rung and each question: correct, partial or
   wrong, against the registered answer. The 2026-09-23 `score.py` scores its
   three mechanically checkable questions and is a template for yours. For the
   synthesis, the invented-claim classes in that measurement's README
   (derived, unsourced and correct, unsourced and wrong) apply unchanged.
4. **Read the result.** The cheapest rung that is correct on every question
   with a registered answer, and not ranked last on the questions without
   one, is enough for the task. A single wrong answer rules a rung out for a
   task where a wrong answer costs something; for one where it does not, it
   is a sign to re-run with more questions rather than a verdict. On
   questions every rung got right, ignore the order: it is presentation.
5. **Remove the ladder from the overlay** and restart, so it stops appearing
   in `/v1/models`.

Re-run the same questions when a provider ships a new model: the questions and
the registered answers are the part that took work, and they do not change.
