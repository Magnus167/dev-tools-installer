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
  Docker) on all-tools per pm with rc on/off, plus the `--dump` registry checks.
  Fails on shellcheck severity >= warning (`SC_SEVERITY=style` to be stricter). Exit non-zero on failure.
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
