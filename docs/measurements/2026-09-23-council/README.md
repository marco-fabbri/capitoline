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

`capitoline-gemini` is no longer in the shipped configuration (2026-09-23):
a capability ladder is an instrument to add to a host's overlay for as long
as a measurement runs, and `docs/measure-a-model.md` has it, as it was run
here, with a Claude and a Codex ladder beside it. Re-running this
measurement's ladder means adding that block first.

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
(They ran on the night of 26–27 September, one day later than planned, into
`results-panels/`; the window had reset on the Friday and every seat was at
full strength, so nothing in the comparison depends on the day.)

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

## Results: `capitoline` and `capitoline-fast`, night of 26–27 September

Twelve deliberations, question-major, from 00:37 to 00:50 CEST on 27
September (`results-panels/run.log`), through the tunnel with the service
token. Every seat was at full strength: no fallback and no lost seat in any of
the twelve, `claude-fable` in the Anthropic seat throughout, and the judge
`claude-opus` — the head of the chain, seated because it sits in no seat — on
all twelve. Model identities at the start of the run are in
`results-panels/model-identities-*.json`.

One run had to be repeated. The first `capitoline` deliberation on
`ipv4-regex` answered nothing for 125 s and the tunnel's edge closed the
connection with `524`; the deliberation went on regardless and completed its
nine calls for a client that had gone (`docs/deploy.md` §9 says exactly this,
and the measurement script asks without streaming). The repeat, six minutes
later, took 118 s and came back `200`; it is the run scored below, and the
nine orphaned calls are counted in the cost. The two `524`s in `run.log` and
the repeat's line are the record of it.

Scored against `questions.json` as registered: `ipv4-regex`, `subnet-27` and
`tcp-keepalive` by `score.py`, the three Nutanix questions by reading against
the registered truth and its source (reviewed against the documentation on
2026-09-27, below). Every synthesis
was read whole, and every claim no member made was classified by the
amendment above; `score.py`'s candidate list was the starting point and not
the verdict.

| Question | `capitoline` | derived / unsourced-correct / unsourced-wrong | `capitoline-fast` | derived / unsourced-correct / unsourced-wrong |
|---|---|---|---|---|
| `rf2-node-failure` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `subnet-27` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `tcp-keepalive` | correct | 2 / 0 / 0 | correct | 1 / 0 / 0 |
| `ipv4-regex` | correct | 1 / 0 / 0 | correct | 2 / 1 / 0 |
| `ec-backup-6-nodes` | correct | 0 / 1 (unverifiable, see below) / 0 | correct | 1 / 0 / 0 |
| `rf3-min-nodes` | correct | 0 / 0 / 0 | correct | 1 / 0 / 0 |

All 24 answers of the three mechanically scored questions were correct too,
in both councils (`score.py`).

**The claims behind the counts**, so the reading can be checked:

- `capitoline`, `tcp-keepalive`: "the ninth probe is sent 600 s after the
  first" and "`tcp_retries2` … roughly 15 minutes or more" — the first is
  arithmetic on the members' 75 s interval, the second rewords a member's
  "13 to 30 minutes". Derived.
- `capitoline`, `ipv4-regex`: "rejects `1.2.3.4.5`" — follows from the
  pattern the members gave. Derived.
- `capitoline`, `ec-backup-6-nodes`: "encoded data can revert to RF2 if node
  loss leaves too few nodes for the stripe". No member said it, and no
  reachable source says it either: the registered chapter states only that
  the strip size is chosen from the cluster size and that one node more than
  the strip is recommended for rebuilds, and the public erasure-coding pages
  say nothing about what happens to existing strips when nodes are lost. On
  the question's own cluster the case does not even arise: a 4/1 strip needs
  five distinct nodes and six less one is five. Counted as **unsourced**, in
  the invented column, because the strict convention applies when a claim
  cannot be traced; not counted as wrong, because nothing shows it is. It is
  the one claim of the twelve syntheses the documentation could not settle,
  and it changes nothing below: the criterion counts unsourced wrong claims.
- `capitoline-fast`, `tcp-keepalive`: "the ninth probe goes out at 7800 s".
  Derived. The "some sources give 7200 + 10 × 75" remark, which the candidate
  list flagged, is a member's ("10 times 75", in words).
- `capitoline-fast`, `ipv4-regex`: the match/no-match examples are checkable
  against the pattern (derived, counted once), and the Arabic-Indic digit is
  an illustration of two members' Unicode remark (derived). The note that
  under `re.match` a `$` accepts a trailing newline and `\Z` does not is in no
  member's answer: true, and **unsourced-correct** — the one instruction slip
  of the twelve.
- `capitoline-fast`, `ec-backup-6-nodes`: "a spare node remains for rebuilds"
  restates a member's "4/1 stripe, which still fits with one node down", and
  "a 4+2 layout would require RF3" follows from one member's "EC-X does not
  upgrade it to RF3" set against another's 4+2 option. Derived.
- `capitoline-fast`, `rf3-min-nodes`: "the RF + failures formula gives 5 only
  by coincidence" — an inference from the 2N + 1 rule two members gave.
  Derived.

**Cost**, from `run.log` and the result files:

| | Calls per question | Tokens per question | Wall time per question | Total spent |
|---|---|---|---|---|
| `capitoline` | 9 | 88,490–104,894 | 39–118 s | 63 calls (+ 9 orphaned by the `524`) |
| `capitoline-fast` | 5 | 42,821–50,818 | 21–64 s | 30 calls |

**The rankings**, for what the ranked shape adds: the aggregate put
`antigravity-gemini-pro` first on `rf2-node-failure`, `rf3-min-nodes` and
`ipv4-regex`, `claude-fable` first on `subnet-27` and `tcp-keepalive`,
`codex-gpt-6-astra` first on `ec-backup-6-nodes`; `antigravity-gpt-oss` was
last on five of six. With every answer correct, the order is about
presentation, as the ladder's `ipv4-regex` run had already shown, and the
synthesis was correct whichever answer led.

### The Nutanix syntheses against the documentation

Reviewed 2026-09-27 against the registered chapters of the Nutanix Bible
(`questions.json`, `sources`), with two community pages for a figure the
Bible states only in part.

- **`rf2-node-failure`, both syntheses correct.** Every claim is in the
  registered chapter: a Curator scan finds the data the failed node held and
  "all nodes / CVMs / disks will participate in the re-replication", the
  rebuild starts immediately, VM HA restarts the failed node's VMs, the
  rebuild needs the survivors' free capacity ("resilient capacity"), and
  three nodes is the floor for FT1 — "the 3-block requirement is due to
  ensure quorum" — so a two-node remainder cannot take another loss. Neither
  synthesis says both replicas survive, the registered disqualifier.
- **`rf3-min-nodes`, both syntheses correct.** "For RF3, a minimum of 5
  nodes is required since metadata will be RF5" is the chapter's own
  sentence, and its table puts FT2 at five nodes. The five Zookeeper
  instances both syntheses cite are not in the chapter; Nutanix's community
  documentation states it ("cluster keeps 5 copies of Metadata and Zookeeper"
  under redundancy factor 3), as it does that a cluster at redundancy factor
  3 hosts containers at RF2 or RF3, which is the fast synthesis's "RF3 must
  be enabled at the cluster level first". Neither says three or four.
- **`ec-backup-6-nodes`, both syntheses correct.** The default 4/1 strip for
  RF2-like availability, 1.25× against 2×, the post-process encoding by
  Curator of write-cold data, the decode cost on a failure, the unsuitability
  for overwrite-heavy data, and "at least 1 more node than the combined strip
  size to allow for rebuilding" — which is the fast synthesis's "a spare node
  remains" — are all the chapter's. Its strip table gives six nodes 4/1 at
  FT1, so neither synthesis's figures are wrong, and neither calls EC-X
  inline or six nodes too few, the registered disqualifiers. The one claim
  the chapter does not cover is the "revert to RF2" remark above.

### The reading, by the criterion registered above

- Correct syntheses: `capitoline` 6 of 6, `capitoline-fast` 6 of 6. Equal.
- Unsourced wrong claims: 0 and 0. Equal.

**The four ranking calls bought nothing on these six questions.** By the
rule written before the runs, `capitoline-fast` is the better everyday
council: the same six correct syntheses at 30 calls instead of 63, at half
the tokens and about half the wall time, and it was the one shape that never
touched the tunnel's 100 s edge. The differences outside the criterion — one
unsourced-correct remark in a fast synthesis, one unsourced and unverifiable
remark in a ranked one — are one each, noted and not acted on, as the
criterion says.

What this does not say: that the ranking is worthless. Six questions is a
small sample, all six had four correct members, and the failure the ranking
guards against — a wrong answer leading the synthesis — never had the chance
to happen. On the ladder, where a member *was* wrong, the ranking put it last
every time. The ranked shape stays available; what changes is which shape a
client reaches without thinking, and that is recorded in `docs/backlog.md`.

## Addendum: the judge seated in the council, 27 September

Not registered with the rest: decided after the panels' result, when the
owner asked whether the seat-apart judge had ever been measured against
karpathy/llm-council's chairman, who is a member and synthesizes too. It had
not. The spec's reason for the seat-apart judge (§12.3) was a risk stated
without a measurement — a synthesizer weighing its own answer — and the
measurement was cheap once the twelve panel syntheses existed to compare
against. What was written down before the runs, in the conversation: the
same six questions, the same seats, `judge_allow_member: true` with
`claude-fable` — the seated Anthropic member — at the head of the judge
chain, both shapes; scored by the amended rule; and one extra reading, in the
ranked shape, of whether the chairman's synthesis follows the peers' aggregate
or its own answer.

The two councils were declared in the host's overlay for the run and removed
after it (`capitoline-chair`, `capitoline-chair-fast`, in
`results-chairman/`). Twelve deliberations from 03:04 to 03:16 CEST, every
seat at full strength, no fallback, no lost seat, `claude-fable` judging all
twelve.

**One thing the run corrected before anything was scored.** The chairman
saves no call: the synthesis is a call whether the model that writes it sat
in the council or not, so the ranked shape still cost nine and the fast one
five. What the chairman changes is *which* model writes the final answer —
the best seated one instead of the best unseated one — and that one family's
window is not spent twice. The claim that it saves one call in nine, made in
the conversation and in the spec, was wrong, and the spec is corrected with
this addendum.

| Question | `capitoline-chair` (ranked) | derived / unsourced-correct / unsourced-wrong | `capitoline-chair-fast` | derived / unsourced-correct / unsourced-wrong |
|---|---|---|---|---|
| `rf2-node-failure` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `subnet-27` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `tcp-keepalive` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `ipv4-regex` | correct | 0 / 0 / 0 | correct | 0 / 1 / 0 |
| `ec-backup-6-nodes` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |
| `rf3-min-nodes` | correct | 0 / 0 / 0 | correct | 0 / 0 / 0 |

Every claim of the twelve syntheses was traced to a member's answer except
one: the fast synthesis on `ipv4-regex` says `fullmatch` "does not have the
`$`-before-final-newline quirk", which no member said; true, and
unsourced-correct — the same kind of remark, on the same question, as the
one slip of the seat-apart fast judge. The Nutanix syntheses were checked
against the same sources as above: the chairman's `rf2-node-failure` takes
its "metadata is always kept at three copies" and "cannot be rebuilt on two
nodes, so the cluster stays degraded and critical" from the Gemini member,
and both are the chapter's (metadata RF3 under FT1, three nodes the floor).

**Does the chairman favour its own answer?** No, on these six. In the ranked
shape its own ballot put its answer last on `rf2-node-failure`, third on
`ipv4-regex` and `tcp-keepalive`, second on `ec-backup-6-nodes` and
`subnet-27`, first only on `rf3-min-nodes`, where the other three members
put it first too (aggregate 1.25). And the syntheses follow the aggregate,
not the chair: on `ipv4-regex` it is the top-ranked pattern of the OpenAI
and Google members that the synthesis carries, not the chairman's own
anchored form, and on `rf2-node-failure` the synthesis is built on the
Google member's metadata points, ranked first, with the chairman's own
answer, ranked last, contributing nothing it did not share with the others.

**Cost.** The same calls; tokens within a few percent of the seat-apart
runs (ranked 90,824–107,371 against 88,490–104,894; fast 44,371–52,800
against 42,821–50,818); wall time the same range (18–123 s); and no `524`
this time, the longest run at 123 s — which says the edge's limit is not a
simple 100 s of silence, and does not make the streaming item less needed.

### What it says

On these six questions the chairman is as good as the seat-apart judge:
six correct syntheses of six in both shapes, no unsourced wrong claim, one
unsourced-correct remark against one, and no sign of self-preference where
it could have shown. The seat-apart rule therefore rests on no measured
harm; what it demonstrably costs is that the best model never writes the
final answer, and, with one seat per family and three families, that the
judge is always a second model of a family already seated.

Six questions with four correct members each is the same small sample as
above, and it cannot show what a chairman does when its own answer is the
wrong one — the case the seat-apart rule was written for. The Gemini ladder
is where a member was wrong, and there the judge was from outside by
construction. So the honest reading is: no evidence for the rule, and no
test of its worst case yet. The decision on the shipped default is the
owner's and is recorded in `docs/backlog.md`.
