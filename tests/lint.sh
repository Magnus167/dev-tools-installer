#!/usr/bin/env bash
# lint.sh <html>: bash -n on every generated script, shellcheck (Docker) on the all-tools scripts.
# Exit non-zero on any failure. Set SC_SEVERITY (default: warning) to change the failing level.
set -u
HTML="${1:?usage: lint.sh <html>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SEV="${SC_SEVERITY:-warning}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/lint.XXXXXX")"
fail=0; nsyn=0; badsyn=0

node "$HERE/gen.mjs" "$HTML" --dump "$OUT" || { echo "GENERATE: errors above"; fail=1; }

for f in "$OUT"/*/*.sh; do
  [ -e "$f" ] || continue
  nsyn=$((nsyn+1))
  if ! err="$(bash -n "$f" 2>&1)"; then
    badsyn=$((badsyn+1)); echo "SYNTAX ${f#"$OUT"/}: $err"; fail=1
  fi
done
echo "bash -n: $nsyn scripts, $badsyn failed"

nsc=0; badsc=0
for pm in apt dnf yum apk pacman zypper; do
  for v in all all-norc; do
    [ -f "$OUT/$pm/$v.sh" ] || continue
    nsc=$((nsc+1))
    if ! res="$(docker run --rm -v "$OUT/$pm:/mnt:ro" koalaman/shellcheck:stable -s bash -S "$SEV" -f gcc "/mnt/$v.sh" 2>&1)"; then
      badsc=$((badsc+1)); fail=1
      echo "SHELLCHECK $pm/$v (>= $SEV):"; echo "$res" | sed 's/^/  /'
    fi
  done
done
echo "shellcheck (>= $SEV): $nsc scripts, $badsc with findings"
# informational: everything below the threshold, one pm (scripts differ little between pms)
info="$(docker run --rm -v "$OUT/apt:/mnt:ro" koalaman/shellcheck:stable -s bash -S style -f gcc /mnt/all.sh 2>&1 | grep -c ': \(note\|style\|info\)')"
echo "shellcheck info/style notes on apt/all (informational): $info"

rm -rf "$OUT"
[ "$fail" -eq 0 ] && echo "LINT OK" || echo "LINT FAILED"
exit "$fail"
