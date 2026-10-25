# Gemini 4 Argon on the 2026-09-23 ladder, 2026-10-25

Gemini 4 Argon reached the Antigravity listing of the host measured on
2026-10-25. The backlog held one question for that day: does it hold at the
head of the councils' Google seat, in front of Gemini 3.8 Flash at the high
level? Holding means three things: correct where the registered answers say
what correct is, never ranked last by blind peers on a question it got right,
and running inside the gateway without losing a seat, reaching for a tool or
running into the stage timeout.

## What was run

The Gemini ladder of 2026-09-23 with Argon in Pro's place: Argon high, Flash
high, Flash low (`overlay-councils.yaml`), the six questions registered on
2026-09-23, unchanged (`../2026-09-23-council/questions.json`). Antigravity
CLI 1.4.7. The judge chain is Claude's alone, Opus at its head, because the
Codex subscription was out of its weekly limit that day; the judge does not
take part in the verdicts below, which are about the members.

`results/` holds every full response and `run.log` the wall time of each
run. `score.py` of the 2026-09-23 measurement scores the three mechanically
checkable questions:

```sh
python3 docs/measurements/2026-09-23-council/score.py docs/measurements/2026-10-25-argon/results
```

## Results

Verdict and average blind rank, 1 being best, of each member's answer.
Scored as in `../2026-09-23-council/README.md`: correct, partial (right on
the key point, wrong or missing on a secondary one) or wrong.

| Question | Argon high | Flash high | Flash low |
|---|---|---|---|
| tcp-keepalive | correct, 1 | correct, 1 | wrong, 2.667 |
| rf2-node-failure | correct, 1 | correct, 1 | wrong, 3 |
| subnet-27 | correct, 1 | correct, 1 | correct, 1.333 |
| ipv4-regex | correct, 1.333 | correct, 1.333 | correct, 2.667 |
| ec-backup-6-nodes | correct, 1 | partial, 2 | wrong, 3 |
| rf3-min-nodes | correct, 1.667 | correct, 1.333 | correct, 3 |

Two of `score.py`'s mechanical verdicts are overruled, both by reading:

- **Flash high's regular expression is correct.** The script read `import
  re`, the first line of the answer's Python block, as the expression. The
  expression on the line after it passes every accept and reject case of
  `questions.json`, checked by hand. The same kind of misreading as the one
  noted in the 2026-09-23 README, and the criterion is unchanged.
- **Flash low's keepalive answer is wrong.** The script found 7875 s in the
  answer's working; the answer's first line states 7290 s (2 h 1 min 30 s),
  which its own arithmetic further down contradicts. The figure a reader
  takes is the wrong one. The peers ranked it last.

The prose questions were read against each question's registered truth and
disqualifying line. Flash high's erasure coding answer has the strip, the
overhead and the post-process encoding right and leaves out the cost of
degraded reads and rebuilds: partial. Flash low's states the saving over RF2
as 25 to 33 percent of raw capacity, which disqualifies it, and its RF2
answer says the cluster cannot rebuild the lost copies.

## Reading

- **Argon was correct on all six**, ranked first or tied first on five and
  second on the sixth, never last. **Flash high was correct on five and
  partial on one**, about as correct as Pro and Flash high were on
  2026-09-23. **Flash low was wrong on three and ranked last on each of the
  three**, as it was on 2026-09-23: the instrument still tells a wrong rung
  apart.
- On these questions Argon is not more correct than Flash high. As a
  capability ladder the measurement says what it said in September: for a
  task like these, the high Flash rung is enough. The seat is a different
  question. It carries a family's strongest model, as the Anthropic and
  OpenAI seats do, and what had to be shown is that Argon holds there.
- **It runs as well as Flash high in the gateway, and quicker.** Every one of
  the 36 member calls answered, no seat was lost, no run took a tool step and
  every ranking parsed:

  | Model | Calls | Mean s | Max s | Mean output tokens |
  |---|---|---|---|---|
  | Argon high | 12 | 34.9 | 56.1 | 2158 |
  | Flash high | 12 | 42.5 | 147.3 | 5118 |
  | Flash low | 12 | 7.8 | 11.4 | 390 |
  | Opus, judge | 6 | 12.1 | 19.5 | 1016 |

- **Its quota is not Flash's.** Antigravity's quota report lists Argon as a
  group of its own, with a weekly limit, wherever it is not part of the larger
  Gemini bucket (the CLI's own description of the group). The six questions
  drew on that group and left the Gemini group's almost untouched. So Flash
  high behind Argon in the seat's chain is a real fallback: when Argon's
  week is spent, Flash still answers.

## What changed

The councils' Google seat is `[antigravity-gemini-argon-high,
antigravity-gemini-flash-high]` in `capitoline` and `capitoline-fast`
(`config/capitoline.yaml`, council section). The ladder was removed from the
host overlay after the run.
