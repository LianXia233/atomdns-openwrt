"""Headless check of the AtomDNS LuCI page, including the advanced panel."""
import os
import sys

from playwright.sync_api import sync_playwright

HOST = os.environ.get("ROUTER_HOST")
PASS = os.environ.get("ROUTER_PASS")
if not HOST or not PASS:
    sys.exit("set ROUTER_HOST and ROUTER_PASS first")
BASE = "http://" + HOST + "/cgi-bin/luci"
VIEW = BASE + "/admin/services/atomdns"

errors = []


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

        page.goto(BASE + "/", wait_until="domcontentloaded")
        if page.locator("#luci_password").count():
            page.fill("#luci_username", "root")
            page.fill("#luci_password", PASS)
            page.click("button[type=submit]")
            page.wait_for_load_state("networkidle")

        page.goto(VIEW, wait_until="domcontentloaded")
        page.wait_for_selector("text=高级设置", timeout=25000)

        body = page.inner_text("body")
        for key in ["AtomDNS", "运行中", "打开 WebUI", "5335", "9099", "v0.6.6",
                    "DNS 接管", "已接管", "高级设置", "运行模式", "RealIP",
                    "SOCKS5 代理", "保存并重启"]:
            print(("OK   " if key in body else "MISS ") + key)

        print("STATUS_TABLE:")
        print(page.inner_text("table").replace("\n", " | "))

        print("ADVANCED_INPUTS:", {
            "port": page.input_value("#atomdns-adv-port"),
            "mode": page.input_value("#atomdns-adv-mode"),
            "socks": page.input_value("#atomdns-adv-socks"),
        })

        print("--- 取消接管 ---")
        page.click("button:has-text('取消接管')")
        page.wait_for_selector("text=未接管", timeout=20000)
        print("RESTORE_UI_OK")

        print("--- 立即接管 ---")
        page.click("button:has-text('立即接管')")
        page.wait_for_selector("text=已接管", timeout=20000)
        print("APPLY_UI_OK")

        print("--- 保存并重启（值不变） ---")
        page.click("button:has-text('保存并重启')")
        page.wait_for_selector("text=已保存并重启 AtomDNS", timeout=30000)
        print("SAVE_UI_OK")
        page.wait_for_timeout(4000)
        print("STILL_RUNNING:", "运行中" in page.inner_text("body"))

        with page.expect_popup(timeout=8000) as popup:
            page.click("text=打开 WebUI")
        print("WEBUI_POPUP_URL:", popup.value.url)
        popup.value.close()

        print("JS_ERRORS:", errors if errors else "none")
        browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FAILED:", repr(exc))
        print("JS_ERRORS:", errors if errors else "none")
        sys.exit(1)
