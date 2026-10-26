"""Browser smoke test for Luna Studio (Playwright + Chromium).

Serves luna/dist with a plain HTTP server, then verifies:
 1. The page loads without fatal console errors.
 2. The editor textarea contains the default example and responds to input.
 3. Pressing Run compiles via the real compiler and shows Console output.
 4. A deliberately broken program shows visible diagnostics (no blank page).
 5. Switching examples updates the editor.
Exits non-zero on any failure.
"""
import sys, threading, http.server, functools, socketserver
from playwright.sync_api import sync_playwright

DIST = "/workspace/luna/dist"
PORT = 4174

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIST)
httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()

failures = []
def check(name, cond, extra=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name} {extra}")
    if not cond:
        failures.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")

    check("title is Luna Studio", page.title() == "Luna Studio", f"(actual: {page.title()!r})")
    check("heading visible", page.locator("h1", has_text="Luna Studio").count() >= 1)

    ta = page.locator("textarea.luna-input")
    check("editor exists", ta.count() == 1)
    initial = ta.input_value()
    check("default example loaded", 'title: "Hello"' in initial)
    ta.click()
    ta.press("End")
    page.keyboard.type("\n// typed by test")
    check("editor responds to typing", "// typed by test" in ta.input_value())

    page.locator("button.primary", has_text="Run").click()
    page.wait_for_timeout(800)
    body_text = page.locator(".console").inner_text() if page.locator(".console").count() else ""
    preview_ok = page.locator("iframe.preview-frame").count() == 1
    check("run produced success or preview", ("Compiled OK" in body_text) or preview_ok,
          f"(console: {body_text[:120]!r})")

    ta.fill("render {\n  <h1>{\n}\n")
    page.locator("button.primary", has_text="Run").click()
    page.wait_for_timeout(800)
    err_text = page.locator(".console").inner_text()
    check("broken code shows diagnostics", len(err_text.strip()) > 0 and ("error" in err_text.lower() or "failed" in err_text.lower()),
          f"(console: {err_text[:160]!r})")
    check("page still alive after bad input", page.locator("h1").count() >= 1)

    page.select_option("select", "counter")
    page.wait_for_timeout(300)
    check("counter example loads", "state count = 0" in ta.input_value())

    real_errors = [e for e in console_errors if "favicon" not in e.lower()]
    check("no fatal console errors", len(real_errors) == 0, f"(errors: {real_errors[:3]})")

    page.screenshot(path="/tmp/studio.png", full_page=False)
    browser.close()

httpd.shutdown()
if failures:
    print("SMOKE TEST FAILED:", failures)
    sys.exit(1)
print("ALL SMOKE CHECKS PASSED")
