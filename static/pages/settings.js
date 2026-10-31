/* 设置：关于 / 运行配置（数据库持久化）/ 手动同步 / 危险区 */
import { $, api, post, put, toast } from "../shared.js";

const CFG_FIELDS = {
  LIB_ROOT: "#cfg-lib",
  ARIA2_RPC: "#cfg-aria2",
  ARIA2_LIB_PATH: "#cfg-aria2lib",
  QUARK_AUTOSAVE_URL: "#cfg-quark",
  SAVE_ROOT: "#cfg-saveroot",
  BATCH_SIZE: "#cfg-batch",
};

export function renderSettings() {
  loadAbout();
  loadConfig();
  loadTrim();
  $("#cfg-save").onclick = saveConfig;
  $("#trim-reset-btn").onclick = async () => {
    if (!confirm("清空全部裁边分析结果，让后台线程全库重跑？（每部剧几秒，期间逐步出结果）")) return;
    try {
      const r = await api("/api/trim/reset", { method: "POST" });
      toast(`已重置 ${r.reset} 部，后台将逐步重新分析`);
      loadTrim();
    } catch (e) { toast(e.message, true); }
  };
  $("#cfg-reset").onclick = async () => {
    if (!confirm("清空所有页面配置，恢复 .env 环境默认值？")) return;
    try {
      await api("/api/settings", { method: "DELETE" });
      toast("已恢复环境默认");
      loadConfig();
    } catch (e) { toast(e.message, true); }
  };

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

/** 扫码配置：把当前站点地址画成二维码（App 首启扫码自动填） */
async function loadQr() {
  try {
    const svg = await fetch(`/api/qr.svg?data=${encodeURIComponent(location.origin)}`).then((r) => r.text());
    const box = $("#qr-box");
    box.innerHTML = svg;
    const el = box.querySelector("svg");
    if (el) {
      el.setAttribute("width", "132");
      el.setAttribute("height", "132");
    }
  } catch (_) {}
}

async function loadTrim() {
  try {
    const t = await api("/api/trim/stats");
    const pct = t.total ? Math.round((t.checked / t.total) * 100) : 0;
    $("#trim-progress").innerHTML = `<b>${t.checked}</b> / ${t.total} 部${t.total && t.checked < t.total ? ' <span class="tag info">分析中</span>' : ' <span class="tag ok">完成</span>'}`;
    $("#trim-detected").innerHTML = `${t.detected} 部检出重叠 <span class="muted">（已自动裁边）</span>`;
    $("#trim-disabled").innerHTML = t.disabled
      ? `${t.disabled} 部`
      : '<span class="muted">无</span>';
    const m = $("#trim-meter");
    m.style.width = "0";
    requestAnimationFrame(() => (m.style.width = pct + "%"));
  } catch (e) {
    $("#trim-progress").textContent = "获取失败";
  }
}

async function loadAbout() {
  loadQr();
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
    // 部署级路径（只读展示）
    const dep = $("#set-deploy");
    if (dep) {
      dep.innerHTML = `<span class="k">部署路径</span>
        <span style="word-break:break-all;font-size:11px">索引 ${a.quark_links_dir} · 数据 ${a.data_dir}</span>`;
    }
  } catch (e) {
    $("#set-version").textContent = "获取失败";
  }
}

async function loadConfig() {
  try {
    const s = await api("/api/settings");
    for (const [k, sel] of Object.entries(CFG_FIELDS)) $(sel).value = s[k] ?? "";
  } catch (e) {
    toast("运行配置加载失败：" + e.message, true);
  }
}

async function saveConfig() {
  const body = {};
  for (const [k, sel] of Object.entries(CFG_FIELDS)) {
    const raw = $(sel).value.trim();
    body[k] = k === "BATCH_SIZE" ? Number(raw) : raw;
  }
  try {
    await put("/api/settings", body);
    toast("配置已保存并生效");
    loadConfig();
    loadAbout(); // 库目录状态可能变化
  } catch (e) {
    toast("保存失败：" + e.message, true);
  }
}
