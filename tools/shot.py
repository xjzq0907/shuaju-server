#!/usr/bin/env python3
"""管理台截图工具：6 路由 × 2 视口批量截图 + 控制台错误采集。

用 venv 里的 python 运行（playwright 装在那里）：
    /vol2/@appshare/zcode/tools/venvs/pw/bin/python tools/shot.py [--url http://127.0.0.1:15006] [--out /tmp/shuaju-shots] [--tag before]

产出：
    <out>/<tag>-<序号>-<路由>-<视口>.png
    控制台/页面 JS 错误打印到 stdout（自审用）
"""
import argparse
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ROUTES = ["dashboard", "library", "index", "queue", "settings"]
VIEWPORTS = {"d": {"width": 1440, "height": 900}, "m": {"width": 390, "height": 844}}


def pick_watch_target(base):
    """找一部已下载的剧做播放页截图目标。"""
    try:
        with urllib.request.urlopen(f"{base}/api/dramas?page_size=50", timeout=6) as r:
            items = json.load(r).get("items", [])
        for d in items:
            if d.get("download_state") == "done" and (d.get("episodes_local") or 0) >= 1:
                return d["id"], d.get("last_episode") or 1
    except Exception as e:
        print(f"[warn] 取播放目标失败: {e}")
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:15006")
    ap.add_argument("--out", default="/tmp/shuaju-shots")
    ap.add_argument("--tag", default="shot")
    args = ap.parse_args()

    wid, wep = pick_watch_target(args.url)
    routes = list(ROUTES)
    if wid:
        routes.append(f"watch/{wid}/{wep}")
    else:
        routes.append("watch")  # 无可用剧时至少验证视图不崩

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vp_name, vp in VIEWPORTS.items():
            ctx = browser.new_context(viewport=vp, device_scale_factor=1)
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
            page.on(
                "console",
                lambda m: errors.append(f"[console.{m.type}] {m.text}")
                if m.type in ("error", "warning")
                else None,
            )
            for i, route in enumerate(routes, 1):
                url = f"{args.url}/#/{route}"
                page.goto(url, wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(1500)
                path = f"{args.out}/{args.tag}-{i:02d}-{route.split('/')[0]}-{vp_name}.png"
                page.screenshot(path=path, full_page=True)
                print(f"✓ {path}")
            ctx.close()
        browser.close()

    if errors:
        print("\n=== 页面错误 ===")
        for e in dict.fromkeys(errors):  # 去重保序
            print(e)
        sys.exit(2)
    print("无页面错误")


if __name__ == "__main__":
    main()
