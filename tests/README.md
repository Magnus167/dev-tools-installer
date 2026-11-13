# Test harness for the generated install scripts

Pure Node stdlib on the host; shellcheck and all installs run in Docker only, never on your machine.
`<html>` is the installer page (normally `index.html`; the path is an argument and no tool ids are hardcoded).
The page is loaded by `scripts/build-installer.mjs`'s loader, shared by every tool here: it first parses every
inline script on the page (a syntax error anywhere, such as a duplicate `const` in the UI code, fails the
load), then runs the app script in a Node `vm` only up to the `window.__boots = {...}` line, which holds the
data and the generator, not the UI. `tests/page-check.sh` runs the whole page in a real browser. Run
everything from the repo root.

- `node tests/gen.mjs <html> <pm> [--rc-off] [--paste] <ids...|all>`  print the generated script (`--paste` = pasteWrap form).
- `node tests/gen.mjs <html> --list`  print tool ids.
- `node tests/gen.mjs <html> --check-page`  every inline script on the page parses (exit 1 naming the script if not).
- `node tests/gen.mjs <html> --combos [--base N]`  JSON of pm+selection -> combo id for selections drawn from the first N
  tools (default 22, the original set), plus an encode/decode round-trip over all tools. Save the output and `diff`
  its `combos` section after appending tools: any change to an existing key is a broken combo encoding. Exit 1 on round-trip failure.
- `node tests/gen.mjs <html> --dump DIR`  write every script (all, all-norc, each tool alone, per pm); used by lint.sh.
  Also checks the registry: every snippet referenced by TOOLS (`fn`/`pre`/`post`/`rc`/`init`) exists, every `fn`
  snippet defines `install_<id>()`, every `fn` snippet has a VIA badge, `how()` resolves for every tool on every pm,
  and every tool sits in exactly one GROUPS entry matching its `group`.
- `tests/lint.sh <html>`  `gen.mjs --check-page`, bash -n on all scripts (6 pms x (all + all-norc + each tool)), shellcheck (koalaman/shellcheck in
  Docker) on all-tools per pm with rc on/off, plus the `--dump` registry checks. Also builds the curl installer:
  `bash -n` and shellcheck (as bash) on install.sh, and `sh -n` plus shellcheck as sh on its POSIX bootstrap.
  Fails on shellcheck severity >= warning (`SC_SEVERITY=style` to be stricter). Exit non-zero on failure.
- `node tests/parity.mjs <html> [--random N] [--seed S] [--jobs J] [--combos FILE] [--installer DIR]`  the gate between the page and
  the curl installer: builds install.sh (`scripts/build-installer.mjs`) and requires `bash install.sh --print ...` to be
  byte-identical to the page's `generate()` in both forms (`<pm> <ids> [--no-shell]` and `<combo>`) for every pm x
  (all tools, rc on/off; each tool alone; sets of tools with requires/init/initAlways/initUpstreamOnly/fallback/
  noFallback/skip/rc/build/pre-post), every apt/apk combo whose digits spell a tool id or name (install.sh must refuse
  `apt-jq` with exit 2, and the page's `apt-0jq` form must give the same script), plus N random selections (default
  300): about 1,300 selections and 2,600 install.sh runs. Selections with nothing installable must exit 2. Also checks the error paths (too-new combo, unknown id or pm: exit 2), `--list`, `--help`, `sh install.sh`
  (bootstrap in file mode), and tools.json/llms.txt against the page. `--combos` takes a saved `gen.mjs --combos`
  output: every saved combo must still decode in bash to its selection. Runs install.sh only with `--print`, `--list`
  and `--help`, which install nothing. `--installer DIR` tests a built version directory (DIR/install.sh, tools.json,
  llms.txt; the release workflow passes its stamped `site/vX.Y.Z`) instead of building from `<html>`, and requires
  those files to equal a fresh build.
- `tests/page-check.sh <html | site dir>`  loads the page in headless Chromium (Docker, `PW_IMAGE`, default the
  Playwright Python image; the matching `playwright` package is pip-installed in the container if missing):
  no script errors, every tool rendered, a combo link preselects and gives the right commands (Alpine: `sh` to
  install, `bash` for `--print` with the page-link note; a combo spelling a tool id gets its 0), and a link from a
  newer version shows the warning with a link to the latest.
- `tests/build-site-check.sh`  builds the site (`scripts/build-site.sh`) from a throwaway clone with the working tree
  committed and tagged as a fake v1.2.0, then checks root and `latest/` are redirect pages to v1.2.0 (JS, meta refresh,
  canonical, plain link) serving v1.2.0's install.sh/tools.json/llms.txt, `sha256sum -c` in root, `latest/` and v1.2.0, and,
  in headless Chromium (Docker), that `<SITE>#apt-1kx` and `<SITE>latest/#apt-1kx` land on `<SITE>v1.2.0/#apt-1kx`
  with the page loaded and no errors (requests to the site URL are answered from the built tree).
- `tests/installer-e2e.sh <html> [--jobs N] [--out DIR] [--only REGEX]`  the curl installer for real, in Docker: serves
  the built install.sh from a busybox httpd container on its localhost (client containers share its network, so
  `BOOTS_INSTALL_URL=http://localhost:8000/install.sh` is accepted) and runs `curl ... | bash -s -- <combo>` (ubuntu:24.04),
  `curl ... | sh -s -- apk git jq` and `wget ... | sh` (alpine: the bash bootstrap), `... | bash -s -- dnf ripgrep node`
  (fedora); a too-new combo, an unknown id, a wrong pm and `apt-docker` (exit 2, nothing installed); `| sudo bash` from a
  sudo user refused (exit 2, and the generated script's own guard too) and allowed with `sudo env BOOTS_ALLOW_ROOT=1`;
  a non-https `BOOTS_INSTALL_URL` ignored with a warning; `--print`/`--list`/`--help` installing nothing (on alpine
  without bash: the error points at the page link). Logs and summary.txt in DIR (default `${TMPDIR:-/tmp}/dti-e2e/<timestamp>`).
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
