"""Drives the real page in Chromium, Firefox and WebKit (run by browsers.sh inside the Playwright image).

Checks per browser: the page loads without errors, plays, what comes out matches the curve on the
graph for every starting point, a share link reopens as the identical sound, editing works, files
export. Chromium only: the room matching with a fake microphone that plays test/out/room.wav
(a 100 Hz hum over brown rumble).  Screenshots land in test/out/.
"""
import functools
import http.server
import json
import socket
import sys
import threading

from playwright.sync_api import sync_playwright

PORT = 8765
URL = f"http://localhost:{PORT}/"
OUT = "/test/out"


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory="/app")
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


class Fail(Exception):
    pass


def check(cond, message):
    if not cond:
        raise Fail(message)


# What should be playing, per band, in the graph's unit (all layers, at full movement level).
EXPECTED_JS = """async () => {
  const { layerDisplayDb, BAND_FREQS } = await import('./js/dsp/curve.js');
  const m = window.murmur;
  return BAND_FREQS.map((centre) => {
    let sum = 0;
    for (let i = -4; i <= 4; i++) {
      const f = centre * 2 ** (i / 27);
      sum += m.preset.layers.reduce((p, l, k) => p + 10 ** (layerDisplayDb(l, m.norms[k], f) / 10), 0);
    }
    return 10 * Math.log10(sum / 9);
  });
}"""
# Average of what the analyser reports over ~2 s.
MEASURE_JS = """async () => {
  const m = window.murmur, n = 31, sum = new Float64Array(n), buf = new Float32Array(n);
  let count = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const b = m.engine.spectrum(buf);
    if (!b) continue;
    for (let k = 0; k < n; k++) sum[k] += 10 ** (b[k] / 10);
    count++;
  }
  return count ? Array.from(sum, (s) => 10 * Math.log10(s / count)) : null;
}"""


def run(pw, name):
    args = []
    if name == "chromium":
        args = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={OUT}/room.wav"]
    browser = getattr(pw, name).launch(args=args)
    context = browser.new_context(viewport={"width": 1100, "height": 900}, accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("() => window.murmur && window.murmur.preset")
    check(page.evaluate("murmur.preset.name") == "Pink", "starts with Pink")
    page.screenshot(path=f"{OUT}/{name}-start.png", full_page=True)

    # play
    page.click("#play")
    page.wait_for_function("() => murmur.engine.playing && murmur.engine.ctx.state === 'running'", timeout=10000)
    page.wait_for_timeout(1500)
    check(page.get_attribute("#play", "aria-pressed") == "true", "play button shows playing")

    # every starting point: what plays is what the graph shows
    names = page.evaluate("Array.from(document.querySelectorAll('#builtins .chip'), (c) => c.textContent)")
    check(len(names) >= 14, f"starting points: {names}")
    worst = 0
    for i, preset_name in enumerate(names):
        page.locator("#builtins .chip").nth(i).click()
        page.wait_for_timeout(900)
        expected = page.evaluate(EXPECTED_JS)
        measured = page.evaluate(MEASURE_JS)
        check(measured, f"{preset_name}: nothing playing")
        moving = page.evaluate("murmur.preset.layers.some((l) => l.move)")
        if "-v" in sys.argv:
            print(f"    {preset_name}: " + " ".join(f"{m - e:+.1f}" for m, e in zip(measured, expected)))
        for b in range(10, 29):  # 200 Hz ... 12.5 kHz
            if expected[b] < -75:
                continue  # in a cut or a deep notch: neighbouring bins leak in, not meaningful
            d = measured[b] - expected[b]
            if moving:
                check(d < 3.5, f"{preset_name} band {b}: {d:+.1f} dB above its peak (moving)")
            else:
                worst = max(worst, abs(d))
                check(abs(d) < 3.5, f"{preset_name} band {b}: {d:+.1f} dB off the curve")
    print(f"  {name}: {len(names)} starting points play as drawn (worst steady band {worst:.1f} dB off)")

    # shape: sliders, layers, dragging on the graph
    page.click("#t-shape")
    page.locator("#layers .chip").first.wait_for()
    page.evaluate(
        "murmur.setPreset({name: 'Test', layers: [{slope: 0, level: -6, width: 1, lowCut: 20, highCut: 20000}]}, {selected: 0})")
    box = page.locator("#graph").bounding_box()
    x = box["x"] + box["width"] * 0.6
    page.mouse.move(x, box["y"] + box["height"] * 0.5)
    page.mouse.down()
    page.mouse.move(x, box["y"] + box["height"] * 0.3, steps=6)
    page.mouse.up()
    eq = page.evaluate("murmur.preset.layers[0].eq")
    check(max(eq) >= 8 and eq[0] == 0, f"dragging up raises the curve there: {eq}")
    page.locator("#layer-controls input[type=range]").first.fill("-6")
    check(page.evaluate("murmur.preset.layers[0].slope") == -6, "colour slider sets the slope")
    page.get_by_text("+ Add layer").click()
    check(page.evaluate("murmur.preset.layers.length") == 2 and page.evaluate("murmur.selected") == 1, "layer added and selected")
    page.get_by_role("button", name="Waves").click()
    moved = page.evaluate("murmur.preset.layers[1]")
    check(moved["move"] and moved["rest"]["level"] == moved["level"] - 18, f"Waves starts a movement with a quieter rest state: {moved['rest']}")
    # the rest state is shaped with the same tools: sliders and the graph
    page.get_by_role("button", name="Rest", exact=True).click()
    check(page.evaluate("murmur.editing") == "rest", "now shaping the rest state")
    page.locator("#layer-controls input[type=range]").first.fill("-8")
    both = page.evaluate("[murmur.preset.layers[1].slope, murmur.preset.layers[1].rest.slope]")
    check(both == [-3, -8], f"the colour slider changes only the rest state: {both}")
    box = page.locator("#graph").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.4, steps=4)
    page.mouse.up()
    eqs = page.evaluate("[Math.max(...murmur.preset.layers[1].eq), Math.max(...murmur.preset.layers[1].rest.eq)]")
    check(eqs[0] == 0 and eqs[1] >= 4, f"dragging on the graph bends only the rest state: {eqs}")
    # draw the cycle
    cyc = page.locator("canvas.cycle").bounding_box()
    page.mouse.move(cyc["x"] + 2, cyc["y"] + cyc["height"] - 8)
    page.mouse.down()
    page.mouse.move(cyc["x"] + cyc["width"] * 0.5, cyc["y"] + 8, steps=12)
    page.mouse.up()
    drawn = page.evaluate("murmur.preset.layers[1].move.cycle")
    check(drawn[0] <= 5 and drawn[8] >= 95 and all(a <= b for a, b in zip(drawn[:8], drawn[1:9])), f"drawing a ramp on the cycle: {drawn}")
    check(page.get_by_role("button", name="Waves").get_attribute("aria-pressed") == "false", "a drawn cycle is no longer the Waves pattern")
    page.get_by_role("button", name="Peak", exact=True).click()
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/{name}-moving.png")
    page.check("#advanced", force=True)
    page.get_by_text("Add notch or peak").click()
    check(page.evaluate("murmur.preset.layers[1].notches.length") == 1, "notch added")
    page.evaluate("window.scrollTo(0, 0)")
    # the notch on the graph: hover shows its grips, dragging a grip or scrolling changes the width
    spot = page.evaluate("(() => { const g = murmur.graph, n = g.layer.notches[0], r = g.canvas.getBoundingClientRect(); const [x, y] = g.notchXY(n); return [x + r.left, y + r.top]; })()")
    page.mouse.move(spot[0], spot[1])
    check(page.evaluate("murmur.graph.active") == 0, "hovering a notch selects it")
    grip = page.evaluate("(() => { const g = murmur.graph, r = g.canvas.getBoundingClientRect(); const [x, y] = g.gripXY(g.layer.notches[0])[1]; return [x + r.left, y + r.top]; })()")
    page.mouse.move(grip[0], grip[1])
    page.mouse.down()
    page.mouse.move(grip[0] + 60, grip[1], steps=4)
    page.mouse.up()
    wide = page.evaluate("murmur.preset.layers[1].notches[0].width")
    check(wide > 0.9, f"dragging a grip outwards widens the notch: {wide}")
    check(page.evaluate("murmur.preset.layers[1].notches[0].f") == 1000, "the grip leaves the frequency alone")
    page.mouse.move(spot[0], spot[1])
    page.mouse.wheel(0, 200)
    narrow = page.evaluate("murmur.preset.layers[1].notches[0].width")
    check(narrow < wide, f"scrolling over the notch changes its width: {wide} -> {narrow}")
    page.mouse.move(spot[0], spot[1])
    page.mouse.down()
    page.mouse.move(spot[0] + 40, spot[1] - 30, steps=4)
    page.mouse.up()
    moved = page.evaluate("murmur.preset.layers[1].notches[0]")
    check(moved["f"] > 1100 and moved["gain"] > -24 and moved["width"] == narrow, f"dragging the circle moves it: {moved}")
    for _ in range(9):
        if page.get_by_text("Add notch or peak").is_visible():
            page.get_by_text("Add notch or peak").click()
    check(page.evaluate("murmur.preset.layers[1].notches.length") == 8, "up to eight notches per layer")
    check(page.locator("details.notch").count() == 8 and page.locator("details.notch[open]").count() <= 2, "notch rows are compact")
    page.locator("details.notch summary button").last.click()
    check(page.evaluate("murmur.preset.layers[1].notches.length") == 7, "a notch can be removed from its row")
    box = page.locator("#graph").bounding_box()
    check(box["y"] >= 0 and box["y"] < 40, f"the graph stays in view while the panel below scrolls: y {box['y']}")
    page.focus("#graph")
    page.keyboard.press("ArrowUp")
    check(page.evaluate("murmur.preset.layers[1].eq[17]") == 1, "keyboard bends the curve")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/{name}-shape.png", full_page=True)
    page.fill("#name", "Büro <b>test</b>")
    edited = page.evaluate("murmur.preset")

    # save, share
    page.click("#t-sounds")
    page.click("#save")
    check(page.locator("#mine .chip").count() == 1, "saved to My sounds")
    page.click("#t-share")
    link = page.input_value("#link")
    check("#p=" in link and len(link) < 400, f"link: {link}")
    check(page.locator("#qr svg path").count() == 1, "QR code drawn")
    page.screenshot(path=f"{OUT}/{name}-share.png", full_page=True)
    with page.expect_download() as dl:
        page.click("#export-json")
    exported = json.load(open(dl.value.path(), encoding="utf-8"))
    check(exported["preset"] == edited, "exported file holds the sound")
    page.select_option("#wav-seconds", "30")
    with page.expect_download(timeout=60000) as dl:
        page.click("#export-wav")
    wav = open(dl.value.path(), "rb").read()
    check(wav[:4] == b"RIFF" and abs(len(wav) - 44 - 30 * 48000 * 4) < 20000, f"wav of {len(wav)} bytes")

    # the link in a fresh browser profile: same sound, shown as shared, name as plain text
    other = browser.new_context(viewport={"width": 390, "height": 800}, device_scale_factor=2)
    page2 = other.new_page()
    page2.on("pageerror", lambda e: errors.append("shared page: " + str(e)))
    # the link points at the public address; open its sound on the copy under test
    check(link.startswith("https://murmur.kemmerling.me/#p="), f"link uses the public address: {link}")
    page2.goto(URL + link[link.index("#"):])
    page2.wait_for_function("() => window.murmur && window.murmur.preset")
    check(page2.evaluate("murmur.preset") == edited, "the link reopens as the identical sound")
    check("Büro <b>test</b>" in page2.inner_text("#shared-text"), "banner shows the name as text")
    check(page2.locator("#shared-text b").count() == 0, "the name is not parsed as markup")
    check("#p=" not in page2.url, "the address is tidied after loading")
    page2.screenshot(path=f"{OUT}/{name}-phone-shared.png", full_page=True)
    page2.goto(URL + "#p=AQID")
    page2.wait_for_function("() => document.getElementById('toast').classList.contains('show')")
    check("not a sound" in page2.inner_text("#toast"), "a broken link says so")
    page2.goto(URL + "#p=CQE")
    page2.wait_for_function("() => document.getElementById('toast').textContent.includes('newer')")
    check("newer version" in page2.inner_text("#toast"), "a link from a newer version says so")
    for tab in ["shape", "room", "tinnitus", "timer"]:
        page2.click(f"#t-{tab}")
        page2.wait_for_timeout(150)
        page2.screenshot(path=f"{OUT}/{name}-phone-{tab}.png", full_page=True)
    check(page2.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no sideways scrolling on a phone")
    other.close()

    # tinnitus: tone, then a sound around it
    page.click("#t-tinnitus")
    page.click("#tone-play")
    page.wait_for_timeout(300)
    page.fill("#tone-f", "700")
    f = page.evaluate("murmur.engine.osc.frequency.value")
    check(not page.evaluate("murmur.engine.playing"), "noise pauses while the tone plays")
    page.click("#tone-notch")
    notch = page.evaluate("murmur.preset.layers[0].notches[0]")
    check(abs(notch["f"] - 250 * 64 ** 0.7) < 30 and notch["gain"] == -48, f"notch at the tone: {notch} (tone {f})")
    page.wait_for_function("() => murmur.engine.playing")

    # timers
    page.click("#t-timer")
    page.get_by_role("button", name="15 min").click()
    check("Sleep in 1" in page.inner_text("#timer-chip"), "sleep timer runs")
    page.click("#timer-cancel")
    check(page.locator("#timer-chip").is_hidden(), "timer cancelled")
    page.click("#focus-start")
    check("Focus 2" in page.inner_text("#timer-status"), "focus timer runs")
    page.click("#play")
    check(page.locator("#timer-chip").is_hidden(), "pausing ends the timer")

    plain_http(browser, name)

    if name == "chromium":
        room(page)
    else:
        page.click("#t-room")

    page.screenshot(path=f"{OUT}/{name}-end.png", full_page=True)
    check(not errors, "console errors: " + " | ".join(errors))
    browser.close()


def plain_http(browser, name):
    """The page on a plain http address that is not localhost (like http://noise.home): browsers
    offer no AudioWorklet and no microphone there. It must still play, and say why the mic is off."""
    context = browser.new_context()
    page = context.new_page()
    problems = []
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(f"http://{socket.gethostname()}:{PORT}/")
    page.wait_for_function("() => window.murmur && window.murmur.preset")
    check(not page.evaluate("window.isSecureContext"), "test address is not a secure context")
    check(page.locator("#unsupported").is_hidden(), "no 'browser too old' message")
    page.get_by_role("button", name="White").click()
    page.wait_for_function("() => murmur.engine.playing && murmur.engine.ctx.state === 'running'", timeout=10000)
    check(not page.evaluate("'audioWorklet' in murmur.engine.ctx && !!murmur.engine.ctx.audioWorklet"), "really without AudioWorklet")
    page.wait_for_timeout(900)
    expected = page.evaluate(EXPECTED_JS)
    measured = page.evaluate(MEASURE_JS)
    check(measured, "plain http: nothing playing")
    worst = max(abs(measured[b] - expected[b]) for b in range(10, 29))
    check(worst < 3.5, f"plain http: {worst:.1f} dB off the curve")
    page.click("#t-room")
    check("https" in page.inner_text("#room-problem") and page.is_disabled("#room-listen"), "room tab explains the missing microphone")
    check(not problems, "plain http errors: " + " | ".join(problems))
    context.close()
    print(f"  {name}: plays on plain http without AudioWorklet (worst band {worst:.1f} dB off)")


def room(page):
    """Fake microphone: brown rumble with a 100 Hz hum, 10 s quiet then 10 s louder, looping."""
    page.click("#t-room")
    check(page.locator("#room-problem").is_hidden(), "microphone available on localhost")
    page.select_option("#room-seconds", "10")
    page.click("#room-listen")
    page.wait_for_selector("#mic:not([hidden])")
    page.wait_for_selector("#room-result:not([hidden])", timeout=30000)
    check(page.locator("#mic").is_hidden(), "microphone released after listening")
    heard = page.inner_text("#room-heard")
    check("rumble" in heard and "100 Hz" in heard, f"heard: {heard}")
    page.click("#room-new")
    layer = page.evaluate("murmur.preset.layers[0]")
    check(layer["slope"] <= -4, f"mask is dark like the room: slope {layer['slope']}")
    check(any(abs(n["f"] - 100) < 6 and n["gain"] > 0 for n in layer["notches"]), f"mask covers the hum: {layer['notches']}")
    page.fill("#room-strength", "0")
    flat = page.evaluate("murmur.preset.layers[0].eq")
    check(not any(flat), "strength 0 leaves only the colour")
    page.fill("#room-strength", "1")
    page.wait_for_function("() => murmur.engine.playing")
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/chromium-room.png", full_page=True)

    # follow the room: the fake microphone does not hear our output, so the check passes;
    # then the mask must rise when the room gets louder
    page.check("#adapt")
    page.wait_for_function("() => document.getElementById('adapt-status').textContent.startsWith('Following')", timeout=15000)
    offsets = []
    for _ in range(50):
        page.wait_for_timeout(500)
        offsets.append(page.evaluate("murmur.adaptive.offset"))
    check(max(offsets) - min(offsets) > 3, f"mask follows the room's level: {min(offsets):.1f} .. {max(offsets):.1f} dB")
    check(max(offsets) <= 8 and min(offsets) >= -8, "within its limits")
    page.click("#mic-stop")
    check(page.locator("#mic").is_hidden() and not page.is_checked("#adapt"), "stop button ends listening")
    print(f"  chromium: room matched ({heard}); following moved the mask {min(offsets):+.1f} .. {max(offsets):+.1f} dB")


def main():
    serve()
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or ["chromium", "firefox", "webkit"]
    failed = False
    with sync_playwright() as pw:
        for name in names:
            try:
                run(pw, name)
                print(f"ok   {name}")
            except Exception as e:  # noqa: BLE001 - report and go on with the next browser
                failed = True
                print(f"FAIL {name}: {e}")
    sys.exit(1 if failed else 0)


main()
