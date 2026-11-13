#!/usr/bin/env bash
# installer-e2e.sh <html> [--jobs N] [--out DIR] [--only REGEX]
# The curl installer end to end, in Docker only (nothing runs on this machine but node and docker).
# Builds install.sh from <html>, serves it from a throwaway busybox httpd container on a private
# network, and runs real `curl ... | bash -s --` / `| sh -s --` installs and the error paths in fresh
# containers. BOOTS_INSTALL_URL points the `| sh` bootstrap at the local server instead of the site.
set -u
HTML="${1:?usage: installer-e2e.sh <html> [--jobs N] [--out DIR] [--only REGEX]}"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
JOBS=4; OUT=""; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs) JOBS="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
[ -n "$OUT" ] || OUT="${TMPDIR:-/tmp}/dti-e2e/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT/site"; OUT="$(readlink -f "$OUT")"

node "$HERE/../scripts/build-installer.mjs" "$HTML" "$OUT/site" >/dev/null || { echo "build-installer failed" >&2; exit 1; }
chmod -R a+rX "$OUT/site"
NET="boots-e2e-$$"; SRV="boots-srv-$$"
cleanup() { docker rm -f "$SRV" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
docker network create "$NET" >/dev/null || exit 1
docker run -d --rm --name "$SRV" --network "$NET" -v "$OUT/site:/srv:ro" busybox:stable httpd -f -p 8000 -h /srv >/dev/null || exit 1
URL="http://$SRV:8000/install.sh"

combo() { node "$HERE/gen.mjs" "$HTML" "$@" | sed -n 's/^# combo:  //p'; }
NT="$(node "$HERE/gen.mjs" "$HTML" --list | wc -l)"
TOO_NEW="$(node -e "console.log('apt-' + ((1n << BigInt($NT + 1)) | 2n).toString(36))")"
APT_COMBO="$(combo apt git jq fd)"
UBU_CURL="apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null"

# add <name> <image> <want-exit> <patterns> <command>: patterns are @-separated egrep patterns that must
# all appear in the output, or must not appear when they start with "!"
CASES=()
add() { if [ -z "$ONLY" ] || [[ "$1" =~ $ONLY ]]; then CASES+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"$5"); fi; }
add ubuntu-combo ubuntu:24.04 0 "^==> done@^    ok       fd@^    ok       jq" \
  "$UBU_CURL && curl -fsSL $URL | bash -s -- $APT_COMBO"
add alpine-sh-bootstrap alpine:latest 0 "installing bash, which this installer needs@^==> done@^    ok       jq@!curl: \\(23\\)" \
  "apk add -q curl && ! command -v bash && curl -fsSL $URL | sh -s -- apk git jq"
add alpine-wget-only alpine:latest 0 "installing bash@^==> done@^    ok       git" \
  "! command -v curl && wget -qO- $URL | sh -s -- apk git"
add fedora-ids fedora:latest 0 "^==> done@^    ok       rg@^    ok       node" \
  "curl -fsSL $URL | bash -s -- dnf ripgrep node"
add too-new-combo fedora:latest 2 "this combo needs a newer version: https://magnus167.github.io/dev-tools-installer/install.sh@^NOTHING-INSTALLED" \
  "curl -fsSL $URL | bash -s -- $TOO_NEW; rc=\$?; ! command -v git && echo NOTHING-INSTALLED; exit \$rc"
add unknown-id fedora:latest 2 "unknown tool id 'nodejs'; did you mean: node@^NOTHING-INSTALLED" \
  "curl -fsSL $URL | bash -s -- dnf git nodejs; rc=\$?; ! command -v git && echo NOTHING-INSTALLED; exit \$rc"
add wrong-pm fedora:latest 2 "there is no apt-get here" \
  "curl -fsSL $URL | bash -s -- apt git"
add print-list-noop ubuntu:24.04 0 "^PRINT-OK@^LIST-OK@^NOTHING-INSTALLED" \
  "before=\$(dpkg -l | wc -l); bash /srv/install.sh --print apt git jq > /tmp/p && grep -q '^# combo:  ' /tmp/p && echo PRINT-OK; bash /srv/install.sh --list apt > /tmp/l && grep -q '^jq ' /tmp/l && echo LIST-OK; [ \"\$(dpkg -l | wc -l)\" = \"\$before\" ] && ! command -v jq && ! ls /tmp/boots-install.* 2>/dev/null && echo NOTHING-INSTALLED"
add alpine-print-without-bash alpine:latest 1 "needs bash, which is not installed here; nothing was changed@^HELP-OK@^PIPED-HELP-OK@^NOTHING-INSTALLED@!curl: \\(23\\)" \
  "sh /srv/install.sh --help | grep -q '^Usage: ' && echo HELP-OK; apk add -q curl; curl -fsSL $URL | sh -s -- --help | grep -q '^Usage: ' && echo PIPED-HELP-OK; curl -fsSL $URL | sh -s -- --print apk git; rc=\$?; ! command -v bash && echo NOTHING-INSTALLED; exit \$rc"

run_case() {
  local name img want pats cmd rc missing="" p
  IFS=$'\t' read -r name img want pats cmd <<< "$1"
  docker run --rm --network "$NET" -e BOOTS_INSTALL_URL="$URL" -v "$OUT/site:/srv:ro" "$img" sh -c "$cmd" > "$OUT/$name.log" 2>&1
  rc=$?
  IFS=@ read -r -a pp <<< "$pats"
  for p in "${pp[@]}"; do
    case "$p" in
      !*) if grep -qE "${p#!}" "$OUT/$name.log"; then missing+=" [$p]"; fi ;;
      *) grep -qE "$p" "$OUT/$name.log" || missing+=" [$p]" ;;
    esac
  done
  if [ "$rc" = "$want" ] && [ -z "$missing" ]; then echo "PASS $name ($img, exit $rc)"
  else echo "FAIL $name ($img, exit $rc, want $want)${missing:+ patterns:$missing}"; fi > "$OUT/$name.result"
}

echo "out: $OUT  server: $URL  combo(apt git jq fd): $APT_COMBO  too new: $TOO_NEW"
for c in "${CASES[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
  run_case "$c" &
done
wait
for c in "${CASES[@]}"; do
  n="${c%%$'\t'*}"; cat "$OUT/$n.result" 2>/dev/null || echo "FAIL $n (no result)"
done | tee "$OUT/summary.txt"
grep -q '^FAIL' "$OUT/summary.txt" && { echo "E2E FAILED (logs in $OUT)"; exit 1; }
echo "E2E OK"
