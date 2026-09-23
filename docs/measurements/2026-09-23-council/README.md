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

## Order and timing

`scripts/measure-council.sh` runs question-major, so councils compared on one
question are seated minutes apart and meet the same quota state.

`capitoline-gemini` runs first, on 2026-09-23: its seats are all Antigravity
and its judge chain opens on Codex, so it spends nothing of the Anthropic
weekly window. `capitoline` and `capitoline-fast` run after that window
resets, on Friday 25 September after 21:00, for two reasons: not to spend the
owner's working allowance, and because until then `claude-fable` is
exhausted and the reference panel would be measured in its degraded form.
