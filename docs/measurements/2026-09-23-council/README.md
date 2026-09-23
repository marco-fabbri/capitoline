# Council measurement, 2026-09-23

Six questions of different shapes through the councils, to answer three
questions the backlog holds open:

- **Does strategy 2's judge hold across question shapes?** It has three runs,
  all on one question, which says the failure it was written against did not
  recur and nothing about whether it helps in general.
- **Do the four ranking calls of `capitoline` buy anything** over
  `capitoline-fast`, which skips them?
- **Does the Gemini ladder measure something?** The other two ladders
  (`capitoline-claude`, `capitoline-openai`) wait on this: if the rungs are
  ranked consistently and the ranking tracks correctness, the instrument
  works; if not, one ladder is enough.

## Registered before running

`questions.json` holds every question verbatim, the correct answer, what
disqualifies an answer, and the source the correct answer was checked
against. It was committed before any question was sent, so the scoring below
cannot have been adjusted to the answers. The regex question's test lists
were checked satisfiable against a reference expression first, so a failure
there is the council's and not the test's.

## How each run is scored

For every run, and for every member's answer as well as the synthesis:

- **correct** — states the correct answer and nothing disqualifying;
- **partial** — right on the key point, wrong or missing on a secondary one;
- **wrong** — disqualifying, or wrong on the key point.

For the synthesis alone, **invented**: a factual claim present in none of the
members' answers. That is the failure strategy 2 exists to prevent.

`ipv4-regex` is scored mechanically with `re.fullmatch` against the two
lists. `subnet-27` and `tcp-keepalive` have single figures. The three Nutanix
questions are scored against the Nutanix Bible and marked for review by someone who works with the product.

### Amendment of 2026-09-23: what counts as invented

Written after the `capitoline-gemini` runs and before the `capitoline` and
`capitoline-fast` runs, and committed before them. The ladder's results below
were scored under the original rule and stay next to it; this amendment
applies to every run from Friday 25 September on.

The original rule counted as invented any claim no member made. On the ladder
that put a correct piece of arithmetic in the same column as the failure
strategy 2 was written against, which was a new fact and a false one ("both
replicas survive"). The column is the measurement's headline number, so it
has to count that failure and not something else.

Every factual claim in a synthesis that no member's answer contains goes into
one of three classes:

- **Derived** — it follows from what the members said, by arithmetic or
  strict logic, and the derivation checks out. Not invented. A derivation that
  does not check out counts as an error, like any wrong claim.
- **Unsourced, correct** — a fact no member gave, true against the registered
  answer or its source. Invented, because the strategy-2 prompt tells the
  judge to assert nothing the answers do not support; not an error. This
  column measures whether the judge follows its instruction.
- **Unsourced, wrong** — a fact no member gave, and false. Invented and an
  error: the failure strategy 2 exists to prevent, and the number this
  measurement leads with.

Two conventions, so every synthesis is read the same way:

- When it is unclear whether a claim follows from the members, it is
  **unsourced**. The default is the strict reading.
- A synthesis that sides with one member against another is choosing between
  sources, not inventing — as the ladder's judge did when it rejected
  flash-low's claim that RF2 cannot rebuild on two nodes.

`score.py` lists, under each synthesis, every number and every code span that
appears in no member's answer. That is a list of candidates to classify by
the rule above, not a verdict: prose claims can only be found by reading, and
a number spelled as a word is not seen.

## How Friday's result is read

Written before the runs, so the comparison cannot be fitted to them. For each
question and each council: the synthesis correct, partial or wrong; its claims
in the three classes above; calls, tokens and wall time
(`scripts/measure-council.sh` keeps the last in `run.log` next to the
results).

- **The four ranking calls buy something** if, across the six questions,
  `capitoline`'s syntheses are correct more often than `capitoline-fast`'s,
  or contain fewer unsourced wrong claims. The ranking then stays in the
  default council.
- **They do not** if the two are equal on both counts. `capitoline-fast` is
  then the better everyday council, at about half the calls, and
  `docs/backlog.md` says so.
- Six questions is a small sample. A difference of one question either way is
  recorded and not acted on.

## Order and timing

`scripts/measure-council.sh` runs question-major, so councils compared on one
question are seated minutes apart and meet the same quota state.

`capitoline-gemini` runs first, on 2026-09-23: its seats are all Antigravity
and its judge chain opens on Codex, so it spends nothing of the Anthropic
weekly window. `capitoline` and `capitoline-fast` run after that window
resets, on Friday 25 September after 21:00, for two reasons: not to spend the
owner's working allowance, and because until then `claude-fable` is
exhausted and the reference panel would be measured in its degraded form.

## Results: `capitoline-gemini`, 2026-09-23

Scored against `questions.json` as registered. `ipv4-regex`, `subnet-27` and
`tcp-keepalive` by `score.py`; the three Nutanix questions by reading, and
marked for the owner's review.

| Question | pro-high | flash-high | flash-low | Ranked first | Synthesis |
|---|---|---|---|---|---|
| `rf2-node-failure` | correct | correct | **wrong** | pro-high and flash-high, tied | correct |
| `subnet-27` | correct | correct | correct | flash-high and flash-low, tied | correct |
| `tcp-keepalive` | lost | lost | **wrong** | — | none, one answer returned |
| `ipv4-regex` | lost | lost | correct | — | none, one answer returned |
| `ec-backup-6-nodes` | correct | correct | **wrong** | flash-high | correct |
| `rf3-min-nodes` | correct | correct | correct | flash-high | correct |

Judge: `codex-gpt-6-astra` on every run that reached one. Calls and tokens per
run are in the result files.

**The ranking tracks correctness.** In both complete runs where one rung was
wrong, that rung was ranked last: on `rf2-node-failure` flash-low claimed the
cluster cannot rebuild RF2 on two nodes, and on `ec-backup-6-nodes` it offered
a 4:2 strip and a 1.33x footprint as options for an RF2 container. The peers
put it third both times, blind.

**How far down you can go: to flash-high, not to flash-low.** flash-high was
ranked first or tied for first on all four complete runs, and pro-high never
beat it. flash-low was wrong on three of the six questions. On these
questions the expensive rung buys nothing over the middle one, and the cheap
rung costs correctness.

**The judge held.** Correct on all four syntheses, and on `rf2-node-failure`
it met a member's wrong claim and rejected it in so many words — "it does not
need a third running node simply to place those two copies on separate nodes"
— which is strategy 2 doing what it was written for.

**On invention.** One figure in the syntheses appears in no member's answer:
the 37.5% of raw space EC-X saves on `ec-backup-6-nodes`. It is arithmetic on
the 1.25x two members gave, (2 − 1.25) / 2, it is correct, and it corrects
flash-low's "30–35%". By the rule as registered it counts as invented, and it
is recorded here as such rather than excused; the rule should separate a
derivation from a claim with no source, and will for the next measurement.

Read under the amendment above, it is **derived**, and the ladder's
syntheses have no invented claim. Both readings stand: the first is the one
registered for these runs. `score.py` run over `results/` and
`results-after-fix/` lists this figure and nothing else.

**Two runs of six lost two rungs, and it is a defect, not a result.** On
`tcp-keepalive` and `ipv4-regex` the two high-reasoning rungs did not answer:
they tried to *check* — `run_command` with `sysctl` for the keepalive
defaults — the runner's `strict` tool permission denied the call, and the CLI
ended the run with an empty response. Confirmed on the host that nothing ran:
a harmless marker file the model was asked to create does not exist, and the
CLI's log reads `Print mode: soft-denying tool confirmation "RunCommand"`. The
sandbox holds. What it costs is that a question a model thinks it can verify
on a machine loses its best rungs, so the instrument cannot yet be trusted on
that shape of question. See `docs/backlog.md`.

**What this says about the other two ladders.** The backlog makes them wait on
whether this instrument measures something. On the four complete runs it
does: the ranking is consistent and it follows correctness. That is four
runs, and two question shapes are unmeasured until the tool defect is fixed.

## After the fix, same day

Two changes went in (`docs/backlog.md`, Shipped): a run that ends with no text
is now `bad_output` on every path, and Antigravity's text runs carry a
standing instruction that they have no tools and should say what they are
unsure of instead of checking it. The two questions that had lost their best
rungs were then run again, into `results-after-fix/`; the first results stay
in `results/` so the before and the after can both be read.

| Question | pro-high | flash-high | flash-low | Ranked first | Synthesis |
|---|---|---|---|---|---|
| `tcp-keepalive` | correct | correct | correct | flash-high and flash-low, tied | correct |
| `ipv4-regex` | correct | correct | correct | flash-high | correct |

No rung was lost. Both runs went the full seven calls.

**A correction to the instrument, stated because it came after the results.**
The first scoring of `ipv4-regex` in `results-after-fix/` marked flash-high,
pro-high and the synthesis wrong, each rejecting every valid address. The
answers were right; `score.py` was not. They had written the expression as a
Python raw string, `r"(?:...)"`, which is the form the question asked for, and
the scorer tested the `r"` and the quotes as part of the pattern. It now strips
a string literal's wrapper (`unquote`). The criterion in `questions.json` did
not change, and re-scoring `results/` with the corrected scorer changes
nothing there, since the one answer it held was written bare.

**The six questions together:**

| | Correct | First or tied first |
|---|---|---|
| pro-high | 6 of 6 | 1 of 6, tied |
| flash-high | 6 of 6 | 6 of 6 |
| flash-low | 4 of 6 | 3 of 6, each time tied |
| synthesis | 6 of 6 | — |

flash-low's `tcp-keepalive` is counted from the second run, where it was
right; it was wrong in the first run and in a direct call made while chasing
the defect, so on that question it is inconsistent rather than reliable.

**What it says.** On these six shapes of question the middle rung is as
correct as the top one and the peers prefer it; the cheap rung costs
correctness on a third of them, and the blind ranking put it last every time
it was wrong. Where all three rungs are right, as on `ipv4-regex`, the order
reflects something other than correctness — explanation, presentation — and
should not be read as a verdict. The instrument measures what it was built to
measure, which is the condition the backlog set for the other two ladders.
