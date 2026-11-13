# Test harness for the generated install scripts

Pure Node stdlib on the host; shellcheck and all installs run in Docker only, never on your machine.
`<html>` is the installer page (normally `index.html`; the path is an argument and no tool ids are hardcoded).
The app is evaluated in a Node `vm` with DOM stubs. Run everything from the repo root.

- `node tests/gen.mjs <html> <pm> [--rc-off] [--paste] <ids...|all>`  print the generated script (`--paste` = pasteWrap form).
- `node tests/gen.mjs <html> --list`  print tool ids.
- `node tests/gen.mjs <html> --combos [--base N]`  JSON of pm+selection -> combo id for selections drawn from the first N
  tools (default 22, the original set), plus an encode/decode round-trip over all tools. Save the output and `diff`
  its `combos` section after appending tools: any change to an existing key is a broken combo encoding. Exit 1 on round-trip failure.
- `node tests/gen.mjs <html> --dump DIR`  write every script (all, all-norc, each tool alone, per pm); used by lint.sh.
  Also checks the registry: every snippet referenced by TOOLS (`fn`/`pre`/`post`/`rc`/`init`) exists, every `fn`
  snippet defines `install_<id>()`, every `fn` snippet has a VIA badge, `how()` resolves for every tool on every pm,
  and every tool sits in exactly one GROUPS entry matching its `group`.
- `tests/lint.sh <html>`  bash -n on all scripts (6 pms x (all + all-norc + each tool)), shellcheck (koalaman/shellcheck in
  Docker) on all-tools per pm with rc on/off, plus the `--dump` registry checks. Also builds the curl installer:
  `bash -n` and shellcheck (as bash) on install.sh, and `sh -n` plus shellcheck as sh on its POSIX bootstrap.
  Fails on shellcheck severity >= warning (`SC_SEVERITY=style` to be stricter). Exit non-zero on failure.
- `node tests/parity.mjs <html> [--random N] [--seed S] [--jobs J] [--combos FILE]`  the gate between the page and
  the curl installer: builds install.sh (`scripts/build-installer.mjs`) and requires `bash install.sh --print ...` to be
  byte-identical to the page's `generate()` in both forms (`<pm> <ids> [--no-shell]` and `<combo>`) for every pm x
  (all tools, rc on/off; each tool alone; sets of tools with requires/init/initAlways/initUpstreamOnly/fallback/
  noFallback/skip/rc/build/pre-post), plus N random selections (default 300). Selections with nothing installable must
  exit 2. Also checks the error paths (too-new combo, unknown id or pm: exit 2), `--list`, `--help`, `sh install.sh`
  (bootstrap in file mode), and tools.json/llms.txt against the page. `--combos` takes a saved `gen.mjs --combos`
  output: every saved combo must still decode in bash to its selection. Runs install.sh only with `--print`, `--list`
  and `--help`, which install nothing.
- `tests/installer-e2e.sh <html> [--jobs N] [--out DIR]`  the curl installer for real, in Docker: serves the built
  install.sh from a busybox httpd container on a private network and runs `curl ... | bash -s -- <combo>` (ubuntu:24.04),
  `curl ... | sh -s -- apk git jq` and `wget ... | sh` (alpine: the bash bootstrap), `... | bash -s -- dnf ripgrep node`
  (fedora), plus a too-new combo, an unknown id and a wrong pm (exit 2, nothing installed), and `--print`/`--list`/`--help`
  installing nothing (also on alpine without bash). Logs and summary.txt in DIR (default `${TMPDIR:-/tmp}/dti-e2e/<timestamp>`).
- `tests/matrix.sh <html> [--user] [--ids "a b"|all] [--images "i1 i2"] [--jobs N] [--out DIR] [--timeout MIN]`
  run the file-mode script in `docker run --rm` per image (default: ubuntu:22.04 ubuntu:24.04 ubuntu:26.04 debian:12
  debian:13 fedora:latest rockylinux:9 amazonlinux:2 alpine:latest archlinux:latest opensuse/leap:16.0, 4 in parallel,
  25 min timeout each; use `--timeout 60` for `--ids all`, which compiles jnv with cargo). Logs in DIR/<image>.log,
  summary in DIR/summary.txt (status, exit, ok count, missing bins plus "(fallback: …)" for tools whose distro package
  was unavailable and came from upstream instead, failed steps and "<pkg> package" for distro packages that failed
  with no fallback). Tools a pm skips are not in that pm's script, so they are not counted.
  Root mode adds only bash on alpine (as pasteWrap does). `--user` first installs sudo (+bash on alpine) and creates
  user `tester` with passwordless sudo, then runs `su -l tester -c 'bash /install.sh'` (tests ~/.local/bin and $SUDO).
  Default DIR is `${TMPDIR:-/tmp}/dti-matrix/<timestamp>[-user]` (outside the repo).

Expected on the default images: everything "ok" except
- rockylinux:9: htop, entr and ffmpeg (ffmpeg-free) are only in EPEL / RPM Fusion; the dnf install line skips
  unavailable packages and the final check reports them missing;
- opensuse/leap:16.0: nmap is not packaged and has no upstream fallback, so it is reported missing ("nmap package").
On the other pms a failed package batch is retried one package at a time, and tools that also have an upstream
build fall back to it, so one missing package (e.g. sd on Ubuntu 22.04) does not take the rest down with it.
