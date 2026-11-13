# dev-tools-installer

A quick one-command installer for common Linux dev tools (Ninite-inspired).

**Live site: https://magnus167.github.io/dev-tools-installer/**

Pick your package manager (apt, dnf, apk, pacman, zypper, or legacy yum), tick the tools you want, and
paste the generated bash script into a fresh box, or run the same script with one `curl` command. It
installs what your distro packages natively, fetches the rest from each project's official releases into
`~/.local/bin`, and can wire up your `.bashrc`/`.zshrc`. Every step skips tools already on your `PATH`, so
re-running is safe. The whole app is one static `index.html` with no backend; the build stamps the release
version and commit into it and generates the curl installer from it (see Releases).

Your picks are encoded in a **combo ID** (for example `apt-1kx`) kept in the page URL, so a link always
reproduces the same selection. Tools a package manager can't install are greyed out with the reason and
left out of the script.

## Command line

`install.sh` builds the same script the page shows (byte for byte), saves it to a temp file and runs it. Replace `vX.Y.Z` with a
release (the page shows the exact command for the current one). Pinning the version keeps a command behaving the same
forever; the unversioned `/install.sh` at the site root always follows the latest release.

```sh
curl -fsSL https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh | bash -s -- apt-1kx          # a combo ID from the page
curl -fsSL https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh | bash -s -- apt git docker node   # or tool ids
curl -fsSL https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh | sh -s -- apk git jq           # Alpine: sh, it adds bash first
curl -fsSL https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh | bash -s -- --print apt-1kx  # print the script, run nothing (any OS with bash)
curl -fsSL https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh | bash -s -- --list apt        # tool ids, and how each installs
```

Run it as your normal user, not with `sudo`: it calls sudo (or doas) itself for system packages, and under
sudo it stops (exit 2), because the user-level tools and shell setup would land in root's home
(`... | sudo env BOOTS_ALLOW_ROOT=1 bash -s -- ...` if that is really what you want; plain root, as in a
container, is fine). `--no-shell` leaves PATH and tool hooks out of your rc file; `--help` has the rest. Use
the versioned URL (`.../vX.Y.Z/install.sh`) to pin a release; the page's one-liner does. Exit status: 0 done,
1 something did not install, 2 bad arguments or a combo from a newer version (then nothing was changed).
A combo whose digits spell a tool id (`apt-jq`) is taken for a typo of `apt jq` and refused; the page writes
such combos with a 0 after the dash (`apt-0jq`, same value). Under `sh` the installer fetches itself again
from its own versioned URL and runs under bash (`BOOTS_INSTALL_URL` overrides that URL for mirrors and
tests; https only, or http://localhost).

For AI assistants and scripts, each version also serves [`llms.txt`](https://magnus167.github.io/dev-tools-installer/llms.txt)
(how to answer with a combo link or tool ids) and [`tools.json`](https://magnus167.github.io/dev-tools-installer/tools.json)
(every tool, and how it installs with each package manager, including the upstream fallback behind a distro
package).

## Tools

| Group | Tools |
|---|---|
| Essentials | git, python3 + pip, docker, gh, git-lfs |
| Languages | uv, rust + cargo, go, node (via nvm), bun, deno, java (via SDKMAN) |
| Containers | podman, apptainer, kubectl, k9s, helm, kind, dive, kubectx + kubens |
| Infra and cloud | opentofu, terraform, aws cli, ansible |
| Files and text | fd, bat, eza, delta, dust, duf, sd, tealdeer |
| Search and data | ripgrep, fzf, jq, yq, gron, jnv |
| Data | sqlite3, duckdb, ffmpeg, pandoc |
| Dev workflow | hyperfine, direnv, just, mise, shellcheck, pre-commit, xh, mkcert |
| Terminal apps | lazygit, lazydocker, bottom, glow, harlequin, visidata, btop, ncdu, neovim, tmux, zellij, yazi |
| Shell | zoxide, starship, atuin, clipcat, act, mkcd, extract, serve |
| System | htop, tree, rsync, wget, lsof, strace, iotop, sysstat, 7zip, watch, entr |
| Network | nmap, mtr, traceroute, dig, whois, tcpdump, netcat, socat, iperf3 |

Adding a tool: append it to the end of `TOOLS` in `index.html` (the list order *is* the combo encoding, so
never reorder or delete entries) and place it in `GROUPS` wherever it should appear on the page. The curl
installer picks it up from the page; a change to `generate()` itself needs the same change in its bash port,
`scripts/install.sh.in` (`tests/parity.mjs` fails until the two agree).

## Releases

Versions are `vX.Y.Z`:

- **Z** for minor changes (a new tool, a fixed snippet),
- **Y** for major UI changes,
- **X** for major changes such as hosting.

One-time setup (repo admin, before the first release):

```sh
# 1. Serve Pages from GitHub Actions (POST if Pages is not enabled yet, PUT if it is)
gh api -X POST repos/Magnus167/dev-tools-installer/pages -f build_type=workflow \
  || gh api -X PUT repos/Magnus167/dev-tools-installer/pages -f build_type=workflow
# 2. Only for releases created in the GitHub UI: release.yml deploys from main (it calls pages.yml via
#    workflow_call), but a UI-created release triggers pages.yml on its vX.Y.Z tag, which the github-pages
#    environment rejects unless tags may deploy. Create the environment first if it does not exist:
#    gh api -X PUT repos/Magnus167/dev-tools-installer/environments/github-pages
gh api -X POST repos/Magnus167/dev-tools-installer/environments/github-pages/deployment-branch-policies \
  -f name='v*' -f type=tag
# 3. Optional: deploy the current main as "dev" before any release
gh workflow run pages.yml
```

Cut a release from the Actions workflow (release notes are generated automatically from the merged changes):

```sh
gh workflow run release.yml -f version=vX.Y.Z
gh run watch
```

The workflow first builds everything with the version tagged locally at the commit (the same
`scripts/build-site.sh` run Pages does), checks `SHA256SUMS`, and runs `tests/parity.mjs` on the stamped page
against its own `install.sh` (install.sh runs only with `--print`/`--list`/`--help`). Then it creates a draft
release with generated notes, attaches `install.sh`, `tools.json`, `llms.txt` and `SHA256SUMS`, publishes it
(which creates the tag), and deploys GitHub Pages. If a run fails after the draft exists, run it again for the
same version: it reuses the draft. (A release created in the GitHub UI deploys Pages but gets no attached
files.)

Every release stays online at its own path, `https://magnus167.github.io/dev-tools-installer/vX.Y.Z/`. The
site root (and `/latest/`) is a small redirect page that sends the browser to the newest version's page and
keeps the `#combo` (so `https://magnus167.github.io/dev-tools-installer/#apt-1kx` opens `.../vX.Y.Z/#apt-1kx`);
without JavaScript a meta refresh and a plain link do the same. The root also serves the newest version's
`install.sh`, `tools.json` and `llms.txt` unversioned, with a `SHA256SUMS` over the files there. `scripts/build-site.sh` builds that tree from the git
tags and stamps each copy with its version and the tag's full commit sha (the page shows the version in the
footer; every generated script's header carries version, short commit, page link and source repo); a build
with no tags is labelled `dev`. Per version:

| File | What |
|---|---|
| `index.html` | the page |
| `install.sh` | the curl installer, generated from that version's page by `scripts/build-installer.mjs` |
| `tools.json` | machine-readable manifest: package managers, groups, tools, how each installs per package manager, combo format |
| `llms.txt` | how an AI assistant should answer with this site ([llms.txt](https://llmstxt.org) convention) |
| `SHA256SUMS` | sha256 of the four files above |

Tags from before the installer (v1.0.0) have only `index.html`. Each version's files are built by that
tag's own `scripts/build-installer.mjs`, so they do not change when the build scripts change later. Check a
download against the release:

```sh
curl -fsSLO https://magnus167.github.io/dev-tools-installer/vX.Y.Z/install.sh
gh release download vX.Y.Z --repo Magnus167/dev-tools-installer --pattern SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
```

## Tests

Nothing is ever installed on your machine: scripts are generated with plain Node (no dependencies) and every
install runs inside throwaway Docker containers. See [`tests/README.md`](tests/README.md).

```sh
node tests/gen.mjs index.html apt all             # print a script
node tests/gen.mjs index.html --combos            # combo IDs + encode/decode round-trip
node tests/parity.mjs index.html                  # install.sh --print == the page's script (about 1,300 selections)
tests/lint.sh index.html                          # page scripts parse, bash -n + shellcheck (Docker) incl. install.sh
tests/page-check.sh index.html                    # the page in headless Chromium (Docker): no errors, links, warnings
tests/installer-e2e.sh index.html                 # curl | bash and | sh installs + error paths, in containers
node scripts/build-installer.mjs index.html out/  # write install.sh, tools.json, llms.txt (as "dev")
tests/matrix.sh index.html --ids all --jobs 4 --timeout 60   # install everything in 11 distro containers
tests/matrix.sh index.html --ids all --timeout 60 --user --images ubuntu:24.04   # same, as a non-root sudo user
```

---
*Inspired by [Ninite](https://ninite.com). Not affiliated with or endorsed by Ninite or Secure By Design Inc.*
