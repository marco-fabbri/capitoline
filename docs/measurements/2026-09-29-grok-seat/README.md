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

## Run conditions

Run on 2026-09-29 from 05:29 to 06:31 UTC on the host, through the gateway
at `127.0.0.1` with a temporary key (`grok-measure`, revoked afterwards);
`results/run.log` is the script's log and `results/<question>.json` holds
every answer, ranking and synthesis. Grok Build 1.0.41, `grok-4.7`.

**The panel was not at full strength.** `claude-fable` had reached its limit
the evening before ("You've reached your Fable limit"), so the anthropic
seat was `claude-opus` on all six questions and the judge — `claude-opus`
being seated — was the next in the chain, `antigravity-claude-opus` (Claude
Opus 4.6 through Antigravity). The comparison is paired, S4 and S5 have the
same four members and the same judge, so it holds for this panel; a result
at the margin would have been repeated with Fable, and none was.

A first attempt at 05:24 produced no S4: the judge chain reached
`antigravity-claude-opus`, `agy` answered "model claude-opus-4-6-thinking is
not recognized as a known model", and the deliberation ended after eight
calls. The same model answered at once when called by hand and through the
gateway minutes later, and the message appears nowhere else in thirty days
of logs: a transient failure of the CLI's model catalogue. It cost eight
calls because a judge that crashes does not step down its chain (see
`docs/backlog.md`).

## Results

| Question | S4 | Grok's answer | Grok's place, five-member ranking | Only Grok said it, and S5 carries it | Harm |
|---|---|---|---|---|---|
| `tcp-retries2` | correct | correct | 2nd (1.75; opus 1.25) | nothing new that holds | **yes**: a fabricated kernel comment |
| `k8s-exclusive-cpus` | correct | correct | 3rd (2.75) | one minor caveat | no |
| `bgp-origin-med` | correct | correct | 2nd (2.0; opus 1.6) | nothing | no |
| `pve-quorum-4-nodes` | correct | **lost**: no answer in 300 s | — | — (S5 would be S4) | no |
| `ceph-or-zfs-3-nodes` | open | open | **1st** (1.5; opus 1.75) | **several points** | no |
| `evpn-4-racks` | open | open | **1st** (1.25; opus 2.25) | **several points** | **yes**: a vSphere claim wrong as used |

Every seated answer on the checkable questions was correct but two:
`antigravity-gpt-oss` gave 804 s on `tcp-retries2` (wrong) and
`antigravity-gemini-pro` reached 924.6 s through an invented "off-by-one
quirk" (partial). S4 was correct on all four checkable questions, so the
fifth seat had no wrong verdict to correct.

**The two harms, so the reading can be checked.**

- `tcp-retries2`. Grok: "`TCP_RETR2` in `include/net/tcp.h`; the comment
  there is 'this should take at least 924.6 seconds'". The comment in the
  kernel source reads "This should take at least 90 minutes to time out.
  RFC1122 says that the limit is 100 sec. 15 is ~13-30min depending on
  RTO." No seated member made the claim. S5 carries it as a fact: "This is
  explicitly documented in the kernel source (`include/net/tcp.h`): the
  comment next to `TCP_RETR2` says 'this should take at least 924.6
  seconds.'" S4 has no such sentence. Unambiguous.
- `evpn-4-racks`. Grok: "Live migration no longer requires a common VLAN in
  current vSphere", offered as the reason most workloads can live on a
  subnet per rack. vSphere lets the vMotion *traffic* be routed ("To have
  the vMotion traffic routed across IP subnets, enable the vMotion TCP/IP
  stack on the host", vSphere 7 networking requirements); the virtual
  machine keeps its address and its port group ("Ensure that virtual
  machines have access to the same subnets on source and destination
  hosts", VMware's vMotion networking best practices as republished by
  Dell, KB 000140474, read in a browser). Read as a statement about the vMotion network it is
  true; read as it is used, it is wrong. No seated member made it; S5
  carries it word for word. Counted as harm, with the ambiguity stated —
  the decision does not turn on it.

**What Grok added that holds.** On the two open questions its answer was
the one the panel preferred, and S5 was built on it, as strategy 2 tells the
judge to do. On `ceph-or-zfs-3-nodes` S5 gained, from Grok alone and
correct: replication that cannot keep up with sustained writes above the
link's ~100 MB/s; synchronous DRBD (LINSTOR) as the compromise for RPO = 0
without a network upgrade; the RAM BlueStore needs per OSD; replication
inside the application for the few guests that cannot lose a minute. It
lost one correct point S4 had, from a
seated member: with three hosts, a lost host leaves no third node to restore
the missing replica on. On `evpn-4-racks` S5 gained the separation of
"route between racks" from leaf-spine and from the overlay, the MAC-table
and VLAN-ID arithmetic, and the caution about RoCEv2 over VXLAN. On `k8s-exclusive-cpus` the only addition
was a caveat outside the question (a default memory limit other than 1Gi
would make the pod Burstable): correct, not counted as substantive.

**Grok as a member, in numbers.**

- Answers took 70 to 300 s (median about 200 s); one of six did not come
  within the 300 s a stage allows and the seat would have been lost. The
  slowest *ranking* by a seated member took 25 to 85 s; Grok's took 135 to
  300 s. A stage waits for its slowest member, so a council with Grok seated
  runs several minutes longer — up to two full 300 s stages.
- Of five rankings, two were usable. Two ran into the 300 s limit and one
  came back as the schema's own wrapper (`{"type":"array","items":[…]}`),
  which `parseRanking` rejects; read leniently it would not have changed
  that question's order.
- Three of five answers open with the agent's intention to look something
  up — "I'll confirm the default sysctls and the kernel's timeout formula"
  — the trace of a tool call the `--deny` rules refused, left in the text a
  client would read. Each answer used one to three turns and 20,000 to
  88,000 tokens.

## The decision, as registered

- **E1** (a better answer) holds on three questions: `tcp-retries2`, where
  Grok was correct and `antigravity-gpt-oss` was not, and the two open
  questions, where the panel ranked Grok first. The first of the three says
  less than the rule meant: `antigravity-gpt-oss` is the member most often
  wrong, so almost any correct fifth answer meets that half of E1.
- **E2** (something new that reaches the answer) holds on two: the two open
  questions.
- **Harm** occurred on two questions, one of them unambiguous.

**Grok does not earn the fifth seat.** The rule set before the runs says no
on any harm, and the harm is of the kind this council exists to avoid: a
precise, confident, invented detail that no other member made. It is the
same failure strategy 2 was written against, but arriving from a member
rather than the judge, and the strategy cannot see it there — the ranking
put the answer that carried it first or second, and the judge, told to
build on the top-ranked response and assert nothing the responses do not
support, found it supported by one of them.

What the measurement also shows, and is recorded rather than acted on: on
open design questions Grok wrote the answer the panel liked best, and the
syntheses built on it were more complete than the four-member ones. Six
questions do not say whether that outweighs the invented details; they say
that the invented details are there, twice in five answers, and that the
council passes them through. Add to that a slower seat by minutes, three
rankings in five lost, and a subscription of its own.

Where this leaves Grok: no seat in `capitoline` or `capitoline-fast`. The CLI
stays installed and signed in on the host until the trial ends; the
provider is not built.
