#!/usr/bin/env bash
# matrix.sh <html> [--user] [--ids "a b c"|all] [--images "img1 img2"] [--jobs N] [--out DIR] [--timeout MIN]
# Runs the generated (file-mode) script in fresh containers and summarises the "==> check" results.
set -u
HTML="${1:?usage: matrix.sh <html> [options]}"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
HTML="$(readlink -f "$HTML")"
USERMODE=0; IDS=all; JOBS=4; OUT=""; TMO=25
IMAGES="ubuntu:22.04 ubuntu:24.04 ubuntu:26.04 debian:12 debian:13 fedora:latest rockylinux:9 amazonlinux:2 alpine:latest archlinux:latest opensuse/leap:16.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) USERMODE=1 ;;
    --ids) IDS="$2"; shift ;;
    --images) IMAGES="$2"; shift ;;
    --jobs) JOBS="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --timeout) TMO="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
[ -n "$OUT" ] || OUT="${TMPDIR:-/tmp}/dti-matrix/$(date +%Y%m%d-%H%M%S)$([ $USERMODE = 1 ] && echo -user)"
mkdir -p "$OUT/scripts"; OUT="$(readlink -f "$OUT")"

pm_of() {
  case "$1" in
    ubuntu:*|debian:*) echo apt ;; fedora:*|rockylinux:*|almalinux:*) echo dnf ;;
    amazonlinux:2|centos:7) echo yum ;; amazonlinux:*) echo dnf ;;
    alpine:*) echo apk ;; archlinux*) echo pacman ;; opensuse/*) echo zypper ;;
    *) echo "unknown" ;;
  esac
}
# What a real user's box already has: root-mode needs nothing but bash on alpine (what pasteWrap adds).
# --user mode additionally needs sudo + a login user, which a real non-root user already has.
setup_for() {
  case "$1" in
    apt)    echo "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null" ;;
    dnf)    echo "dnf install -y -q sudo shadow-utils >/dev/null" ;;
    yum)    echo "yum install -y -q sudo shadow-utils >/dev/null" ;;
    apk)    echo "apk add -q bash sudo shadow >/dev/null" ;;
    pacman) echo "pacman -Sy --noconfirm --needed sudo >/dev/null" ;;
    zypper) echo "zypper -q --non-interactive install sudo shadow >/dev/null" ;;
  esac
}

run_one() {
  local img="$1" pm san log script name cmd rc
  pm="$(pm_of "$img")"; san="$(echo "$img" | tr '/:' '__')"
  log="$OUT/$san.log"; script="$OUT/scripts/$pm.sh"
  # shellcheck disable=SC2086
  node "$HERE/gen.mjs" "$HTML" "$pm" $IDS > "$script" 2> "$log" || { echo "generate failed" >> "$log"; echo 97 > "$OUT/$san.rc"; return; }
  chmod 644 "$script"
  name="matrix-$san-$$"
  if [ "$USERMODE" = 1 ]; then
    cmd="$(setup_for "$pm") && useradd -m -s /bin/bash tester && mkdir -p /etc/sudoers.d && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester && chmod 440 /etc/sudoers.d/tester && su -l tester -c 'bash /install.sh'"
  elif [ "$pm" = apk ]; then
    cmd="apk add bash >/dev/null && bash /install.sh"
  else
    cmd="bash /install.sh"
  fi
  timeout "${TMO}m" docker run --rm --name "$name" -v "$script:/install.sh:ro" "$img" sh -c "$cmd" >> "$log" 2>&1
  rc=$?
  if [ "$rc" -eq 124 ]; then docker rm -f "$name" >/dev/null 2>&1; echo "TIMEOUT after ${TMO}m" >> "$log"; fi
  echo "$rc" > "$OUT/$san.rc"
}

echo "out: $OUT  mode: $([ $USERMODE = 1 ] && echo user || echo root)  ids: $IDS  jobs: $JOBS"
for img in $IMAGES; do
  [ "$(pm_of "$img")" = unknown ] && { echo "skip $img: no pm mapping" >&2; continue; }
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
  run_one "$img" &
done
wait

printf '\n%-22s %-7s %-8s %-4s %-3s %s\n' IMAGE PM STATUS EXIT OK "MISSING | FAILED-STEPS"
for img in $IMAGES; do
  pm="$(pm_of "$img")"; [ "$pm" = unknown ] && continue
  san="$(echo "$img" | tr '/:' '__')"; log="$OUT/$san.log"; rc="$(cat "$OUT/$san.rc" 2>/dev/null || echo '?')"
  sec="$(sed -n '/^==> check/,$p' "$log")"
  ok="$(printf '%s\n' "$sec" | grep -c '^    ok ')"
  miss="$(printf '%s\n' "$sec" | sed -n 's/^    missing  *//p' | tr '\n' ' ')"
  fin="$(grep '^==> finished with problems' "$log" | sed 's/^==> finished with problems: //')"
  steps="$(grep '^    FAILED: ' "$log" | sed 's/^    FAILED: //' | tr '\n' ';')"
  for k in "package index refresh" "base packages"; do
    case "$fin" in *"$k"*) steps="$steps$k;" ;; esac
  done
  # distro packages that could not be installed and have no upstream fallback
  steps="$steps$(printf '%s\n' "$fin" | grep -oE '[[:alnum:]_.+-]+ package\b' | tr '\n' ';')"
  # tools whose distro package was unavailable, installed from upstream instead (informational)
  fb="$(sed -n 's/^--> \(.*\): native package unavailable, using upstream$/\1/p' "$log" | tr '\n' ' ')"
  [ -n "$fb" ] && miss="${miss}(fallback: ${fb% }) "
  if grep -q '^TIMEOUT' "$log"; then st=TIMEOUT
  elif grep -q '^==> done' "$log"; then st=PASS
  elif [ -n "$fin" ]; then st=PROBLEMS
  else st=CRASH; fi
  printf '%-22s %-7s %-8s %-4s %-3s %s | %s\n' "$img" "$pm" "$st" "$rc" "$ok" "${miss:--}" "${steps:--}"
done | tee "$OUT/summary.txt"
