/* 管理台入口：hash 路由 + 侧边栏导航 + 页头标题 + 顶栏统计。页面实现见 pages/*.js */
import { $, refreshTopStats } from "./shared.js";
import { renderDashboard, cleanupDashboard } from "./pages/dashboard.js";
import { renderLibrary, cleanupLibrary } from "./pages/library.js";
import { renderIndex } from "./pages/index.js";
import { renderQueue, cleanupQueue } from "./pages/queue.js";
import { renderSettings } from "./pages/settings.js";
import { renderWatch, cleanupWatch } from "./pages/watch.js";

const routes = {
  dashboard: { title: "概览", render: renderDashboard, cleanup: cleanupDashboard },
  library: { title: "剧库", render: renderLibrary, cleanup: cleanupLibrary },
  index: { title: "索引", render: renderIndex },
  queue: { title: "队列", render: renderQueue, cleanup: cleanupQueue },
  watch: { title: "播放", render: renderWatch, cleanup: cleanupWatch },
  settings: { title: "设置", render: renderSettings },
};

let curCleanup = null;

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#side-mask").classList.remove("open");
}

function router() {
  if (curCleanup) { curCleanup(); curCleanup = null; }
  const hash = location.hash.slice(2) || "dashboard";
  const [page, ...rest] = hash.split("/");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === page)
  );
  const view = $("#view-" + page);
  if (view) view.classList.remove("hidden");
  const r = routes[page] || routes.dashboard;
  const title = r.title || "概览";
  $("#ph-title").textContent = title;
  document.title = `${title} · Shuaju 管理台`;
  r.render(rest);
  curCleanup = r.cleanup || null;
  closeSidebar();
}

/* 移动端侧边栏抽屉 */
$("#hamburger").addEventListener("click", () => {
  $("#sidebar").classList.toggle("open");
  $("#side-mask").classList.toggle("open");
});
$("#side-mask").addEventListener("click", closeSidebar);

window.addEventListener("hashchange", router);

refreshTopStats();
setInterval(refreshTopStats, 30000);
router();
