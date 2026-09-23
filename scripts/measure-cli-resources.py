#!/usr/bin/env python3
"""What one CLI run costs the host: memory, CPU and disk, per run.

    sudo python3 scripts/measure-cli-resources.py [--seconds N] [--out FILE]

Run it on the host while the gateway serves real requests; stop it with
Ctrl-C or let --seconds expire. It is passive: it sends nothing and spends
no quota, it watches whatever the gateway runs. That is why it can ride along
a council measurement, which is the heavy load worth sizing for.

The runner starts every CLI as `sudo -n -H -u <runner> -- <binary> ...`
(src/runner/runner.ts), so a run is the tree of processes under a runner-owned
process whose parent is `sudo`. The whole tree is summed: CLIs start helpers
(Codex does), and a helper's memory is the run's memory. Runner processes that
belong to no run -- the user's systemd, the keyring Antigravity needs -- are
reported once as resident, since they are paid once per host and not per run.

Per finished run it prints: binary, peak RSS of the tree, CPU seconds, wall
seconds, peak size of its sandbox directory. At the end: the gateway's peak
RSS, the resident processes, and how much the runner's home grew (the CLIs
keep session logs there, and that is disk that accumulates).

Design spec §4.1 and docs/update-clis.md say when to run it.
"""
import argparse, os, pwd, signal, subprocess, sys, time

TICK = 0.25
DISK_EVERY = 2.0
PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024
HZ = os.sysconf("SC_CLK_TCK")


def read_procs():
    """pid -> (ppid, uid, comm, rss_kb, cpu_s, cmdline) for every live process."""
    out = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat") as f:
                stat = f.read()
            with open(f"/proc/{d}/statm") as f:
                rss_pages = int(f.read().split()[1])
            uid = os.stat(f"/proc/{d}").st_uid
            with open(f"/proc/{d}/cmdline", "rb") as f:
                cmdline = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        # comm may contain spaces and parentheses: split on the last ")".
        comm = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        ppid, utime, stime = int(fields[1]), int(fields[11]), int(fields[12])
        out[int(d)] = (ppid, uid, comm, rss_pages * PAGE_KB, (utime + stime) / HZ, cmdline)
    return out


def du_kb(path):
    try:
        r = subprocess.run(["du", "-sk", path], capture_output=True, text=True, timeout=10)
        return int(r.stdout.split()[0]) if r.returncode == 0 and r.stdout else 0
    except (subprocess.TimeoutExpired, ValueError):
        return 0


def sandbox_of(pid):
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0: until Ctrl-C)")
    ap.add_argument("--out", default=None, help="also append the per-run lines to this file")
    ap.add_argument("--user", default="runner")
    ap.add_argument("--sandbox-root", default="/var/lib/capitoline/sandboxes")
    a = ap.parse_args()

    runner = pwd.getpwnam(a.user)
    home = runner.pw_dir
    home_start = du_kb(home)
    started = time.time()
    runs = {}        # root pid -> {binary, start, peak_kb, cpu_s, sandbox, disk_kb}
    resident = {}    # comm -> peak rss kb
    gateway_peak = 0
    last_disk = 0.0
    out = open(a.out, "a") if a.out else None
    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    header = "binary\tpeak_rss_mb\tcpu_s\twall_s\tsandbox_peak_mb\tcmd"
    print(header, flush=True)
    if out:
        out.write(header + "\n")

    def finish(root, r):
        line = f"{r['binary']}\t{r['peak_kb'] / 1024:.0f}\t{r['cpu_s']:.1f}\t{time.time() - r['start']:.1f}\t{r['disk_kb'] / 1024:.1f}\t{r['cmd'][:120]}"
        print(line, flush=True)
        if out:
            out.write(line + "\n")
            out.flush()

    while not stop and (a.seconds <= 0 or time.time() - started < a.seconds):
        procs = read_procs()
        children = {}
        for pid, p in procs.items():
            children.setdefault(p[0], []).append(pid)
        # Trees rooted at a runner process started by sudo: one CLI run each.
        roots = [pid for pid, p in procs.items()
                 if p[1] == runner.pw_uid and p[0] in procs and procs[p[0]][2] == "sudo"]
        in_runs = set()
        for root in roots:
            tree, stack = [], [root]
            while stack:
                pid = stack.pop()
                tree.append(pid)
                stack.extend(children.get(pid, []))
            in_runs.update(tree)
            rss = sum(procs[p][3] for p in tree)
            cpu = sum(procs[p][4] for p in tree)
            r = runs.get(root)
            if r is None:
                argv = procs[root][5].split(" ")
                # A CLI shipped as a script runs as `node <script>`: name the script.
                name = os.path.basename(argv[1] if os.path.basename(argv[0]) == "node" and len(argv) > 1 else argv[0])
                r = runs[root] = {"binary": name or procs[root][2],
                                  "start": time.time(), "peak_kb": 0, "cpu_s": 0.0, "disk_kb": 0,
                                  "sandbox": sandbox_of(root), "cmd": procs[root][5]}
            r["peak_kb"] = max(r["peak_kb"], rss)
            # CPU of a helper that already exited is lost from the sum; keep the
            # highest total seen rather than the last, so the figure never drops.
            r["cpu_s"] = max(r["cpu_s"], cpu)
        for pid, p in procs.items():
            if p[1] == runner.pw_uid and pid not in in_runs:
                resident[p[2]] = max(resident.get(p[2], 0), p[3])
            if "dist/main.js" in p[5]:
                gateway_peak = max(gateway_peak, p[3])
        if time.time() - last_disk >= DISK_EVERY:
            last_disk = time.time()
            for r in runs.values():
                if r["sandbox"] and r["sandbox"].startswith(a.sandbox_root):
                    r["disk_kb"] = max(r["disk_kb"], du_kb(r["sandbox"]))
        for root in [pid for pid in runs if pid not in procs or pid not in roots]:
            finish(root, runs.pop(root))
        time.sleep(TICK)

    for root, r in runs.items():
        finish(root, r)
    summary = [
        f"# gateway peak RSS: {gateway_peak / 1024:.0f} MB",
        "# resident runner processes (peak RSS, paid once per host): "
        + ", ".join(f"{c} {kb / 1024:.0f} MB" for c, kb in sorted(resident.items())),
        f"# runner home {home}: {home_start / 1024:.0f} MB at start, grew {(du_kb(home) - home_start) / 1024:.1f} MB",
    ]
    for line in summary:
        print(line, flush=True)
        if out:
            out.write(line + "\n")
    if out:
        out.close()


if __name__ == "__main__":
    if os.geteuid() != 0:
        sys.exit("run as root: the runner's processes and home are not readable otherwise")
    main()
