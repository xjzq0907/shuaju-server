/* 短剧库 SPA —— hash 路由 + fetch API，无构建 */
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtGB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB");

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const patch = (path, body) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------- 路由 ---------- */

const routes = { library: renderLibrary, index: renderIndex, queue: renderQueue, watch: renderWatch };
let pollTimer = null;

function router() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const hash = location.hash.slice(2) || "library";
  const [page, ...rest] = hash.split("/");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll("#topbar nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === page)
  );
  const view = $("#view-" + page);
  if (view) view.classList.remove("hidden");
  (routes[page] || renderLibrary)(rest);
}

window.addEventListener("hashchange", router);

/* ---------- 顶栏统计 ---------- */

async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("#stats-line").textContent =
      `已下载 ${s.downloaded} 部 · ${fmtGB(s.size_mb)} · 磁盘剩 ${s.disk_free_gb ?? "?"} GB`;
    const b = $("#queue-badge");
    b.textContent = s.queued;
    b.classList.toggle("hidden", s.queued === 0);
  } catch {}
}

/* ---------- 剧库页 ---------- */

const libState = { page: 1, pageSize: 24 };

async function loadLibrary() {
  const q = $("#lib-search").value.trim();
  const state = $("#lib-state").value;
  const sort = $("#lib-sort").value;
  const data = await api(
    `/api/dramas?q=${encodeURIComponent(q)}&state=${state}&sort=${sort}&page=${libState.page}&page_size=${libState.pageSize}`
  );
  $("#lib-count").textContent = `共 ${data.total} 部`;

  const grid = $("#lib-grid");
  grid.innerHTML = "";
  for (const d of data.items) {
    const eps = d.episodes_local ?? 0;
    const card = document.createElement("div");
    card.className = "card";
    const coverUrl = d.has_cover ? djToken.with(`/api/dramas/${d.id}/cover`) : null;
    card.innerHTML = `
      <div class="cover" ${coverUrl ? `style="background-image:url('${coverUrl}')"` : ""}>${coverUrl ? "" : "📺"}</div>
      <div class="meta">
        <div class="t">${esc(d.title)}</div>
        <div class="s">
          ${eps ? `${eps} 集` : '<span class="tag err">未下载</span>'}
          ${d.size_mb ? " · " + fmtGB(d.size_mb) : ""}
          ${d.watch_state === "watching" ? ' · <span class="tag info">在看</span>' : ""}
          ${d.watch_state === "watched" ? ' · <span class="tag ok">看完</span>' : ""}
        </div>
      </div>`;
    card.onclick = () => openDetail(d.id);
    grid.appendChild(card);
  }

  const pg = $("#lib-pager");
  const pages = Math.max(1, Math.ceil(data.total / libState.pageSize));
  pg.innerHTML = "";
  if (pages > 1) {
    const prev = document.createElement("button");
    prev.textContent = "上一页";
    prev.disabled = libState.page <= 1;
    prev.onclick = () => { libState.page--; loadLibrary(); };
    const next = document.createElement("button");
    next.textContent = "下一页";
    next.disabled = libState.page >= pages;
    next.onclick = () => { libState.page++; loadLibrary(); };
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${libState.page} / ${pages}`;
    pg.append(prev, label, next);
  }
}

function renderLibrary() {
  loadLibrary();
  let t = null;
  $("#lib-search").oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { libState.page = 1; loadLibrary(); }, 300);
  };
  $("#lib-state").onchange = $("#lib-sort").onchange = () => { libState.page = 1; loadLibrary(); };
}

/* ---------- 剧集详情弹窗 ---------- */

async function openDetail(id) {
  const d = await api(`/api/dramas/${id}`);
  const have = new Set(d.episodes.map((e) => e.ep));
  const epsHtml =
    d.episodes.length === 0
      ? '<p class="muted">未下载，可加入下载队列</p>'
      : `<div class="ep-grid">${d.episodes
          .map((e) => `<button data-ep="${e.ep}">${e.ep}</button>`)
          .join("")}</div>` +
        (d.missing.length
          ? `<p class="muted" style="margin-top:8px">缺集：${d.missing.join("、")}</p>`
          : "");
  $("#modal-content").innerHTML = `
    <h2>${esc(d.title)}</h2>
    <div class="kv">
      <span class="k">标称集数</span><span>${d.episodes_expected || "未知"}</span>
      <span class="k">本地集数</span><span>${d.episodes.length}${d.missing.length ? `（缺 ${d.missing.length} 集）` : ""}</span>
      <span class="k">总大小</span><span>${fmtGB(d.size_mb || 0)}</span>
      <span class="k">更新日期</span><span>${d.updated_date || "-"}</span>
      <span class="k">网盘状态</span><span class="tag ${d.drive_state === "dead" ? "err" : d.drive_state === "saved" ? "ok" : "gray"}">${d.drive_state}</span>
      <span class="k">观看状态</span><span>${d.watch_state}${d.last_episode ? `（看到第 ${d.last_episode} 集）` : ""}</span>
    </div>
    <div class="modal-ops">
      ${d.episodes.length ? `<button class="primary" id="m-play">▶ 播放${d.last_episode ? `（第 ${d.last_episode} 集）` : ""}</button>` : ""}
      ${d.share_url ? `<button id="m-queue">加入下载队列</button>` : ""}
      <select id="m-watch">
        <option value="">观看状态…</option>
        <option value="unwatched">未看</option>
        <option value="watching">在看</option>
        <option value="watched">已看完</option>
      </select>
      <button class="danger" id="m-blacklist">🗑 删除并拉黑</button>
    </div>
    ${epsHtml}`;

  const startEp = d.last_episode && have.has(d.last_episode) ? d.last_episode : d.episodes[0]?.ep;
  $("#m-play")?.addEventListener("click", () => { closeModal(); location.hash = `#/watch/${d.id}/${startEp}`; });
  $("#m-queue")?.addEventListener("click", async () => {
    const r = await post("/api/queue", { dramas: [d.id] });
    toast(r.added ? "已加入队列" : "已在队列中或链接失效");
    closeModal();
    refreshStats();
  });
  $("#m-watch").onchange = async (e) => {
    if (!e.target.value) return;
    await patch(`/api/dramas/${d.id}`, { watch_state: e.target.value });
    closeModal();
    loadLibrary();
  };
  $("#m-blacklist").onclick = async () => {
    const warn = d.episodes.length
      ? `将删除本地 ${d.episodes.length} 集（${fmtGB(d.size_mb || 0)}）并拉黑此剧。\n删除后文件不可恢复，该链接不再出现在索引中。确定？`
      : "将拉黑此剧，该链接不再出现在索引中。确定？";
    if (!confirm(warn)) return;
    const r = await post(`/api/dramas/${d.id}/blacklist`, { delete_files: true });
    toast(r.files_deleted ? `已删除并拉黑，释放 ${fmtGB(r.freed_mb)}` : "已拉黑");
    closeModal();
    libState.page = 1;
    loadLibrary();
    refreshStats();
  };
  $("#modal-content").querySelectorAll(".ep-grid button").forEach((b) => {
    b.onclick = () => { closeModal(); location.hash = `#/watch/${d.id}/${b.dataset.ep}`; };
  });
  $("#modal").classList.remove("hidden");
}

function closeModal() { $("#modal").classList.add("hidden"); }
window.closeModal = closeModal;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/* ---------- 全库索引页 ---------- */

const idxState = { page: 1, pageSize: 20, selected: new Set() };

async function loadIndex() {
  const q = $("#idx-search").value.trim();
  if (!q) {
    $("#idx-body").innerHTML = '<tr><td colspan="6" class="muted">输入剧名搜索全库 78,000+ 索引</td></tr>';
    $("#idx-count").textContent = "";
    $("#idx-pager").innerHTML = "";
    return;
  }
  const data = await api(`/api/index/search?q=${encodeURIComponent(q)}&page=${idxState.page}&page_size=${idxState.pageSize}`);
  $("#idx-count").textContent = `共 ${data.total} 部`;
  const driveTag = { saved: '<span class="tag ok">已转存</span>', dead: '<span class="tag err">失效</span>', pending: "" };
  const dlTag = {
    done: '<span class="tag ok">已下载</span>',
    queued: '<span class="tag info">队列中</span>',
    downloading: '<span class="tag info">下载中</span>',
    failed: '<span class="tag warn">失败</span>',
    none: "",
  };
  $("#idx-body").innerHTML = data.items
    .map((d) => {
      const dl = d.download_state;
      const selectable = d.share_url && dl !== "done" && d.drive_state !== "dead";
      return `<tr>
        <td>${selectable ? `<input type="checkbox" data-id="${d.id}" ${idxState.selected.has(d.id) ? "checked" : ""}>` : ""}</td>
        <td class="row-title">${dl === "done" ? `<a href="#/library">${esc(d.title)}</a>` : esc(d.title)}</td>
        <td>${d.episodes_expected || "-"}</td>
        <td>${d.updated_date || "-"}</td>
        <td>${driveTag[d.drive_state] || ""}</td>
        <td>${dlTag[dl] || ""}</td>
        <td><button class="danger" data-bl="${d.id}" title="删除本地文件（如有）并拉黑">🗑</button></td>
      </tr>`;
    })
    .join("");
  $("#idx-body").querySelectorAll("button[data-bl]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("删除本地文件（如有）并将此链接加入黑名单？")) return;
      try {
        const r = await post(`/api/dramas/${b.dataset.bl}/blacklist`, { delete_files: true });
        toast(r.files_deleted ? `已删除并拉黑，释放 ${fmtGB(r.freed_mb)}` : "已拉黑");
        idxState.selected.delete(Number(b.dataset.bl));
        refreshStats();
        loadIndex();
        loadBlacklist();
      } catch (e) { toast(e.message, true); }
    };
  });
  $("#idx-body").querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      cb.checked ? idxState.selected.add(id) : idxState.selected.delete(id);
    };
  });

  const pages = Math.max(1, Math.ceil(data.total / idxState.pageSize));
  const pg = $("#idx-pager");
  pg.innerHTML = "";
  if (pages > 1) {
    const prev = document.createElement("button");
    prev.textContent = "上一页";
    prev.disabled = idxState.page <= 1;
    prev.onclick = () => { idxState.page--; loadIndex(); };
    const next = document.createElement("button");
    next.textContent = "下一页";
    next.disabled = idxState.page >= pages;
    next.onclick = () => { idxState.page++; loadIndex(); };
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${idxState.page} / ${pages}`;
    pg.append(prev, label, next);
  }
}

async function loadBlacklist() {
  const data = await api("/api/blacklist?page_size=100");
  $("#bl-count").textContent = data.total ? `（${data.total}）` : "";
  const list = $("#bl-list");
  if (!data.items.length) {
    list.innerHTML = '<span class="muted">黑名单为空</span>';
    return;
  }
  list.innerHTML = data.items
    .map(
      (b) => `<div class="q-item">
        <span class="grow">${esc(b.title)}</span>
        <span class="muted">${b.share_url ? "" : "无链接"}</span>
        <button data-restore="${b.id}">恢复</button>
      </div>`
    )
    .join("");
  list.querySelectorAll("button[data-restore]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/blacklist/${b.dataset.restore}`, { method: "DELETE" });
      toast("已移出黑名单（下次同步后重新出现在索引）");
      loadBlacklist();
      loadIndex();
    };
  });
}

function renderIndex() {
  loadIndex();
  loadBlacklist();
  $("#bl-toggle").onclick = () => {
    const list = $("#bl-list");
    const hidden = list.classList.toggle("hidden");
    $("#bl-toggle").textContent = hidden ? "展开" : "收起";
    if (!hidden) loadBlacklist();
  };
  let t = null;
  $("#idx-search").oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { idxState.page = 1; idxState.selected.clear(); loadIndex(); }, 350);
  };
  $("#idx-queue-selected").onclick = async () => {
    if (!idxState.selected.size) return toast("先勾选要下载的剧", true);
    const r = await post("/api/queue", { dramas: [...idxState.selected] });
    toast(`已加入 ${r.added} 部`);
    idxState.selected.clear();
    refreshStats();
    loadIndex();
  };
}

/* ---------- 队列页 ---------- */

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

  // 队列页有活动时保持轮询，空闲时降频
  if (pipe.running || q.items.length) {
    if (!pollTimer) pollTimer = setInterval(loadQueue, 3000);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderQueue() {
  $("#pause-btn").onclick = async () => {
    const cur = $("#pause-btn").textContent.includes("暂停");
    await post("/api/pipeline/pause", { paused: cur });
    loadQueue();
  };
  loadQueue();
}

/* ---------- 播放页 ---------- */

const watch = { id: null, eps: [], cur: 0 };

async function renderWatch([id, ep]) {
  const d = await api(`/api/dramas/${id}`);
  watch.id = d.id;
  watch.eps = d.episodes;
  const target = Number(ep) || d.last_episode || d.episodes[0]?.ep;
  $("#watch-title").textContent = d.title;

  const sel = $("#ep-select");
  sel.innerHTML = d.episodes.map((e) => `<option value="${e.ep}">第 ${e.ep} 集</option>`).join("");
  sel.onchange = () => playEpisode(Number(sel.value));

  $("#ep-grid").innerHTML = d.episodes
    .map(
      (e) => `<button data-ep="${e.ep}" title="${esc(e.file)} · ${e.size_mb}MB">${e.ep}</button>`
    )
    .join("");
  $("#ep-grid").querySelectorAll("button").forEach((b) => {
    b.onclick = () => playEpisode(Number(b.dataset.ep));
  });

  $("#prev-ep").onclick = () => playEpisode(Math.max(1, watch.cur - 1));
  $("#next-ep").onclick = () => playEpisode(watch.cur + 1);
  $("#speed-select").onchange = (e) => { $("#player").playbackRate = Number(e.target.value); };

  const video = $("#player");
  if (!video._bound) {
    video._bound = true;
    // 断点续播：离开页面前记住秒数
    video.addEventListener("timeupdate", () => {
      if (watch.id && watch.cur && video.currentTime > 5) {
        localStorage.setItem(`dj-pos-${watch.id}-${watch.cur}`, Math.floor(video.currentTime));
      }
    });
    video.addEventListener("ended", () => {
      localStorage.removeItem(`dj-pos-${watch.id}-${watch.cur}`);
      if (watch.cur < watch.eps.length) {
        const next = watch.cur + 1;
        $("#watch-status").textContent = `即将播放第 ${next} 集…`;
        setTimeout(() => playEpisode(next), 1200);
      } else {
        $("#watch-status").textContent = "已看完全部集数 🎉";
        patch(`/api/dramas/${watch.id}`, { watch_state: "watched" });
      }
    });
    window.addEventListener("beforeunload", () => {
      if (watch.id && watch.cur) {
        localStorage.setItem(`dj-pos-${watch.id}-${watch.cur}`, Math.floor(video.currentTime));
      }
    });
  }
  playEpisode(target);
}

function playEpisode(ep) {
  watch.cur = ep;
  const video = $("#player");
  video.src = djToken.with(`/api/dramas/${watch.id}/episodes/${ep}`);
  video.playbackRate = Number($("#speed-select").value);
  $("#ep-select").value = ep;

  // 集内断点
  const saved = Number(localStorage.getItem(`dj-pos-${watch.id}-${ep}`) || 0);
  const status = $("#watch-status");
  if (saved > 5) {
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = saved;
        status.textContent = `从上次 ${fmtTime(saved)} 继续播放`;
      },
      { once: true }
    );
  } else {
    status.textContent = "";
  }

  // 服务端记“看到第几集” + 观看状态
  patch(`/api/dramas/${watch.id}`, { last_episode: ep, watch_state: "watching" });

  // 选集高亮
  $("#ep-grid").querySelectorAll("button").forEach((b) => {
    const e = Number(b.dataset.ep);
    b.classList.toggle("current", e === ep);
  });
  $(`#ep-grid button[data-ep="${ep}"]`)?.scrollIntoView({ block: "nearest" });
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ---------- 启动 ---------- */

refreshStats();
setInterval(refreshStats, 30000);
router();
