#!/usr/bin/env python3
"""
verify.py — the gate that decides whether a freshly built dataset is publishable.

Guards against the failure mode the old workflow could not see: a crawl that
"completes" with a handful of records (truncated response, WAF page parsed as
JSON, empty master list) and then quietly replaces a good dashboard with an
empty one.

Exit 0 = publish, exit 1 = refuse and keep the last good build.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")

MIN_PROJECTS = 2000      # Jaipur district holds ~2,419 registered projects
MIN_PROMOTERS = 500
MIN_FIELDS = ("projects", "promoters", "units", "plots", "saleable", "cases")


def die(msg):
    print(f"REFUSING TO PUBLISH: {msg}")
    sys.exit(1)


def main():
    for f in ("meta.json", "projects.json"):
        p = os.path.join(DATA, f)
        if not os.path.exists(p):
            die(f"{f} missing — did pipeline/build.py run?")
        if os.path.getsize(p) < 64:
            die(f"{f} is {os.path.getsize(p)} bytes")

    meta = json.load(open(os.path.join(DATA, "meta.json")))
    proj = json.load(open(os.path.join(DATA, "projects.json")))
    t = meta.get("totals") or {}

    for k in MIN_FIELDS:
        if k not in t:
            die(f"meta.totals.{k} missing")

    print(f"asOf={meta.get('asOf')}  projects={t['projects']}  promoters={t['promoters']}  "
          f"units={t['units']}  plots={t['plots']}  saleable={t['saleable']}  cases={t['cases']}")

    if len(proj) != t["projects"]:
        die(f"projects.json has {len(proj)} rows but meta says {t['projects']}")
    if t["projects"] < MIN_PROJECTS:
        die(f"only {t['projects']} projects (expected >={MIN_PROJECTS})")
    if t["promoters"] < MIN_PROMOTERS:
        die(f"only {t['promoters']} promoters (expected >={MIN_PROMOTERS})")
    if not any(p.get("regDate") for p in proj):
        die("no registration dates parsed")

    # every project must carry the identity the UI keys on
    missing = [p for p in proj if not p.get("id") or not p.get("name")]
    if missing:
        die(f"{len(missing)} project rows without id/name")

    detail = os.path.join(DATA, "detail")
    n_detail = len([f for f in os.listdir(detail) if f.endswith(".json")]) if os.path.isdir(detail) else 0
    if n_detail and n_detail < len(proj) * 0.9:
        die(f"only {n_detail} detail files for {len(proj)} projects")

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fns in os.walk(DATA) for f in fns)
    print(f"detail_files={n_detail}  payload={size/1048576:.1f} MB")
    print("dataset checks passed")


if __name__ == "__main__":
    main()
