"""Mechanical scoring for the three questions that have one checkable answer.

    python3 docs/measurements/2026-09-23-council/score.py [results-dir]

Scores every member's answer and the synthesis of every run in the results
directory. The three Nutanix questions are printed for reading rather than
scored here: their correct answers are prose, and the owner is the better
judge of them (README.md). Nothing in this file decides a verdict that the
registered questions.json does not already state.
"""
import json, pathlib, re, sys

HERE = pathlib.Path(__file__).parent
QUESTIONS = {q["id"]: q for q in json.loads((HERE / "questions.json").read_text())["questions"]}
RESULTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results"


def regex_candidates(text):
    """The expression an answer gives: its first fenced code block, else its first inline code span."""
    blocks = re.findall(r"```[a-zA-Z]*\n(.*?)```", text, re.S)
    for b in blocks:
        line = next((l.strip() for l in b.splitlines() if l.strip()), "")
        # A block may hold a Python snippet rather than the bare expression.
        m = re.search(r"r?['\"](\^?.*?\$?)['\"]", line) if ("re." in line or "=" in line) else None
        return [m.group(1) if m else line]
    return re.findall(r"`([^`]+)`", text)[:1]


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

for f in sorted(RESULTS.glob("*__*.json")):
    council, qid = f.stem.split("__", 1)
    d = json.loads(f.read_text())
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
