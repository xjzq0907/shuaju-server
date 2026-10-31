/* 共享工具：DOM / 转义 / 格式化 / toast / fetch 封装（token 由 auth.js 全局注入） */
export const $ = (s) => document.querySelector(s);
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtGB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB");

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
export const patch = (path, body) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 顶栏统计行 + 队列角标（各页共用） */
export async function refreshTopStats() {
  try {
    const s = await api("/api/stats");
    $("#stats-line").textContent =
      `已下载 ${s.downloaded} 部 · ${fmtGB(s.size_mb)} · 磁盘剩 ${s.disk_free_gb ?? "?"} GB`;
    const b = $("#queue-badge");
    b.textContent = s.queued;
    b.classList.toggle("hidden", s.queued === 0);
  } catch {}
}
