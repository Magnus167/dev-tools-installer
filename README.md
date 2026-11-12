# dev-tools-installer

A quick one-command installer for common Linux dev tools (Ninite-inspired).

**Live site: https://magnus167.github.io/dev-tools-installer/**

Pick your package manager (apt, dnf, apk, pacman, zypper, or legacy yum), tick the tools you want, and
paste the generated bash script into a fresh box. It installs what your distro packages natively, fetches
the rest from each project's official releases into `~/.local/bin`, and can wire up your `.bashrc`/`.zshrc`.
Every step skips tools already on your `PATH`, so re-running is safe. The whole app is one static
`index.html` with no backend; the only build step is stamping the release version into it (see Releases).

Your picks are encoded in a **combo ID** (for example `apt-1kx`) kept in the page URL, so a link always
reproduces the same selection. Tools a package manager can't install are greyed out with the reason and
left out of the script.

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
never reorder or delete entries) and place it in `GROUPS` wherever it should appear on the page.

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

The release workflow then deploys GitHub Pages. Every release stays online at its own path,
`https://magnus167.github.io/dev-tools-installer/vX.Y.Z/`, and the site root (and `/latest/`) serves the newest
one. `scripts/build-site.sh` builds that tree from the git tags and stamps each copy with its version (the
page shows it in the footer and in every generated script's header); a build with no tags is labelled `dev`.

## Tests

Nothing is ever installed on your machine: scripts are generated with plain Node (no dependencies) and every
install runs inside throwaway Docker containers. See [`tests/README.md`](tests/README.md).

```sh
node tests/gen.mjs index.html apt all             # print a script
node tests/gen.mjs index.html --combos            # combo IDs + encode/decode round-trip
tests/lint.sh index.html                          # bash -n on every script, shellcheck (in Docker)
tests/matrix.sh index.html --ids all --jobs 4 --timeout 60   # install everything in 11 distro containers
tests/matrix.sh index.html --ids all --timeout 60 --user --images ubuntu:24.04   # same, as a non-root sudo user
```

---
*Inspired by [Ninite](https://ninite.com). Not affiliated with or endorsed by Ninite or Secure By Design Inc.*
