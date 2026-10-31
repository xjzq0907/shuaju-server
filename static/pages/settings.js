/* 设置：关于（版本/环境）/ 手动同步 / 危险区 */
import { $, api, post, toast } from "../shared.js";

export function renderSettings() {
  loadAbout();
  document.querySelectorAll("[data-sync]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await post("/api/sync", { scope: b.dataset.sync });
        const box = $("#sync-result");
        box.textContent = JSON.stringify(r, null, 2);
        box.classList.remove("hidden");
      } catch (e) {
        toast("同步失败：" + e.message, true);
      } finally {
        b.disabled = false;
      }
    };
  });
  $("#clear-queue-btn").onclick = async () => {
    if (!confirm("清空所有等待中的下载队列项？")) return;
    try {
      const q = await api("/api/queue");
      let n = 0;
      for (const it of q.items) {
        try { await api(`/api/queue/${it.id}`, { method: "DELETE" }); n++; } catch {}
      }
      toast(`已清空 ${n} 项`);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

async function loadAbout() {
  try {
    const a = await api("/api/about");
    $("#set-version").textContent = a.version;
    $("#set-auth").innerHTML = a.auth_enabled
      ? '<span class="tag ok">已启用</span>'
      : '<span class="tag gray">未启用</span>';
    $("#set-csv").innerHTML = a.csv_ready
      ? '<span class="tag ok">就绪</span>'
      : '<span class="tag warn">未找到</span>';
    $("#set-lib").innerHTML = a.lib_exists
      ? '<span class="tag ok">存在</span>'
      : '<span class="tag warn">未挂载</span>';
  } catch (e) {
    $("#set-version").textContent = "获取失败";
  }
}
