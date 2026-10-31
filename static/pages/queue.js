/* 下载队列：流水线状态 / 队列项 / 批次历史 */
import { $, esc, api, post, toast } from "../shared.js";

let pollTimer = null;

export function cleanupQueue() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function renderQueue() {
  $("#pause-btn").onclick = async () => {
    const cur = $("#pause-btn").textContent.includes("暂停");
    await post("/api/pipeline/pause", { paused: cur });
    loadQueue();
  };
  loadQueue();
}

async function loadQueue() {
  const [pipe, q, batches] = await Promise.all([
    api("/api/pipeline"),
    api("/api/queue"),
    api("/api/batches?page_size=15"),
  ]);

  $("#pause-btn").textContent = pipe.paused ? "▶ 恢复" : "⏸ 暂停";
  const a = pipe.aria2;
  let html = pipe.paused
    ? '<span class="tag warn">已暂停</span> '
    : pipe.running
    ? '<span class="tag info">批次运行中</span> '
    : '<span class="tag ok">空闲</span> ';
  if (a) html += `aria2：${(a.speed / 1048576).toFixed(1)} MB/s · 活动 ${a.active} · 排队 ${a.waiting} · 已停止 ${a.stopped}`;
  $("#pipeline-info").innerHTML = html;
  if (pipe.batch) {
    $("#pipeline-info").innerHTML +=
      `<div class="log-live">${(pipe.batch.log_lines || []).map(esc).join("\n") || "…"}</div>`;
  }

  const ql = $("#queue-list");
  if (!q.items.length) {
    ql.innerHTML = '<span class="muted">队列为空</span>';
  } else {
    ql.innerHTML = q.items
      .map(
        (it) => `<div class="q-item">
          <span class="tag ${it.status === "running" ? "info" : "gray"}">${it.status}</span>
          <span class="grow">${esc(it.title)}</span>
          <span class="muted">${it.episodes_expected || "?"} 集</span>
          <button class="danger" data-qid="${it.id}">移除</button>
        </div>`
      )
      .join("");
    ql.querySelectorAll("button.danger").forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/queue/${b.dataset.qid}`, { method: "DELETE" });
          loadQueue();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  const bl = $("#batch-list");
  bl.innerHTML = batches.items.length
    ? batches.items
        .map(
          (b) => `<div class="batch-item">
            <div class="head" data-bid="${b.id}">
              <span class="tag ${b.status === "done" ? "ok" : b.status === "running" ? "info" : "err"}">#${b.id} ${b.status}</span>
              <span class="muted">${new Date(b.created_at * 1000).toLocaleString("zh-CN")}</span>
              <span>共 ${b.total} · 转存 ${b.saved} · 已在库 ${b.up_to_date} · 失效 ${b.dead} · 失败 ${b.failed} · 推送 ${b.files_pushed} 文件</span>
            </div>
            <div class="batch-log hidden" id="blog-${b.id}"></div>
          </div>`
        )
        .join("")
    : '<span class="muted">暂无批次</span>';
  bl.querySelectorAll(".head").forEach((h) => {
    h.onclick = async () => {
      const el = $("#blog-" + h.dataset.bid);
      if (el.classList.contains("hidden")) {
        if (!el.textContent) {
          const bd = await api(`/api/batches/${h.dataset.bid}`);
          el.textContent = bd.log_lines.join("\n");
        }
        el.classList.remove("hidden");
      } else el.classList.add("hidden");
    };
  });

  // 有活动时保持轮询，空闲时降频
  if (pipe.running || q.items.length) {
    if (!pollTimer) pollTimer = setInterval(loadQueue, 3000);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
