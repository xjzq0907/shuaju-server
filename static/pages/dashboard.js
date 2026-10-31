/* 仪表盘：统计卡 / 流水线状态 / 最近批次 / 全局搜索 */
import { $, esc, api, post, fmtGB, toast } from "../shared.js";

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
  timer = setInterval(() => { loadStats(); loadPipeline(); }, 15000);

  $("#dash-pause-btn").onclick = async () => {
    const cur = $("#dash-pause-btn").textContent.includes("暂停");
    await post("/api/pipeline/pause", { paused: cur });
    loadPipeline();
  };

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
    if (!b.items.length) { el.innerHTML = '<span class="muted">暂无批次记录</span>'; return; }
    el.innerHTML = b.items
      .map(
        (x) => `<div class="batch-item"><div class="head" data-bid="${x.id}">
          <span class="tag ${x.status === "done" ? "ok" : x.status === "running" ? "info" : "err"}">#${x.id} ${x.status}</span>
          <span class="muted" style="font-size:12px">${new Date(x.created_at * 1000).toLocaleString("zh-CN")}</span>
          <span style="font-size:12px">共 ${x.total} · 转存 ${x.saved} · 失效 ${x.dead} · 失败 ${x.failed}</span>
        </div><div class="batch-log hidden" id="dash-blog-${x.id}"></div></div>`
      )
      .join("");
    el.querySelectorAll(".head").forEach((h) => {
      h.onclick = async () => {
        const box = $("#dash-blog-" + h.dataset.bid);
        if (box.classList.contains("hidden")) {
          if (!box.textContent) {
            const bd = await api(`/api/batches/${h.dataset.bid}`);
            box.textContent = bd.log_lines.join("\n");
          }
          box.classList.remove("hidden");
        } else box.classList.add("hidden");
      };
    });
  } catch {}
}

/* ---- 全局搜索：本地库 + 全库索引 ---- */

function showDash() {
  $("#gs-results").classList.add("hidden");
  $("#dash-main").classList.remove("hidden");
}

async function doSearch(q) {
  if (!q) { showDash(); return; }
  const box = $("#gs-results");
  box.innerHTML = '<div class="muted" style="padding:10px">搜索中…</div>';
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
      : '<div class="muted" style="padding:4px 8px;font-size:13px">本地没有，试试下面的索引结果直接入队下载</div>';
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
      : '<div class="muted" style="padding:4px 8px;font-size:13px">索引里也没有</div>';
    html += "</div>";
    box.innerHTML = html;
    box.querySelectorAll("[data-lib]").forEach((el) => {
      el.onclick = () => { window.__pendingDetail = +el.dataset.lib; location.hash = "#/library"; };
    });
    box.querySelectorAll("[data-idx]").forEach((el) => {
      el.onclick = () => { location.hash = "#/index"; sessionStorage.setItem("idx_q", q); };
    });
  } catch (e) {
    box.innerHTML = `<div class="muted" style="padding:10px">搜索失败：${esc(e.message)}</div>`;
  }
}
