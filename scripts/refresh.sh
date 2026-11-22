#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# refresh.sh — full local refresh and publish.
#
# This is the path that actually works: GitHub-hosted runners are dropped by the
# portal at the TCP level (see the header of .github/workflows/refresh.yml), so a
# machine with Indian egress has to do the crawl. Publishing goes to the
# `gh-pages` branch, which is what GitHub Pages serves.
#
#   ./scripts/refresh.sh              # crawl + build + verify + publish
#   ./scripts/refresh.sh --no-crawl   # rebuild + publish from the raw/ cache
#   ./scripts/refresh.sh --no-push    # everything except publishing
#
# cron (06:30 IST):
#   30 6 * * *  /home/mayank/Projects/jaipur-rera-dashboard/scripts/refresh.sh >> /tmp/jaipur-rera-refresh.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
BRANCH=${PUBLISH_BRANCH:-gh-pages}
CRAWL=1
PUSH=1

for arg in "$@"; do
  case "$arg" in
    --no-crawl) CRAWL=0 ;;
    --no-push)  PUSH=0 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ts() { date -u +%FT%TZ; }
say() { printf '\n== %s | %s\n' "$(ts)" "$*"; }

say "preflight"
if [ "$CRAWL" = "1" ]; then
  python3 pipeline/preflight.py || {
    echo "the portal is unreachable from this machine as well — nothing to do" >&2
    exit 1
  }
else
  echo "skipped (--no-crawl)"
fi

if [ "$CRAWL" = "1" ]; then
  say "crawl master list + per-project forms"
  python3 pipeline/crawl.py
  say "crawl auxiliary registers"
  python3 pipeline/fetch_aux.py
fi

if [ "$CRAWL" = "1" ]; then
  # incremental: skips any project whose cache already holds the newest filed quarter,
  # so a daily run costs a handful of calls rather than the full 16k
  say "enrich quarterly filings (QPR)"
  python3 pipeline/fetch_qpr.py --workers 3 || \
    echo "QPR enrichment unavailable this run — building from the cache as it stands" >&2
fi

say "build payloads"
python3 pipeline/build.py

say "verify"
python3 pipeline/verify.py

if [ "$PUSH" = "0" ]; then
  say "done (not publishing: --no-push). Preview: cd site && python3 -m http.server 8777"
  exit 0
fi

say "publish site/ -> $BRANCH"
pub=$(mktemp -d)
trap 'rm -rf "$pub"' EXIT
cp -r site/. "$pub"/
touch "$pub/.nojekyll"                    # no Jekyll pass, files serve as-is

# Pages caches css/js at the edge for ten minutes, so a deploy can look like a
# no-op. Stamp the asset URLs with the publish time and the cache follows.
stamp=$(date -u +%Y%m%d%H%M)
sed -i "s|href=\"style.css\"|href=\"style.css?v=$stamp\"|; s|src=\"app.js\"|src=\"app.js?v=$stamp\"|" \
  "$pub/index.html"
grep -q "style.css?v=$stamp" "$pub/index.html" || { echo "asset cache-bust failed" >&2; exit 1; }

(
  cd "$pub"
  git init -q
  git checkout -q -b "$BRANCH"
  git config user.name  "$(git -C "$ROOT" config user.name  || echo 'Mayank Mohan')"
  git config user.email "$(git -C "$ROOT" config user.email || echo 'er.mayankmohan@gmail.com')"
  git add -A
  git commit -qm "publish $(ts) from $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  git push -f "$(git -C "$ROOT" remote get-url origin)" "HEAD:$BRANCH"
)

say "published — https://mayankmohan1992.github.io/jaipur-rera-dashboard/"
