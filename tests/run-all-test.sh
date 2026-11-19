#!/usr/bin/env bash
# Runs the Playwright browser suite in apps/web/tests (the repo root tests/ folder is empty)
# and prints a short summary: OK, or the number of failures with each failing test and its first error.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp -t podgo-tests.XXXXXX.log)"
trap 'rm -f "$LOG"' EXIT

cd "$ROOT/apps/web" || exit 2
echo "Running Playwright tests from apps/web/tests (about 30 minutes)... (logfile: $LOG)"
npx playwright test --reporter=line >"$LOG" 2>&1
status=$?

passed=$(grep -E '^ +[0-9]+ passed' "$LOG" | tail -1 | sed 's/^ *//')
failed=$(grep -E '^ +[0-9]+ failed' "$LOG" | tail -1 | sed 's/^ *//')

if [ "$status" -eq 0 ]; then
  echo "OK: all tests passed ($passed)."
  exit 0
fi

if [ -z "$failed" ]; then
  echo "ERROR: Playwright exited with code $status before running the tests. Last output:"
  tail -n 20 "$LOG"
  exit "$status"
fi

echo "FAILED: $failed${passed:+, $passed}"
awk '
  /^ +[0-9]+\) \[/ {
    title = $0
    sub(/^ +[0-9]+\) /, "", title)
    sub(/ ─+.*$/, "", title)
    shown = 0
    next
  }
  title != "" && !shown && /Error:/ {
    err = $0
    gsub(/^ +/, "", err)
    print "  - " title
    print "      " err
    shown = 1
    title = ""
  }
' "$LOG"
exit 1
