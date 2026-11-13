#!/usr/bin/env bash
# page-check.sh <html | site dir>: load the page in headless Chromium, in Docker (tests/page_check.py).
# PW_IMAGE picks the image (default: the official Playwright Python image; the matching playwright
# package is pip-installed inside the container if the image lacks it). Exit non-zero on failure.
set -u
SRC="${1:?usage: page-check.sh <html | site dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="${PW_IMAGE:-mcr.microsoft.com/playwright/python:v1.49.0-noble}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/pagecheck.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
if [ -d "$SRC" ]; then cp -r "$SRC"/. "$DIR/"; else cp "$SRC" "$DIR/index.html"; fi
chmod -R a+rX "$DIR"
docker run --rm -v "$DIR:/site:ro" -v "$HERE:/t:ro" "$IMG" bash -c \
  'python3 -c "import playwright" 2>/dev/null || pip install -q --break-system-packages playwright==1.49.0 >/dev/null 2>&1; python3 /t/page_check.py'
