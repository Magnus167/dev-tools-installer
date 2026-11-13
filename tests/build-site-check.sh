#!/usr/bin/env bash
# build-site-check.sh: build the site from a throwaway clone of this repo with the working tree committed on top
# and tagged as a fake v1.2.0 (next to the real tags), then check the tree scripts/build-site.sh makes:
#   - root and latest/ index.html are redirect pages to <SITE>v1.2.0/ (JS, meta refresh, canonical, plain link)
#   - root and latest/ serve v1.2.0's install.sh, tools.json, llms.txt; sha256sum -c passes in root, latest/, v1.2.0/
#   - in headless Chromium (Docker, PW_IMAGE as in page-check.sh), <SITE>#<combo> becomes <SITE>v1.2.0/#<combo>
#     and that page loads with no errors and preselects the combo. Requests to <SITE> are answered from the
#     built tree, so the absolute /dev-tools-installer/ paths behave as on GitHub Pages.
# Nothing is installed on the host; the clone and the build live in a temp dir. Exit non-zero on failure.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMG="${PW_IMAGE:-mcr.microsoft.com/playwright/python:v1.49.0-noble}"
TAG=v1.2.0
W="$(mktemp -d "${TMPDIR:-/tmp}/sitecheck.XXXXXX")"
trap 'rm -rf "$W"' EXIT

git clone -q "$ROOT" "$W/repo"
git -C "$ROOT" tag --list 'v*' | while read -r t; do git -C "$W/repo" tag -f "$t" "$(git -C "$ROOT" rev-parse "$t^{commit}")" >/dev/null; done
(cd "$ROOT" && git ls-files -co --exclude-standard -z) | (cd "$ROOT" && xargs -0 -I{} cp --parents {} "$W/repo/" 2>/dev/null || true)
git -C "$W/repo" add -A
git -C "$W/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "working tree"
git -C "$W/repo" tag "$TAG"
(cd "$W/repo" && bash scripts/build-site.sh "$W/site")

S="$W/site"; fails=0
ok() { if eval "$1"; then echo "PASS $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
SITE="$(sed -n 's|^ *const SITE = "\(https://[^"]*/\)";.*|\1|p' "$S/$TAG/index.html" | head -n1)"
for d in "" latest/; do
  ok "grep -q 'location.replace(\"${SITE}${TAG}/\" + location.search + location.hash)' '$S/${d}index.html'" "${d:-root }index.html redirects (JS) to ${SITE}${TAG}/"
  ok "grep -q 'http-equiv=\"refresh\" content=\"0; url=${SITE}${TAG}/\"' '$S/${d}index.html'" "${d:-root }meta refresh"
  ok "grep -q 'rel=\"canonical\" href=\"${SITE}${TAG}/\"' '$S/${d}index.html' && grep -q '>Go to ${TAG}<' '$S/${d}index.html'" "${d:-root }canonical and plain link"
  ok "! grep -q window.__boots '$S/${d}index.html'" "${d:-root }index.html is the stub, not the page"
  for f in install.sh tools.json llms.txt; do ok "cmp -s '$S/$TAG/$f' '$S/$d$f'" "${d:-root }$f = $TAG's"; done
  ok "(cd '$S/$d' && sha256sum -c --quiet SHA256SUMS) && [ \$(wc -l < '$S/${d}SHA256SUMS') = 4 ]" "${d:-root }SHA256SUMS checks (4 files)"
done
ok "(cd '$S/$TAG' && sha256sum -c --quiet SHA256SUMS)" "$TAG/SHA256SUMS checks"
ok "[ -f '$S/v1.0.0/index.html' ] && [ -f '$S/v1.1.0/install.sh' ]" "older versions still built"
ok "grep -q '\"site\": \"$SITE\"' '$S/$TAG/tools.json' && grep -q '\"site_version\": \"$SITE$TAG/\"' '$S/$TAG/tools.json'" "tools.json site (bare) and site_version"
ok "grep -q '^Site: $SITE ' '$S/$TAG/llms.txt'" "llms.txt Site: line is the bare site"

chmod -R a+rX "$W/site"
cat > "$W/redirect.py" <<'PY'
import os, sys, mimetypes
from playwright.sync_api import sync_playwright
SITE, TAG = sys.argv[1], sys.argv[2]
fails = []
def ok(c, m):
    print(("PASS " if c else "FAIL ") + m)
    if not c: fails.append(m)
def serve(route):
    path = route.request.url[len(SITE):].split("#")[0].split("?")[0]
    f = os.path.join("/site", path)
    if os.path.isdir(f): f = os.path.join(f, "index.html")
    if not os.path.isfile(f): return route.fulfill(status=404, body="not found")
    route.fulfill(status=200, body=open(f, "rb").read(), content_type=mimetypes.guess_type(f)[0] or "text/html")
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route(SITE + "**", serve)
    pg.route(SITE.rstrip("/"), serve)
    for start in ["", "latest/"]:
        errs.clear()
        combo = "apt-1kx"
        pg.goto(SITE + start + "#" + combo); pg.wait_for_url(SITE + TAG + "/#" + combo, timeout=5000); pg.wait_for_timeout(300)
        ok(pg.url == SITE + TAG + "/#" + combo, f"{SITE}{start}#{combo} -> {pg.url}")
        ok(pg.evaluate("Boolean(window.__boots) && window.__boots.VERSION") == TAG, "the versioned page ran")
        ok(pg.locator(".tool input:checked").count() > 0, "the combo preselected tools")
        ok(not errs, "no errors" + "".join("\n  " + e for e in errs))
    pg.goto(SITE + "?x=1#apt-1kx"); pg.wait_for_url(SITE + TAG + "/?x=1#apt-1kx", timeout=5000)
    ok(True, "query and hash kept: " + pg.url)
    nojs = b.new_page(java_script_enabled=False); nojs.route(SITE + "**", serve)
    nojs.goto(SITE); nojs.wait_for_url(SITE + TAG + "/", timeout=5000)
    ok(nojs.url == SITE + TAG + "/", "without JS the meta refresh goes to " + nojs.url)
    b.close()
sys.exit(1 if fails else 0)
PY
docker run --rm -v "$W/site:/site:ro" -v "$W/redirect.py:/redirect.py:ro" "$IMG" bash -c \
  'python3 -c "import playwright" 2>/dev/null || pip install -q --break-system-packages playwright==1.49.0 >/dev/null 2>&1; python3 /redirect.py "$0" "$1"' \
  "$SITE" "$TAG" || fails=$((fails + 1))
echo "$fails failure(s)"
[ "$fails" = 0 ]
