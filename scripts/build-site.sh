#!/usr/bin/env bash
# Build the static site into <outdir>.
#   <outdir>/vX.Y.Z/index.html  for every vX.Y.Z tag containing index.html
#   <outdir>/index.html         copy of the highest semver tag
#   <outdir>/latest/index.html  copy of root
# With no usable tags, root is built from the working tree with version "dev".
set -euo pipefail

out="${1:?usage: build-site.sh <outdir>}"
placeholder='__APP_VERSION__'

rm -rf "$out"
mkdir -p "$out"
touch "$out/.nojekyll"

render() { # render <version> <dest> ; reads HTML on stdin
  sed "s/${placeholder}/$1/g" > "$2"
}

latest=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  if ! git cat-file -e "${tag}:index.html" 2>/dev/null; then
    echo "skip ${tag}: no index.html at that tag"
    continue
  fi
  mkdir -p "$out/$tag"
  git show "${tag}:index.html" | render "$tag" "$out/$tag/index.html"
  echo "built ${tag}"
  latest="$tag"   # tags are listed in ascending version order
done < <(git tag --list 'v*' | sort -V)

mkdir -p "$out/latest"
if [[ -n "$latest" ]]; then
  cp "$out/$latest/index.html" "$out/index.html"
  echo "root = ${latest}"
else
  [[ -f index.html ]] || { echo "error: no release tags and no index.html in working tree" >&2; exit 1; }
  render dev "$out/index.html" < index.html
  echo "no release tags; root built from working tree as dev"
fi
cp "$out/index.html" "$out/latest/index.html"
