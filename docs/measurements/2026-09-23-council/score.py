"""Mechanical scoring for the three questions that have one checkable answer.

    python3 docs/measurements/2026-09-23-council/score.py [results-dir]

Scores every member's answer and the synthesis of every run in the results
directory. The three Nutanix questions are printed for reading rather than
scored here: their correct answers are prose, and the owner is the better
judge of them (README.md). Nothing in this file decides a verdict that the
registered questions.json does not already state.

Under every synthesis it also lists the numbers and code spans no member
wrote: candidates for the invented classes of README.md, to be classified by
reading.
"""
import json, pathlib, re, sys

HERE = pathlib.Path(__file__).parent
QUESTIONS = {q["id"]: q for q in json.loads((HERE / "questions.json").read_text())["questions"]}
RESULTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results"


def unquote(expr):
    """The expression inside a Python string literal, when an answer wrote it as one.

    Added after the first scoring run, and said so in README.md: an answer that
    gives `r"(?:...)"` has written the expression the way the question asked
    for it -- usable with re.fullmatch -- and the first version of this file
    tested the `r"` and the quotes as part of the pattern, which rejects every
    address and scored three correct answers wrong. The criterion registered in
    questions.json is unchanged; this only stops the instrument misreading it.
    """
    m = re.fullmatch(r"[rR]?(['\"])(.*)\1", expr.strip(), re.S)
    return m.group(2) if m else expr


def regex_candidates(text):
    """The expression an answer gives: its first fenced code block, else its first inline code span."""
    blocks = re.findall(r"```[a-zA-Z]*\n(.*?)```", text, re.S)
    for b in blocks:
        line = next((l.strip() for l in b.splitlines() if l.strip()), "")
        # A block may hold a Python snippet rather than the bare expression.
        m = re.search(r"r?['\"](\^?.*?\$?)['\"]", line) if ("re." in line or "=" in line) else None
        return [m.group(1) if m else unquote(line)]
    return [unquote(x) for x in re.findall(r"`([^`]+)`", text)[:1]]


def score_regex(text):
    q = QUESTIONS["ipv4-regex"]
    for expr in regex_candidates(text):
        try:
            rx = re.compile(expr)
        except re.error as e:
            return "wrong", f"does not compile: {e}"
        bad_accept = [s for s in q["accept"] if not rx.fullmatch(s)]
        bad_reject = [s for s in q["reject"] if rx.fullmatch(s)]
        if not bad_accept and not bad_reject:
            return "correct", expr
        return "wrong", f"{expr}  rejects {bad_accept}  accepts {bad_reject}"
    return "wrong", "no expression found"


def score_subnet(text):
    has_bcast = "10.23.96.95" in text
    has_30 = re.search(r"\b30\b", text) is not None
    says_32 = re.search(r"\b32\s+(usable|host)", text, re.I) is not None
    if has_bcast and has_30 and not says_32:
        return "correct", ""
    return "wrong", f"broadcast={'ok' if has_bcast else 'missing'} thirty={'ok' if has_30 else 'missing'}{' says 32 usable' if says_32 else ''}"


def score_keepalive(text):
    t = text.replace(",", "").replace(" ", " ")
    figure = re.search(r"\b7875\b|2\s*h(ours?)?\s*11\s*m|2:11:15|2h\s*11m", t, re.I) is not None
    params = all(re.search(p, t) for p in (r"\b7200\b", r"\b75\b", r"\b9\b"))
    if figure and params:
        return "correct", ""
    if figure:
        return "partial", "figure right, parameters incomplete"
    return "wrong", "the 7875 s figure is not there"


SCORERS = {"ipv4-regex": score_regex, "subnet-27": score_subnet, "tcp-keepalive": score_keepalive}


# Figures a synthesis states that no member's answer contains: candidates for
# the invented classes in README.md (amendment of 2026-09-23), not a verdict.
# Prose claims can only be found by reading; figures and code can be counted,
# and this would have flagged the 37.5% on the ladder at once. A number counts
# as present if any member wrote the same number, anywhere; a code span if any
# member's text contains it verbatim. Numbers spelled as words are not seen.
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def numbers(text):
    # Thousands separators dropped, so "7,875" and "7875" are one figure.
    return {n.replace(",", "") for n in NUMBER.findall(text)}


def candidates(synthesis, answers):
    members = " ".join(answers)
    new_numbers = sorted(numbers(synthesis) - numbers(members), key=lambda n: (len(n), n))
    new_code = [c for c in dict.fromkeys(re.findall(r"`([^`\n]+)`", synthesis)) if c not in members]
    return new_numbers + [f"`{c}`" for c in new_code]


for f in sorted(RESULTS.glob("*__*.json")):
    council, qid = f.stem.split("__", 1)
    try:
        d = json.loads(f.read_text())
    except json.JSONDecodeError:
        # No body at all: a 524 from the tunnel's edge leaves an empty file
        # (run.log has the status). Recorded, not skipped silently.
        print(f"\n{council}  {qid}: no response body")
        continue
    if "capitoline" not in d or "council" not in d.get("capitoline", {}):
        print(f"\n{council}  {qid}: no deliberation ({d.get('error', {}).get('message', 'unknown')})")
        continue
    c = d["capitoline"]["council"]
    rank = {a["label"]: a["averageRank"] for a in c.get("aggregate", [])}
    print(f"\n{council}  {qid}  calls={c['calls']}  tokens={d['usage']['total_tokens']}  judge={c['judge']['model']}  lost={[l['model'] for l in c.get('lost', [])]}")
    scorer = SCORERS.get(qid)
    for m in sorted(c["members"], key=lambda m: rank.get(m["label"], 99)):
        verdict = scorer(m["answer"]) if scorer else ("read", "")
        print(f"  member  rank {rank.get(m['label'], '-'):<5}  {m['model']:<24} {verdict[0]:<8} {verdict[1]}")
    verdict = scorer(d["choices"][0]["message"]["content"]) if scorer else ("read", "")
    print(f"  SYNTHESIS                                 {verdict[0]:<8} {verdict[1]}")
    new = candidates(d["choices"][0]["message"]["content"], [m["answer"] for m in c["members"]])
    print(f"  not in any member: {', '.join(new) if new else 'nothing'}")
