"""Home-screen icons from public/logo.svg (run by scripts/icons.sh in the test container)."""
from playwright.sync_api import sync_playwright

svg = open("/app/logo.svg", encoding="utf-8").read()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for name, size in [("apple-touch-icon.png", 180), ("icon-512.png", 512)]:
        page = browser.new_page(viewport={"width": size, "height": size})
        # square, no rounded corners: the phone rounds (and masks) the icon itself
        square = svg.replace(' rx="14"', "").replace("<svg ", f'<svg width="{size}" height="{size}" ')
        page.set_content('<body style="margin:0;background:#0c0e13">' + square + "</body>")
        page.screenshot(path=f"/out/{name}")
        page.close()
    browser.close()
