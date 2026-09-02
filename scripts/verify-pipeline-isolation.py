"""Prove the MLB and football pipelines cannot see each other's files.

Reasoning about glob prefixes is not enough: `football-ladder-race-*` and
`ladder-lag-race-*` are one careless wildcard apart, and MLB is live money.
This plants decoys of both kinds in a temp dir and asserts each pipeline's
real globs match only its own.

Three consumers share the recorder data dir and all use the same fnmatch
whole-basename semantics, so the patterns below cover every one:
  collect-mlb-fire-samples.py / collect-mlb-softballs.py  (Python glob)
  collect-football-samples.py / compact-football-captures.py  (Python glob)
  /usr/local/bin/sports-arb-compress-recorder.sh  (shell `find -name`,
      every 3h — a false match there would gzip a football capture
      mid-game, since games run past its 180-minute threshold)

Re-run this after touching any of those patterns.
"""
import glob
import os
from pathlib import Path

D = Path("/tmp/iso-check")
os.makedirs(D, exist_ok=True)
for f in glob.glob(str(D / "*")):
    os.remove(f)

MLB_FILES = [
    "ladder-lag-race-2026-09-02T16-05-01-869Z.jsonl",
    "ladder-lag-race-2026-09-02T16-05-01-869Z.jsonl.gz",
    "mlb-middle-arb-paper-2026-09-02T16-05-01-869Z.jsonl",
]
FB_FILES = [
    "football-ladder-race-ncaaf-uapb-miz-2026-09-03-2026-09-03T23-15-00-000Z.jsonl",
    "football-ladder-race-nfl-ne-sea-2026-09-09-2026-09-10T00-20-00-000Z.jsonl.gz",
]
for name in MLB_FILES + FB_FILES:
    (D / name).write_text("{}\n")

# The exact globs each collector uses.
MLB_GLOBS = [
    "ladder-lag-race-*.jsonl", "ladder-lag-race-*.jsonl.gz",
    "mlb-middle-arb-paper-*.jsonl", "mlb-middle-arb-paper-*.jsonl.gz",
]
FB_GLOBS = [
    "football-ladder-race-*.jsonl", "football-ladder-race-*.jsonl.gz",
]

mlb_hits = {Path(p).name for g in MLB_GLOBS for p in glob.glob(str(D / g))}
fb_hits = {Path(p).name for g in FB_GLOBS for p in glob.glob(str(D / g))}

print("MLB globs matched:")
for n in sorted(mlb_hits):
    print("   ", n)
print("football globs matched:")
for n in sorted(fb_hits):
    print("   ", n)

leak_mlb = mlb_hits & set(FB_FILES)
leak_fb = fb_hits & set(MLB_FILES)
missing_mlb = set(MLB_FILES) - mlb_hits
missing_fb = set(FB_FILES) - fb_hits

print()
print("football files caught by MLB globs :", sorted(leak_mlb) or "none")
print("MLB files caught by football globs :", sorted(leak_fb) or "none")
print("MLB files its own globs missed     :", sorted(missing_mlb) or "none")
print("football files its own globs missed:", sorted(missing_fb) or "none")
ok = not (leak_mlb or leak_fb or missing_mlb or missing_fb)
print()
print("ISOLATION:", "OK" if ok else "FAILED")
raise SystemExit(0 if ok else 1)
