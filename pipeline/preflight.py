#!/usr/bin/env python3
"""
preflight.py — can THIS machine reach the RAJ-RERA portal at all?

Why this exists: GitHub-hosted runners live in Azure, and reraapi.rajasthan.gov.in
drops their traffic at the packet level. DNS resolves (103.203.139.246) but the TCP
handshake never completes, so every retry in crawl.py ends in
`<urlopen error [Errno 110] Connection timed out>` and burns ~2.5 minutes per try.
Measured 19 Nov 2026 from an eastus runner: tcp/443 and tcp/80 both blackholed,
while probes from US/DE/RU/PL consumer ISPs connect in ~3 s.

So the crawler is fine; the egress is blocked. This script separates the two cases
before anything spends money on retries.

Usage
  python3 pipeline/preflight.py            # human output, exit 1 if unreachable
  python3 pipeline/preflight.py --soft     # never fail; always exit 0
  python3 pipeline/preflight.py --github   # write reachable=true|false to $GITHUB_OUTPUT
"""
import argparse
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

HOST = "reraapi.rajasthan.gov.in"
PORT = 443
PROBE = f"https://{HOST}/api/web/Home/GetVisitorCount/GetVisitorCount"
KEY = "MySuperSecretApiKey_123"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def tcp(host, port, timeout=8):
    t = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, round(time.time() - t, 2), None
    except Exception as e:                                    # noqa: BLE001
        return False, round(time.time() - t, 2), f"{type(e).__name__}: {e}"


def https(url, timeout=20, key=True):
    h = {"user-agent": UA, "accept": "application/json"}
    if key:
        h["x-api-key"] = KEY
        h["origin"] = "https://rera.rajasthan.gov.in"
    t = time.time()
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(400).decode("utf-8", "replace")
            return True, r.status, round(time.time() - t, 2), body
    except urllib.error.HTTPError as e:                        # answered = reachable
        return True, e.code, round(time.time() - t, 2), e.read(200).decode("utf-8", "replace")
    except Exception as e:                                     # noqa: BLE001
        return False, None, round(time.time() - t, 2), f"{type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--soft", action="store_true", help="always exit 0")
    ap.add_argument("--github", action="store_true", help="write to $GITHUB_OUTPUT")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    tcp_ok, tcp_s, tcp_err = tcp(HOST, PORT)
    api_ok, code, api_s, body = (False, None, 0.0, "skipped: tcp blocked")
    if tcp_ok:
        api_ok, code, api_s, body = https(PROBE)

    reachable = tcp_ok and api_ok

    if not a.quiet:
        print(f"host            {HOST}:{PORT}")
        print(f"tcp/443         {'open' if tcp_ok else 'BLOCKED'}  ({tcp_s}s)"
              + (f"  {tcp_err}" if tcp_err else ""))
        print(f"https api       {'ok' if api_ok else 'FAILED'}  ({api_s}s)"
              + (f"  status={code}" if code else "") + (f"  {body[:120]}" if not api_ok else ""))
        print(f"reachable       {json.dumps(reachable)}")
        if not reachable:
            print("\nThis egress cannot reach the portal. A cloud CI runner in Azure is the\n"
                  "usual cause (packet-level block, not geo). Run the refresh from a machine\n"
                  "with Indian consumer egress, or a self-hosted runner.")

    if a.github:
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a", encoding="utf-8") as f:
                f.write(f"reachable={'true' if reachable else 'false'}\n")
                f.write(f"tcp={'true' if tcp_ok else 'false'}\n")

    sys.exit(0 if (reachable or a.soft) else 1)


if __name__ == "__main__":
    main()
