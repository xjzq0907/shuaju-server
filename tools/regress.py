#!/usr/bin/env python3
"""管理台交互回归（只读安全版）：抽屉 / modal / 多选 / 分页 / 搜索 / 汉堡导航。
不点击任何会改数据的确认按钮（modal 一律点「取消」）。
用法：/vol2/@appshare/zcode/tools/venvs/pw/bin/python tools/regress.py [--url http://127.0.0.1:15006]
"""
import argparse
import sys

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:15006")
args = ap.parse_args()

results = []


def check(name, fn):
    try:
        fn()
        results.append(("PASS", name))
    except Exception as e:
        results.append(("FAIL", f"{name}: {type(e).__name__} {str(e)[:200]}"))


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- 概览：全局搜索出分组结果 ----
    page.goto(f"{args.url}/#/dashboard", wait_until="domcontentloaded")
    page.wait_for_timeout(1200)

    def t_search():
        page.fill("#gs-input", "苟在")
        page.wait_for_timeout(1200)
        assert page.locator("#gs-results .gs-group").count() >= 2, "搜索分组不足"
        assert page.locator("#gs-results .gs-item").count() >= 1, "无搜索结果"
        assert page.locator("#dash-main").is_hidden(), "搜索时仪表盘未隐藏"
    check("概览-全局搜索分组", t_search)

    def t_batch_date():
        page.fill("#gs-input", "")
        page.wait_for_timeout(800)
        txt = page.locator("#dash-batches").inner_text()
        assert "Invalid Date" not in txt, "批次日期仍为 Invalid Date"
        assert "20" in txt, "批次日期未渲染"
    check("概览-批次日期修复", t_batch_date)

    def t_batch_toggle():
        page.locator("#dash-batches .batch-item .head").first.click()
        page.wait_for_timeout(600)
        box = page.locator("#dash-batches .batch-log").first
        assert "hidden" not in (box.get_attribute("class") or ""), "日志未展开"
    check("概览-批次日志展开", t_batch_toggle)

    # ---- 剧库：卡片 → 抽屉 → 关闭；多选 opbar ----
    page.goto(f"{args.url}/#/library", wait_until="domcontentloaded")
    page.wait_for_timeout(1800)

    def t_drawer():
        page.locator("#lib-grid .card").first.click()
        page.wait_for_timeout(1000)
        assert "open" in (page.locator("#drawer").get_attribute("class") or ""), "抽屉未打开"
        assert page.locator("#drawer-content h2").count() == 1, "抽屉内容未渲染"
        assert page.locator("#drawer-content .d-ops button").count() >= 2, "操作按钮缺失"
        page.locator("#drawer-mask").click(position={"x": 10, "y": 10})
        page.wait_for_timeout(400)
        assert "open" not in (page.locator("#drawer").get_attribute("class") or ""), "抽屉未关闭"
    check("剧库-详情抽屉开合", t_drawer)

    def t_select_mode():
        page.click("#lib-select-btn")
        page.wait_for_timeout(300)
        assert page.locator("#lib-opbar").is_visible(), "批量操作条未显示"
        page.locator("#lib-grid .card").first.click()
        page.wait_for_timeout(200)
        assert "已选 1" in page.locator("#lib-sel-count").inner_text(), "计数未更新"
        page.click("#op-cancel")
        page.wait_for_timeout(300)
        assert page.locator("#lib-opbar").is_hidden(), "取消后操作条未隐藏"
    check("剧库-多选与操作条", t_select_mode)

    def t_modal_cancel():
        # 直接调用页面内 confirmBox，点「取消」——不产生任何数据变更
        page.evaluate("""() => new Promise(r => {
            import('/shared.js').then(m => {
                window.__modalResult = m.confirmBox('回归测试确认框（点取消）');
                r(true);
            });
        })""")
        page.wait_for_timeout(400)
        assert page.locator(".modal-mask.open").count() == 1, "modal 未打开"
        page.locator(".modal-mask .modal-ops button").first.click()  # 取消
        page.wait_for_timeout(300)
        res = page.evaluate("window.__modalResult.then(v => v)")
        assert res is False or res is None, f"modal 取消返回异常: {res}"
    check("全局-confirmBox取消", t_modal_cancel)

    # ---- 索引：搜索 + 分页 ----
    page.goto(f"{args.url}/#/index", wait_until="domcontentloaded")
    page.wait_for_timeout(800)

    def t_index():
        page.fill("#idx-search", "短剧")
        page.wait_for_timeout(1500)
        rows = page.locator("#idx-body tr").count()
        assert rows >= 1, "索引无结果"
        pager = page.locator("#idx-pager button")
        if pager.count() >= 2:
            page.locator("#idx-pager button").nth(1).click()  # 下一页
            page.wait_for_timeout(1200)
            assert page.locator("#idx-body tr").count() >= 1, "翻页后无数据"
    check("索引-搜索与分页", t_index)

    # ---- 队列：两栏渲染 ----
    page.goto(f"{args.url}/#/queue", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    def t_queue():
        assert page.locator("#pipeline-info").inner_text().strip() != "", "流水线信息为空"
        assert page.locator(".two-col .panel").count() >= 3, "两栏布局面板缺失"
        assert page.locator("#batch-list .batch-item").count() >= 1, "批次历史为空"
    check("队列-两栏与批次", t_queue)

    # ---- 设置：配置回填 + QR ----
    page.goto(f"{args.url}/#/settings", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    def t_settings():
        v = page.input_value("#cfg-lib")
        assert v.startswith("/"), f"运行配置未回填: {v!r}"
        assert page.locator("#qr-box img").count() == 1, "二维码未渲染"
        assert page.locator("#set-version").inner_text().strip() not in ("", "…"), "版本未加载"
    check("设置-配置回填与二维码", t_settings)

    def t_danger_modal():
        page.click("#clear-queue-btn")
        page.wait_for_timeout(400)
        assert page.locator(".modal-mask.open").count() == 1, "危险操作未走统一 modal"
        page.locator(".modal-mask .modal-ops button").first.click()  # 取消
        page.wait_for_timeout(300)
    check("设置-危险区modal可取消", t_danger_modal)

    # ---- 播放页：竖屏默认 + 方向切换 ----
    page.goto(f"{args.url}/#/dashboard", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    wid = page.evaluate("""async () => {
        const r = await fetch('/api/dramas?page_size=50');
        const j = await r.json();
        const d = j.items.find(x => x.download_state === 'done' && (x.episodes_local||0) >= 1);
        return d ? d.id : null;
    }""")

    def t_watch(wid=wid):
        assert wid, "无可用剧"
        page.goto(f"{args.url}/#/watch/{wid}/1", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        cls = page.locator("#player").get_attribute("class") or ""
        assert "wide" not in cls.split(), "默认应为竖屏框"
        page.click("#orient-btn")
        page.wait_for_timeout(300)
        cls2 = page.locator("#player").get_attribute("class") or ""
        assert "wide" in cls2.split(), "方向切换未生效"
        page.click("#orient-btn")
    check("播放-竖横屏默认与切换", t_watch)

    # ---- 移动端汉堡 ----
    m = browser.new_page(viewport={"width": 390, "height": 844})
    m.goto(f"{args.url}/#/dashboard", wait_until="domcontentloaded")
    m.wait_for_timeout(1000)

    def t_hamburger():
        assert m.locator("#hamburger").is_visible(), "汉堡按钮未显示"
        m.click("#hamburger")
        m.wait_for_timeout(400)
        assert "open" in (m.locator("#sidebar").get_attribute("class") or ""), "侧边栏未打开"
        assert m.locator("#side-mask").is_visible(), "遮罩未显示"
        m.locator("#side-mask").click(position={"x": 300, "y": 400})
        m.wait_for_timeout(400)
        assert "open" not in (m.locator("#sidebar").get_attribute("class") or ""), "侧边栏未关闭"
    check("移动-汉堡开合", t_hamburger)

    m.close()
    browser.close()

print()
fails = 0
for st, name in results:
    print(f"  {st}  {name}")
    if st == "FAIL":
        fails += 1
if errors:
    print("\n页面 JS 错误：")
    for e in dict.fromkeys(errors):
        print("  ", e)
    fails += 1
print(f"\n通过 {len(results) - fails}/{len(results)}")
sys.exit(1 if fails else 0)
