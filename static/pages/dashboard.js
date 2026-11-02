/* 仪表盘：统计卡 / 流水线状态 / 最近批次 / 全局搜索 */
import {
  $, esc, api, fmtGB, delegate,
  renderBatchItems, bindBatchToggle, togglePipelinePause,
} from "../shared.js";

let timer = null;
let statsAnimated = false; // 数字滚动/进度条生长只在首次渲染播放

export function cleanupDashboard() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function renderDashboard() {
  cleanupDashboard();
  $("#gs-results").innerHTML = "";
  $("#gs-results").classList.add("hidden");
  $("#dash-main").classList.remove("hidden");
  $("#gs-input").value = "";

  loadStats();
  loadPipeline();
  loadBatches();
  loadEvents();
  timer = setInterval(() => { loadStats(); loadPipeline(); loadEvents(); }, 15000);

  $("#dash-pause-btn").onclick = () => togglePipelinePause($("#dash-pause-btn"), loadPipeline);

  // 最近批次与搜索结果：委托只绑一次（容器持久，重复绑定会累积）
  bindBatchToggle($("#dash-batches"), "dash-blog");
  if (!window._gsBound) {
    window._gsBound = true;
    const box = $("#gs-results");
    delegate(box, "click", "[data-lib]", (e, el) => {
      window.__pendingDetail = +el.dataset.lib;
      location.hash = "#/library";
    });
    delegate(box, "click", "[data-idx]", () => {
      location.hash = "#/index";
      sessionStorage.setItem("idx_q", $("#gs-input").value.trim());
    });
  }

  const input = $("#gs-input");
  let t = null;
  input.oninput = () => { clearTimeout(t); t = setTimeout(() => doSearch(input.value.trim()), 400); };
  input.onkeydown = (e) => { if (e.key === "Enter") doSearch(input.value.trim()); };
  input.onblur = () => { if (!input.value.trim()) showDash(); };
  $("#gs-btn").onclick = () => doSearch(input.value.trim());
}

async function loadStats() {
  try {
    const s = await api("/api/stats");
    const total = s.disk_total_gb || 0;
    const usedPct = total ? Math.min(100, Math.round(((total - (s.disk_free_gb ?? 0)) / total) * 100)) : 0;
    const cls = usedPct > 92 ? "err" : usedPct > 75 ? "warn" : "";
    $("#stat-cards").innerHTML = `
      <div class="stat-card"><div class="label">已下载</div>
        <div class="value"><span data-count="${s.downloaded}">0</span><small> 部</small></div></div>
      <div class="stat-card"><div class="label">占用容量</div>
        <div class="value"><span data-count="${Math.round(s.size_mb / 1024 * 10) / 10}" data-dec="1">0</span><small> GB</small></div></div>
      <div class="stat-card"><div class="label">磁盘剩余 ${s.disk_free_gb ?? "?"} / ${total || "?"} GB</div>
        <div class="value"><span data-count="${usedPct}">0</span><small>% 已用</small></div>
        <div class="meter"><i class="${cls}" style="width:${statsAnimated ? usedPct : 0}%"></i></div></div>
      <div class="stat-card"><div class="label">队列中 / 失效链接</div>
        <div class="value"><span data-count="${s.queued}">0</span><small> / ${s.dead}</small></div></div>`;
    const animate = !statsAnimated;
    statsAnimated = true;
    $("#stat-cards").querySelectorAll("[data-count]").forEach((el) => countUp(el, animate));
    if (animate) {
      requestAnimationFrame(() =>
        $("#stat-cards").querySelectorAll(".meter i").forEach((m) => (m.style.width = usedPct + "%"))
      );
    }
  } catch {}
}

/** 数字滚动动画（600ms ease-out） */
function countUp(el, animate) {
  const target = Number(el.dataset.count) || 0;
  const dec = Number(el.dataset.dec) || 0;
  if (!animate) { el.textContent = target.toFixed(dec); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 600);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(dec);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function loadPipeline() {
  try {
    const p = await api("/api/pipeline");
    $("#dash-pause-btn").textContent = p.paused ? "▶ 恢复" : "⏸ 暂停";
    let html = p.paused
      ? '<span class="tag warn">已暂停</span>'
      : p.running
      ? '<span class="tag info">批次运行中</span>'
      : '<span class="tag ok">空闲</span>';
    const a = p.aria2;
    if (a) html += `<span class="muted">aria2：${(a.speed / 1048576).toFixed(1)} MB/s · 活动 ${a.active} · 排队 ${a.waiting}</span>`;
    if (p.batch) html += `<span class="muted">当前批次 #${p.batch.id}：转存 ${p.batch.saved} / ${p.batch.total}</span>`;
    $("#dash-pipeline").innerHTML = html;
    const logBox = $("#dash-batch-log");
    if (p.batch && (p.batch.log_lines || []).length) {
      logBox.textContent = p.batch.log_lines.join("\n");
      logBox.classList.remove("hidden");
    } else {
      logBox.classList.add("hidden");
    }
  } catch {}
}

async function loadBatches() {
  try {
    const b = await api("/api/batches?page_size=5");
    const el = $("#dash-batches");
    el.innerHTML = b.items.length
      ? renderBatchItems(b.items, "dash-blog")
      : '<span class="muted">暂无批次记录</span>';
  } catch {}
}

/** 埋点看板（FR-FUT-01）：近 7 天事件计数；旧服务端无此接口时静默 */
async function loadEvents() {
  try {
    const s = await api("/api/events/stats?days=7");
    const t = s.totals || {};
    const chips = [
      ["app_open", "启动"],
      ["feed_show", "刷到"],
      ["feed_open_full", "看完整版"],
      ["feed_dislike", "不想看"],
      ["player_enter", "进播放器"],
      ["player_resume", "断点恢复"],
      ["play_time", "时长上报"],
    ]
      .map(([k, label]) => `<span class="tag info">${label} ${t[k] || 0}</span>`)
      .join("");
    const mins = Math.round((s.play_seconds || 0) / 60);
    $("#dash-events").innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <span class="tag ok">活跃设备 ${s.devices || 0}</span>${chips}
        <span class="muted">累计播放 ${mins} 分钟 · 共 ${s.events_total || 0} 条</span>
      </div>`;
  } catch {
    /* 旧服务端无 /api/events/stats：保持占位文本 */
  }
}

/* ---- 全局搜索：本地库 + 全库索引 ---- */

function showDash() {
  $("#gs-results").classList.add("hidden");
  $("#dash-main").classList.remove("hidden");
}

async function doSearch(q) {
  if (!q) { showDash(); return; }
  const box = $("#gs-results");
  box.innerHTML = '<div class="muted p10">搜索中…</div>';
  box.classList.remove("hidden");
  $("#dash-main").classList.add("hidden");
  try {
    const [lib, idx] = await Promise.all([
      api(`/api/dramas?q=${encodeURIComponent(q)}&page_size=8`),
      api(`/api/index/search?q=${encodeURIComponent(q)}&page_size=10`),
    ]);
    let html = "";
    html += `<div class="gs-group"><h3>本地剧库（${lib.total}）</h3>`;
    html += lib.items.length
      ? lib.items
          .map(
            (d) => `<div class="gs-item" data-lib="${d.id}"><span class="t">${esc(d.title)}</span>
              <span class="muted">${d.episodes_local || d.episodes_expected || 0} 集</span>
              ${d.has_cover ? "" : '<span class="tag gray">无封面</span>'}</div>`
          )
          .join("")
      : '<div class="muted p48">本地没有，试试下面的索引结果直接入队下载</div>';
    html += "</div>";
    html += `<div class="gs-group"><h3>全库索引（${idx.total}）</h3>`;
    html += idx.items.length
      ? idx.items
          .map(
            (d) => `<div class="gs-item" data-idx="${d.id}"><span class="t">${esc(d.title)}</span>
              ${d.download_state === "done" ? '<span class="tag ok">已下载</span>' : ""}
              ${d.drive_state === "dead" ? '<span class="tag err">失效</span>' : ""}
              ${d.download_state === "queued" ? '<span class="tag info">队列中</span>' : ""}</div>`
          )
          .join("")
      : '<div class="muted p48">索引里也没有</div>';
    html += "</div>";
    box.innerHTML = html;
    // 点击行为由 renderDashboard 中的一次性委托处理
  } catch (e) {
    box.innerHTML = `<div class="muted p10">搜索失败：${esc(e.message)}</div>`;
  }
}
