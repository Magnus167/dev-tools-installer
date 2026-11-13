# page_check.py: load the page in headless Chromium (inside Docker, see page-check.sh) and check that it
# runs: no script errors, every tool rendered, combo links preselect, the commands are right (including
# Alpine's and a combo that spells a tool id), and a link from a newer version shows its warning.
# Serves /site (a directory with index.html) on 127.0.0.1:8000. Exit 1 on any failure.
import socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

srv = subprocess.Popen(["python3", "-m", "http.server", "8000", "--bind", "127.0.0.1", "-d", "/site"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(50):
    try:
        socket.create_connection(("127.0.0.1", 8000), 0.2).close(); break
    except OSError:
        time.sleep(0.1)
URL = "http://127.0.0.1:8000/index.html"
fails = []
def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        pg.on("console", lambda m: errs.append(f"console {m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        def load(hash=""):
            pg.goto("about:blank"); pg.goto(URL + hash); pg.wait_for_timeout(150)
        def picked():
            return sorted(pg.eval_on_selector_all(".tool input:checked", "e => e.map(i => i.value)"))

        load()
        if not pg.evaluate("Boolean(window.__boots)"):
            ok(False, "the page script ran (window.__boots exists)" + "".join("\n  " + e for e in errs))
            raise SystemExit(1)
        nt = pg.evaluate("window.__boots.TOOLS.length")
        here = pg.evaluate("window.__boots.SITE_HERE")
        site = pg.evaluate("window.__boots.SITE")
        ok(pg.locator(".tool input").count() == nt, f"{nt} tool checkboxes rendered")
        ok(pg.locator("#newer").is_hidden(), "no newer-version warning on a plain load")
        ok("not with sudo" in pg.locator("#l-cmd").inner_text(), "the install command says: not with sudo")

        combo = pg.evaluate("window.__boots.encode('apt', new Set(['git', 'docker', 'node']), false)")
        load("#" + combo)
        ok(picked() == ["docker", "git", "node"], f"#{combo} preselects git, docker, node: {picked()}")
        ok(pg.locator("#oneliner").inner_text() == f"curl -fsSL {here}install.sh | bash -s -- {combo}", "one-liner: " + pg.locator("#oneliner").inner_text())
        ok(pg.locator("#printcmd").inner_text() == f"curl -fsSL {here}install.sh | bash -s -- --print {combo}", "view-first command")

        load("#apt-jq")   # a real combo (git, python, fzf, jq, rust) whose digits spell a tool id
        ok(pg.locator("#oneliner").inner_text().endswith("| bash -s -- apt-0jq"), "combo spelling a tool id gets a 0: " + pg.locator("#oneliner").inner_text())
        ok(pg.locator("#printcmd").inner_text().endswith("--print apt-0jq"), "and so does its --print command")

        apk = pg.evaluate("window.__boots.encode('apk', new Set(['git', 'jq']), false)")
        load("#" + apk)
        ok(f"| sh -s -- {apk}" in pg.locator("#oneliner").inner_text(), "apk installs through sh")
        ok(pg.locator("#printcmd").inner_text().endswith(f"| bash -s -- --print {apk}"), "apk's view-first command uses bash")
        note = pg.locator("#printnote")
        ok("any machine with bash" in note.inner_text() and (note.locator("a").get_attribute("href") or "").endswith("#" + apk), "apk note: any machine with bash, or the page link")

        newer = pg.evaluate("'apt-' + ((1n << BigInt(window.__boots.TOOLS.length + 1)) | 2n).toString(36)")
        load("#" + newer)
        bar = pg.locator("#newer")
        ok(bar.is_visible() and "newer version" in bar.inner_text(), "newer-version warning visible: " + bar.inner_text())
        ok(bar.locator("a").get_attribute("href") == site + "#" + newer, "warning links the latest version with the same combo")
        ok(picked() == ["git"], f"the picks this version knows are still loaded: {picked()}")

        ok(not errs, "no script errors" + ("".join("\n  " + e for e in errs)))
        b.close()
except SystemExit:
    pass
except Exception as e:  # a check that could not run counts as a failure
    ok(False, f"check crashed: {e}")
finally:
    srv.terminate()
print(f"PAGE CHECK {'FAILED' if fails else 'OK'} ({len(fails)} failures)")
sys.exit(1 if fails else 0)
