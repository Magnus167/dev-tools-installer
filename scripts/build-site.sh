#!/usr/bin/env bash
# Build the static site into <outdir>.
#   <outdir>/vX.Y.Z/index.html       for every vX.Y.Z tag containing index.html
#   <outdir>/vX.Y.Z/install.sh, tools.json, llms.txt, SHA256SUMS
#                                    for tags that also have scripts/build-installer.mjs (v1.1.0 on);
#                                    each is built by that tag's own build-installer.mjs, so a published
#                                    version's files do not change when the build scripts do later
#   <outdir>/ (root), <outdir>/latest/   copies of the highest semver tag's files (root /llms.txt too)
# Every copy is stamped with its version (__APP_VERSION__) and the full sha of the tag's commit
# (__APP_COMMIT__). With no usable tags, root is built from the working tree as version "dev".
# Needs git, node (for the installer files), sed and sha256sum.
set -euo pipefail

out="${1:?usage: build-site.sh <outdir>}"
FILES="index.html install.sh tools.json llms.txt"

rm -rf "$out"
mkdir -p "$out"
touch "$out/.nojekyll"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

render() { # render <version> <commit> <dest> ; reads HTML on stdin
  sed -e "s/__APP_VERSION__/$1/g" -e "s/__APP_COMMIT__/$2/g" > "$3"
}

installer() { # installer <dir with scripts/build-installer.mjs> <version dir holding the rendered index.html>
  node "$1/scripts/build-installer.mjs" "$2/index.html" "$2" >/dev/null
  # shellcheck disable=SC2086 # FILES is a fixed list of plain names
  if (cd "$2" && grep -q '__APP_VERSION__\|__APP_COMMIT__' $FILES); then
    echo "error: unreplaced placeholder in $2" >&2; exit 1
  fi
  # shellcheck disable=SC2086
  (cd "$2" && sha256sum $FILES > SHA256SUMS)
}

latest=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  if ! git cat-file -e "${tag}:index.html" 2>/dev/null; then
    echo "skip ${tag}: no index.html at that tag"
    continue
  fi
  commit="$(git rev-parse "${tag}^{commit}")"
  mkdir -p "$out/$tag"
  git show "${tag}:index.html" | render "$tag" "$commit" "$out/$tag/index.html"
  if git cat-file -e "${tag}:scripts/build-installer.mjs" 2>/dev/null; then
    mkdir -p "$work/$tag"
    git archive "$tag" scripts | tar -x -C "$work/$tag"
    installer "$work/$tag" "$out/$tag"
    echo "built ${tag} (${commit:0:7}): page, installer, tools.json, llms.txt, SHA256SUMS"
  else
    echo "built ${tag} (${commit:0:7}): page only (no installer at that tag)"
  fi
  latest="$tag"   # tags are listed in ascending version order
done < <(git tag --list 'v*' | sort -V)

if [[ -n "$latest" ]]; then
  for f in $FILES SHA256SUMS; do
    if [[ -f "$out/$latest/$f" ]]; then cp "$out/$latest/$f" "$out/$f"; fi
  done
  echo "root = ${latest}"
else
  [[ -f index.html ]] || { echo "error: no release tags and no index.html in working tree" >&2; exit 1; }
  render dev dev "$out/index.html" < index.html
  if [[ -f scripts/build-installer.mjs ]]; then installer . "$out"; fi
  echo "no release tags; root built from working tree as dev"
fi
mkdir -p "$out/latest"
for f in $FILES SHA256SUMS; do
  if [[ -f "$out/$f" ]]; then cp "$out/$f" "$out/latest/$f"; fi
done
