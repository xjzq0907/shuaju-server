/* 全库索引：搜索 + 入队 + 黑名单管理 */
import { $, esc, api, post, toast } from "../shared.js";

const idxState = { page: 1, pageSize: 20, selected: new Set() };

export function renderIndex() {
  // 从仪表盘全局搜索跳转时带入关键词
  const saved = sessionStorage.getItem("idx_q");
  if (saved) {
    sessionStorage.removeItem("idx_q");
    $("#idx-search").value = saved;
    idxState.page = 1;
    idxState.selected.clear();
  }
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
    loadIndex();
  };
}

async function loadIndex() {
  const q = $("#idx-search").value.trim();
  if (!q) {
    $("#idx-body").innerHTML = '<tr><td colspan="7" class="muted">输入剧名搜索全库索引</td></tr>';
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
        toast(r.files_deleted ? `已删除并拉黑，释放 ${r.freed_mb} MB` : "已拉黑");
        idxState.selected.delete(Number(b.dataset.bl));
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
