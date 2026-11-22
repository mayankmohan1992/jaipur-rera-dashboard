#!/usr/bin/env python3
"""
QPR enrichment: turn each project's filed-quarter list into numbers.

The dossier (raw/<id>.json.gz) carries dtls.qpr[] - one row per quarter the promoter
filed a Quarterly Progress Report - with two encrypted ids but no figures. The figures
live in a second call per quarter:

  GET reraapp.rajasthan.gov.in/HomeWebsite/QPRSummaryWebSite
        ?projectIdEnc=<qpr.encryptPROJECTID>&QuarterIdEnc=<qpr.encryptQuaterID>&PT=<qpr.PT>
    -> data.QprSubmissionDt          "28/01/2025"
       data.TotalBooked              391        (units/plots booked, cumulative)
       data.TotalUnBooked            210
       data.NumberOfSanctionedAppartmentsPlots 601
       data.GetQPRR3Details.CompletionOfConstWork   %
       data.GetQPR_COMPLIANCES_Details.percentageOfApartmentsBooked  <- WRONG, ignore
         (it returns 10.0 for 391/601 = 65%; compute from the counts instead)

Output: raw_qpr/<projectId>.json.gz  - resumable, one record per project:
  {"projectId": 1006, "asOf": "...", "rows": [ {quarterId, quarter, filedOn, booked,
    unbooked, sanctioned, constPct, spend, ...}, ... ] }

Usage:
  ./pipeline/fetch_qpr.py                 # latest quarter per project (fast)
  ./pipeline/fetch_qpr.py --all           # every filed quarter (sales curves)
  ./pipeline/fetch_qpr.py --limit 25       # smoke test
  ./pipeline/fetch_qpr.py --workers 10
"""
import argparse
import glob
import gzip
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "raw_qpr")
MVC = "https://reraapp.rajasthan.gov.in/HomeWebsite"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
           "Referer": "https://rera.rajasthan.gov.in/"}

_lock = threading.Lock()
_done = _err = 0


def _get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=90) as f:
                return json.loads(f.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1) + random.random())


def num(v):
    if v in (None, "", "-", "NA", "N/A"):
        return None
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def dmy(v):
    """'28/01/2025' -> '2025-01-28'."""
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(v or ""))
    return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}" if m else None


def quarter_of(row):
    """The qpr row's quarter label, e.g. 'July to September, 2026'."""
    return (row.get("CurrentQuarter") or "").strip()


def fetch_quarter(enc_p, enc_q, pt):
    q = urllib.parse.quote(str(enc_p), safe="")
    qq = urllib.parse.quote(str(enc_q), safe="")
    url = f"{MVC}/QPRSummaryWebSite?projectIdEnc={q}&QuarterIdEnc={qq}&PT={pt}"
    d = _get(url)
    m = d.get("data") if isinstance(d, dict) and "data" in d else d
    if not isinstance(m, dict):
        return None
    r3 = m.get("GetQPRR3Details") or {}
    booked, unbooked = num(m.get("TotalBooked")), num(m.get("TotalUnBooked"))
    sanctioned = num(m.get("NumberOfSanctionedAppartmentsPlots"))
    return {
        "quarter": m.get("QTRMnthNAME"),
        "appNo": m.get("QPRApplicationNo"),
        "filedOn": dmy(m.get("QprSubmissionDt")),
        "booked": int(booked) if booked is not None else None,
        "unbooked": int(unbooked) if unbooked is not None else None,
        "sanctioned": int(sanctioned) if sanctioned is not None else None,
        # computed, never the portal's percentageOfApartmentsBooked
        "pctBooked": (round(100 * booked / (booked + unbooked), 1)
                      if booked is not None and unbooked is not None and (booked + unbooked) > 0 else None),
        # the portal occasionally files nonsense here (52,100,000%); keep only a real percentage
        "constPct": (lambda c: c if c is not None and 0 <= c <= 100 else None)(num(r3.get("CompletionOfConstWork"))),
        "landSpend": num(r3.get("IncurredLandC")),
        "devSpend": num(r3.get("IncurredDevelopmentC")),
    }


def work(args):
    path, all_quarters = args
    pid = os.path.basename(path).split(".")[0]
    out_path = os.path.join(OUT, f"{pid}.json.gz")
    if os.path.exists(out_path):
        with _lock:
            globals()["_done"] += 1
            if _done % 200 == 0:
                print(f"  [{_done}/{_total}] skipped existing", flush=True)
        return
    try:
        d = json.load(gzip.open(path, "rt"))
        rows = ((d.get("dtls") or {}).get("qpr") or [])
        if not rows:
            payload = {"projectId": int(pid), "rows": [], "note": "no QPR filed"}
        else:
            rows = sorted(rows, key=lambda r: num(r.get("QuaterID")) or 0, reverse=True)
            picked = rows if all_quarters else rows[:1]
            got = []
            for r in picked:
                got.append(fetch_quarter(r.get("encryptPROJECTID"), r.get("encryptQuaterID"), r.get("PT") or 1)
                           or {"quarter": quarter_of(r), "error": "empty payload"})
                # attach the dossier's own label as a fallback
                got[-1].setdefault("quarter", quarter_of(r))
            payload = {"projectId": int(pid), "rows": got}
        data = gzip.compress(json.dumps(payload).encode())
        tmp = out_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, out_path)
        with _lock:
            globals()["_done"] += 1
            if _done % 100 == 0:
                print(f"  [{_done}/{_total}] ok", flush=True)
    except Exception as e:                                   # noqa: BLE001
        with _lock:
            globals()["_err"] += 1
            print(f"  ERR {pid}: {type(e).__name__} {e}", flush=True)


_total = 0


def main():
    global _total
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="every filed quarter, not just the latest")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    files = sorted(glob.glob(os.path.join(RAW, "*.json.gz")))
    if a.limit:
        files = files[:a.limit]
    _total = len(files)
    t0 = time.time()
    print(f"{len(files)} projects, {'all quarters' if a.all else 'latest quarter only'}, "
          f"{a.workers} workers -> {OUT}")
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        list(ex.map(work, [(f, a.all) for f in files]))
    print(f"done ok={_done - _err} err={_err} in {time.time() - t0:.0f}s")
    return 1 if _err else 0


if __name__ == "__main__":
    sys.exit(main())
