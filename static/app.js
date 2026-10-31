/* 管理台入口：hash 路由 + 顶栏统计。页面实现见 pages/*.js */
import { $, refreshTopStats } from "./shared.js";
import { renderDashboard, cleanupDashboard } from "./pages/dashboard.js";
import { renderLibrary, cleanupLibrary } from "./pages/library.js";
import { renderIndex } from "./pages/index.js";
import { renderQueue, cleanupQueue } from "./pages/queue.js";
import { renderSettings } from "./pages/settings.js";
import { renderWatch } from "./pages/watch.js";

const routes = {
  dashboard: { render: renderDashboard, cleanup: cleanupDashboard },
  library: { render: renderLibrary, cleanup: cleanupLibrary },
  index: { render: renderIndex },
  queue: { render: renderQueue, cleanup: cleanupQueue },
  watch: { render: renderWatch },
  settings: { render: renderSettings },
};

let curCleanup = null;

function router() {
  if (curCleanup) { curCleanup(); curCleanup = null; }
  const hash = location.hash.slice(2) || "dashboard";
  const [page, ...rest] = hash.split("/");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll("#topbar nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === page)
  );
  const view = $("#view-" + page);
  if (view) view.classList.remove("hidden");
  const r = routes[page] || routes.dashboard;
  r.render(rest);
  curCleanup = r.cleanup || null;
}

window.addEventListener("hashchange", router);

refreshTopStats();
setInterval(refreshTopStats, 30000);
router();
