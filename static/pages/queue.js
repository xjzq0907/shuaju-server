/* 下载队列：流水线状态 / 队列项 / 批次历史（两栏布局） */
import {
  $, esc, api, toast, delegate,
  renderBatchItems, bindBatchToggle, togglePipelinePause,
} from "../shared.js";

let pollTimer = null;

export function cleanupQueue() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function renderQueue() {
  $("#pause-btn").onclick = () => togglePipelinePause($("#pause-btn"), loadQueue);

  // 事件委托只绑一次（容器持久）
  bindBatchToggle($("#batch-list"), "q-blog");
  if (!$("#queue-list")._delegated) {
    $("#queue-list")._delegated = true;
    delegate($("#queue-list"), "click", "button[data-qid]", async (e, b) => {
      try {
        await api(`/api/queue/${b.dataset.qid}`, { method: "DELETE" });
        loadQueue();
      } catch (err) { toast(err.message, true); }
    });
  }

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
  ql.innerHTML = q.items.length
    ? q.items
        .map(
          (it) => `<div class="q-item">
            <span class="tag ${it.status === "running" ? "info" : "gray"}">${it.status}</span>
            <span class="grow">${esc(it.title)}</span>
            <span class="muted">${it.episodes_expected || "?"} 集</span>
            <button class="danger" data-qid="${it.id}">移除</button>
          </div>`
        )
        .join("")
    : '<span class="muted">队列为空</span>';

  const bl = $("#batch-list");
  bl.innerHTML = batches.items.length
    ? renderBatchItems(batches.items, "q-blog")
    : '<span class="muted">暂无批次</span>';

  // 有活动时保持轮询，空闲时降频
  if (pipe.running || q.items.length) {
    if (!pollTimer) pollTimer = setInterval(loadQueue, 3000);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
