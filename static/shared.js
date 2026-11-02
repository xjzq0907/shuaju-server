/* 共享工具：DOM / 转义 / 格式化 / toast / modal / fetch 封装（token 由 auth.js 全局注入） */
export const $ = (s) => document.querySelector(s);
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtGB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB");

/** 秒级/毫秒级时间戳 → "2026-11-02 14:30"（防 Invalid Date，异常返回 —） */
export function fmtDate(ts) {
  if (!ts) return "—";
  let n = Number(ts);
  if (!isFinite(n) || n <= 0) return "—";
  if (n < 1e12) n *= 1000; // 秒 → 毫秒
  const d = new Date(n);
  if (isNaN(d.getTime())) return "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toast(msg, isErr, retry) {
  const t = $("#toast");
  t.innerHTML = "";
  t.append(msg);
  if (retry) {
    const b = document.createElement("button");
    b.textContent = "重试";
    b.onclick = () => { t.classList.add("hidden"); retry(); };
    t.append(b);
  }
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

/** 事件委托：root 内匹配 selector 的元素触发 type 时调用 handler(event, el) */
export function delegate(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  });
}

/* ---- 详情抽屉（全局唯一，开合与关闭绑定在此） ---- */
export function openDrawer() {
  $("#drawer").classList.add("open");
  $("#drawer-mask").classList.add("open");
}
export function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-mask").classList.remove("open");
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-mask").addEventListener("click", closeDrawer);

let modalMask = null;

/**
 * 统一弹窗（替换原生 confirm）。
 * modal({ title, body, actions: [{ text, style, value }] }) → Promise(value)
 * 默认 actions = 取消(false) / 确定(true)，确定可带 danger 样式。
 */
export function modal({ title, body = "", actions, danger = false }) {
  return new Promise((resolve) => {
    if (!modalMask) {
      modalMask = document.createElement("div");
      modalMask.className = "modal-mask";
      document.body.append(modalMask);
    }
    const acts = actions || [
      { text: "取消", value: false },
      { text: "确定", value: true, style: danger ? "danger" : "primary" },
    ];
    modalMask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-ops"></div>
      </div>`;
    const ops = modalMask.querySelector(".modal-ops");
    const done = (v) => {
      modalMask.classList.remove("open");
      setTimeout(() => { modalMask.innerHTML = ""; }, 180);
      resolve(v);
    };
    acts.forEach((a) => {
      const b = document.createElement("button");
      b.textContent = a.text;
      if (a.style) b.className = a.style;
      b.onclick = () => done(a.value);
      ops.append(b);
    });
    // 点遮罩与 Esc 取消
    modalMask.onclick = (e) => { if (e.target === modalMask) done(undefined); };
    const onKey = (e) => {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); done(undefined); }
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => modalMask.classList.add("open"));
    ops.lastChild?.focus();
  });
}

/** Promise 版确认框：confirmBox("确定…？", { danger: true }) → true/false */
export const confirmBox = (msg, { okText = "确定", danger = true } = {}) =>
  modal({ title: "请确认", body: esc(msg), danger, actions: [
    { text: "取消", value: false },
    { text: okText, value: true, style: danger ? "danger" : "primary" },
  ] });

export async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
export const put = (path, body) =>
  api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
export const patch = (path, body) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 顶栏统计行 + 队列角标（各页共用） */
export async function refreshTopStats() {
  try {
    const s = await api("/api/stats");
    const text = `已下载 ${s.downloaded} 部 · ${fmtGB(s.size_mb)} · 磁盘剩 ${s.disk_free_gb ?? "?"} GB`;
    const slot = $("#stats-text") || $("#stats-line");
    if (slot) slot.textContent = text;
    const b = $("#queue-badge");
    b.textContent = s.queued;
    b.classList.toggle("hidden", s.queued === 0);
  } catch {}
}

/** 简单分页控件：renderPager(el, page, pages, go(page)) */
export function renderPager(el, page, pages, go) {
  el.innerHTML = "";
  if (pages <= 1) return;
  const prev = document.createElement("button");
  prev.textContent = "上一页";
  prev.disabled = page <= 1;
  prev.onclick = () => go(page - 1);
  const next = document.createElement("button");
  next.textContent = "下一页";
  next.disabled = page >= pages;
  next.onclick = () => go(page + 1);
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = `${page} / ${pages}`;
  el.append(prev, label, next);
}

/* ---- 批次列表（dashboard / queue 共用） ---- */

const batchTag = (s) => `tag ${s === "done" ? "ok" : s === "running" ? "info" : "err"}`;

/** 渲染批次条目；prefix 用于日志框 id（两页 DOM 并存，需各自唯一） */
export function renderBatchItems(items, prefix) {
  return items
    .map(
      (b) => `<div class="batch-item"><div class="head" data-bid="${b.id}">
        <span class="${batchTag(b.status)}">#${b.id} ${b.status}</span>
        <span class="muted small">${fmtDate(b.started_at)}</span>
        <span class="small">共 ${b.total} · 转存 ${b.saved} · 已在库 ${b.up_to_date ?? 0} · 失效 ${b.dead} · 失败 ${b.failed} · 推送 ${b.files_pushed ?? 0} 文件</span>
      </div><div class="batch-log hidden" id="${prefix}-${b.id}"></div></div>`
    )
    .join("");
}

/** 批次条目点击展开日志（事件委托；容器持久，只绑一次） */
export function bindBatchToggle(container, prefix) {
  if (container._batchBound) return; // 防止多次进入页面累积监听
  container._batchBound = prefix;
  delegate(container, "click", ".batch-item .head", async (e, h) => {
    const box = container.querySelector(`#${prefix}-${h.dataset.bid}`);
    if (!box) return;
    if (box.classList.contains("hidden")) {
      if (!box.textContent) {
        try {
          const bd = await api(`/api/batches/${h.dataset.bid}`);
          box.textContent = bd.log_lines.join("\n");
        } catch (err) {
          box.textContent = "日志加载失败：" + err.message;
        }
      }
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
    }
  });
}

/** 流水线暂停/恢复按钮（dashboard 与 queue 共用） */
export async function togglePipelinePause(btn, after) {
  const cur = btn.textContent.includes("暂停");
  await post("/api/pipeline/pause", { paused: cur });
  if (after) after();
}
