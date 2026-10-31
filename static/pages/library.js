/* 剧库：无限滚动卡片墙 + 多选批量操作 + 右侧详情抽屉 */
import { $, esc, api, post, patch, toast, fmtGB } from "../shared.js";

const PAGE_SIZE = 24;
const st = { page: 1, total: 0, loading: false, selectMode: false, selected: new Set() };
let observer = null;

export function cleanupLibrary() {
  if (observer) { observer.disconnect(); observer = null; }
  closeDrawer();
}

export function renderLibrary() {
  st.page = 1;
  st.selectMode = false;
  st.selected.clear();
  setSelectMode(false);
  $("#lib-grid").innerHTML = "";
  $("#lib-empty").classList.add("hidden");
  $("#lib-skeleton").innerHTML = Array(8).fill("<div class=\"sk\"></div>").join("");
  $("#lib-skeleton").classList.remove("hidden");

  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (es) => { if (es.some((x) => x.isIntersecting)) loadMore(); },
    { rootMargin: "400px" }
  );
  observer.observe($("#lib-sentinel"));

  $("#lib-more").onclick = () => loadMore();
  let t = null;
  $("#lib-search").oninput = () => { clearTimeout(t); t = setTimeout(resetAndLoad, 300); };
  $("#lib-state").onchange = $("#lib-sort").onchange = resetAndLoad;
  $("#lib-select-btn").onclick = () => setSelectMode(!st.selectMode);
  $("#lib-grid").onclick = onGridClick;
  $("#op-queue").onclick = batchQueue;
  $("#op-watch").onclick = batchWatch;
  $("#op-blacklist").onclick = batchBlacklist;
  $("#op-cancel").onclick = () => setSelectMode(false);

  loadMore();
  if (window.__pendingDetail) {
    const id = window.__pendingDetail;
    window.__pendingDetail = null;
    openDetail(id);
  }
}

function resetAndLoad() {
  st.page = 1;
  $("#lib-grid").innerHTML = "";
  $("#lib-empty").classList.add("hidden");
  loadMore();
}

async function loadMore() {
  if (st.loading) return;
  st.loading = true;
  try {
    const q = $("#lib-search").value.trim();
    const state = $("#lib-state").value;
    const sort = $("#lib-sort").value;
    const data = await api(
      `/api/dramas?q=${encodeURIComponent(q)}&state=${state}&sort=${sort}&page=${st.page}&page_size=${PAGE_SIZE}`
    );
    st.total = data.total;
    $("#lib-count").textContent = `共 ${st.total} 部`;
    $("#lib-skeleton").classList.add("hidden");
    if (!data.items.length && st.page === 1) showEmpty(state);
    $("#lib-grid").insertAdjacentHTML("beforeend", data.items.map(cardHTML).join(""));
    const noMore = st.page * PAGE_SIZE >= st.total;
    $("#lib-more").classList.toggle("hidden", noMore);
    if (!noMore) st.page++;
  } catch (e) {
    toast("加载失败：" + e.message, true);
  } finally {
    st.loading = false;
  }
}

function cardHTML(d) {
  const eps = d.episodes_local ?? 0;
  const watching = d.watch_state === "watching" && d.last_episode > 0;
  let badge = "", prog = "";
  if (d.watch_state === "watched") badge = '<span class="badge done">已看完</span>';
  else if (watching) {
    badge = `<span class="badge">看到${d.last_episode}集</span>`;
    const pct = eps ? Math.min(100, Math.round((d.last_episode / eps) * 100)) : 0;
    prog = `<div class="cprog"><i style="width:${pct}%"></i></div>`;
  }
  const sub = watching ? `第${d.last_episode}集 / 共${eps}集` : `共${eps}集`;
  const cover = d.has_cover
    ? `<div class="cover" style="background-image:url('${djToken.with(`/api/dramas/${d.id}/cover`)}')"></div>`
    : `<div class="cover">📺</div>`;
  const sel = st.selected.has(d.id) ? " sel" : "";
  return `<div class="card${sel}" data-id="${d.id}">
    <div class="check">✓</div>
    ${d.favorite ? '<div class="fav">♥</div>' : ""}
    ${badge}${cover}
    <div class="meta"><div class="t">${esc(d.title)}</div><div class="s">${sub}</div></div>${prog}</div>`;
}

function showEmpty(state) {
  const el = $("#lib-empty");
  if (state !== "done") {
    el.innerHTML = `<div class="icon">🔍</div><h3>没有符合条件的剧</h3><p>换个筛选条件试试</p>`;
  } else {
    el.innerHTML = `<div class="icon">🍿</div><h3>剧库还是空的</h3>
      <ol><li>到 <a href="#/index">全库索引</a> 搜索想看的短剧</li>
      <li>勾选后加入下载队列，自动转存下载</li>
      <li>下载完成后回这里观看</li></ol>`;
  }
  el.classList.remove("hidden");
}

/* ---- 多选 ---- */

function setSelectMode(on) {
  st.selectMode = on;
  if (!on) st.selected.clear();
  $("#lib-grid").classList.toggle("select-mode", on);
  $("#lib-select-btn").textContent = on ? "退出选择" : "批量选择";
  updateOpbar();
  $("#lib-grid").querySelectorAll(".card").forEach((c) =>
    c.classList.toggle("sel", st.selected.has(+c.dataset.id))
  );
}

function updateOpbar() {
  $("#lib-opbar").classList.toggle("hidden", !st.selectMode);
  $("#lib-sel-count").textContent = `已选 ${st.selected.size}`;
}

function onGridClick(e) {
  const card = e.target.closest(".card[data-id]");
  if (!card) return;
  const id = +card.dataset.id;
  if (st.selectMode) {
    if (st.selected.has(id)) st.selected.delete(id);
    else st.selected.add(id);
    card.classList.toggle("sel", st.selected.has(id));
    updateOpbar();
  } else {
    openDetail(id);
  }
}

async function batchQueue() {
  if (!st.selected.size) return toast("先勾选要下载的剧", true);
  const r = await post("/api/queue", { dramas: [...st.selected] });
  toast(`已加入 ${r.added} 部`);
  setSelectMode(false);
}

async function batchWatch() {
  if (!st.selected.size) return toast("先勾选要标记的剧", true);
  await Promise.all([...st.selected].map((id) => patch(`/api/dramas/${id}`, { watch_state: "watched" })));
  toast(`已标记 ${st.selected.size} 部为已看完`);
  setSelectMode(false);
  resetAndLoad();
}

async function batchBlacklist() {
  if (!st.selected.size) return toast("先勾选要拉黑的剧", true);
  const n = st.selected.size;
  if (!confirm(`将拉黑所选 ${n} 部（保留本地文件，同步不会复活）。确定？`)) return;
  for (const id of st.selected) {
    try { await post(`/api/dramas/${id}/blacklist`, { delete_files: false }); } catch {}
  }
  toast(`已拉黑 ${n} 部`);
  setSelectMode(false);
  resetAndLoad();
}

/* ---- 详情抽屉 ---- */

function openDrawer() {
  $("#drawer").classList.add("open");
  $("#drawer-mask").classList.add("open");
}
export function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-mask").classList.remove("open");
}

async function openDetail(id) {
  const box = $("#drawer-content");
  box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
  openDrawer();
  let d;
  try {
    d = await api(`/api/dramas/${id}`);
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const cover = d.has_cover
    ? `<div class="d-cover" style="background-image:url('${djToken.with(`/api/dramas/${d.id}/cover`)}')"></div>`
    : `<div class="d-cover">📺</div>`;
  const urlPath = d.local_dir ? d.local_dir.replace(/^\/media-lib/, "") : "";
  const ops = [];
  if (d.episodes.length) {
    const startEp = d.last_episode && d.episodes.some((e) => e.ep === d.last_episode)
      ? d.last_episode : d.episodes[0].ep;
    ops.push(`<button class="primary" data-act="play" data-ep="${startEp}">▶ 网页播放${d.last_episode ? `（第 ${d.last_episode} 集）` : ""}</button>`);
  }
  if (d.share_url && d.download_state !== "done") {
    ops.push(`<button data-act="queue">加入下载队列</button>`);
  }
  if (d.share_url && ["none", "failed"].includes(d.download_state)) {
    ops.push(`<button data-act="queue-force">强制重新入队</button>`);
  }
  ops.push(`<button data-act="rescan">🔄 重扫此剧（刷新集数/大小）</button>`);
  if (d.share_url) ops.push(`<button data-act="copy">🔗 复制分享链接</button>`);
  ops.push(`<div class="row">
    <select id="d-watch" style="flex:1">
      <option value="">观看状态…</option>
      <option value="unwatched" ${d.watch_state === "unwatched" ? "selected" : ""}>未看</option>
      <option value="watching" ${d.watch_state === "watching" ? "selected" : ""}>在看</option>
      <option value="watched" ${d.watch_state === "watched" ? "selected" : ""}>已看完</option>
    </select></div>`);
  ops.push(`<button data-act="remove">移出并拉黑（保留文件）</button>`);
  ops.push(`<button class="danger" data-act="blacklist">🗑 删除文件并拉黑</button>`);

  box.innerHTML = `
    ${cover}
    <h2>${esc(d.title)}</h2>
    <div class="kv">
      <span class="k">集数</span><span>${d.episodes.length} / 标称 ${d.episodes_expected || "?"}${d.missing.length ? `（缺 ${d.missing.length} 集）` : ""}</span>
      <span class="k">大小</span><span>${fmtGB(d.size_mb || 0)}</span>
      <span class="k">更新</span><span>${d.updated_date || "-"}</span>
      <span class="k">网盘</span><span class="tag ${d.drive_state === "dead" ? "err" : d.drive_state === "saved" ? "ok" : "gray"}">${d.drive_state || "-"}</span>
      <span class="k">下载</span><span>${d.download_state}</span>
      ${urlPath ? `<span class="k">目录</span><span style="word-break:break-all;font-size:12px">${esc(urlPath)}</span>` : ""}
    </div>
    <div class="d-ops">${ops.join("")}</div>
    <div class="d-eps">
      ${d.episodes.length ? `<div class="ep-grid">${d.episodes
        .map((e) => `<button data-ep="${e.ep}" title="${esc(e.file)} · ${e.size_mb}MB">${e.ep}</button>`)
        .join("")}</div>` : '<p class="muted">未下载</p>'}
      ${d.missing.length ? `<p class="muted" style="margin-top:8px;font-size:12px">缺集：${d.missing.join("、")}</p>` : ""}
    </div>`;

  $("#d-watch").onchange = async (e) => {
    if (!e.target.value) return;
    await patch(`/api/dramas/${d.id}`, { watch_state: e.target.value });
    toast("已更新观看状态");
    resetAndLoad();
  };
  box.querySelectorAll(".d-ops [data-act]").forEach((b) => {
    b.onclick = () => drawerAction(b.dataset.act, d, b);
  });
  box.querySelectorAll(".ep-grid button").forEach((b) => {
    b.onclick = () => { closeDrawer(); location.hash = `#/watch/${d.id}/${b.dataset.ep}`; };
  });
}

async function drawerAction(act, d, btn) {
  try {
    if (act === "play") {
      closeDrawer();
      location.hash = `#/watch/${d.id}/${btn.dataset.ep}`;
    } else if (act === "queue") {
      const r = await post("/api/queue", { dramas: [d.id] });
      toast(r.added ? "已加入队列" : "已在队列中或链接失效");
    } else if (act === "queue-force") {
      const r = await post("/api/queue", { dramas: [d.id], force: true });
      toast(r.added ? "已强制入队" : "入队失败");
    } else if (act === "rescan") {
      btn.disabled = true;
      const r = await post(`/api/dramas/${d.id}/rescan`, {});
      if (r.folder_missing) toast("本地文件夹不存在，已清空本地信息", true);
      else toast(`重扫完成：${r.episodes} 集 · ${fmtGB(r.size_mb || 0)}`);
      resetAndLoad();
      openDetail(d.id);
    } else if (act === "copy") {
      await navigator.clipboard.writeText(d.share_url);
      toast("分享链接已复制");
    } else if (act === "remove") {
      if (!confirm("移出剧库并拉黑此链接（保留本地文件，同步不会复活）？")) return;
      await post(`/api/dramas/${d.id}/blacklist`, { delete_files: false });
      toast("已移出，链接已拉黑（文件保留在磁盘）");
      closeDrawer();
      resetAndLoad();
    } else if (act === "blacklist") {
      if (!confirm(`将删除本地 ${d.episodes.length} 集（${fmtGB(d.size_mb || 0)}）并拉黑。文件不可恢复！确定？`)) return;
      const r = await post(`/api/dramas/${d.id}/blacklist`, { delete_files: true });
      toast(r.files_deleted ? `已删除并拉黑，释放 ${fmtGB(r.freed_mb)}` : "已拉黑");
      closeDrawer();
      resetAndLoad();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

$("#drawer-close").onclick = closeDrawer;
$("#drawer-mask").onclick = closeDrawer;
