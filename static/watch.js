/* 短剧 PWA：首页（继续观看/筛选/无限滚动）+ 沉浸式播放器
   （手势教学/长按3倍速/双击快进/进度记忆/倍速持久化/锁屏控制） */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = ~~(s / 3600), m = ~~((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  };

  /* ================= localStorage ================= */
  const SPEEDS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 0.75];
  let spIdx = 0;
  try { spIdx = Math.min(SPEEDS.length - 1, Math.max(0, parseInt(localStorage.getItem("dj_speed") || "0", 10) || 0)); } catch (e) {}

  /* 清晰度：null=原画直读；否则服务端 ffmpeg 实时转码（?q=xxx&t=起点秒）。
     转码流时间轴从 0 起算，显示时间 = t 偏移 + 播放器时间；深跳换新 t 重开流。 */
  const QUALS = [null, "720p", "480p"];
  const Q_LABELS = ["原画", "720P", "480P"];
  let qIdx = 0;
  try { qIdx = Math.min(QUALS.length - 1, Math.max(0, parseInt(localStorage.getItem("dj_quality") || "0", 10) || 0)); } catch (e) {}
  let qOff = 0;
  let epDur = 0; // 当前集总时长（转码流 mvhd 时长为 0，问服务端 meta 拿真值）

  const POS_KEY = "dj_pos";
  function loadPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function savePos(id, ep, t) {
    try {
      const m = loadPos();
      m[id + ":" + ep] = Math.floor(t);
      const keys = Object.keys(m);
      if (keys.length > 300) for (let i = 0; i < keys.length - 300; i++) delete m[keys[i]];
      localStorage.setItem(POS_KEY, JSON.stringify(m));
    } catch (e) {}
  }

  /* ================= 首页 ================= */
  const grid = $("grid"), moreBtn = $("more"), qInput = $("q");
  let page = 1, total = 0, query = "", wsFilter = "", loading = false, firstLoad = true;

  function cardHTML(d) {
    const eps = d.episodes_local || d.episodes_expected || 0;
    const watching = d.watch_state === "watching" && d.last_episode > 0;
    let badge = "", prog = "";
    if (d.watch_state === "watched") badge = '<span class="badge done">已看完</span>';
    else if (watching) {
      badge = `<span class="badge">看到${d.last_episode}集</span>`;
      const pct = eps ? Math.min(100, Math.round((d.last_episode / eps) * 100)) : 0;
      prog = `<div class="cprog"><i style="width:${pct}%"></i></div>`;
    }
    const sub = watching
      ? `<span class="st">第${d.last_episode}集</span> / 共${eps}集`
      : `共${eps}集`;
    const cover = d.has_cover
      ? `<img class="cover" src="${djToken.with(`/api/dramas/${d.id}/cover`)}" alt="" loading="lazy">`
      : `<div class="fallback">${esc(d.title)}</div>`;
    return `<div class="card" data-id="${d.id}">${badge}${cover}
      <div class="meta"><div class="t">${esc(d.title)}</div><div class="s">${sub}</div></div>${prog}</div>`;
  }

  function showSkeleton() {
    const sk = $("skeleton");
    sk.innerHTML = Array(6).fill('<div class="card sk"></div>').join("");
    sk.classList.remove("hidden");
  }
  function hideSkeleton() { $("skeleton").classList.add("hidden"); $("skeleton").innerHTML = ""; }

  async function load(reset) {
    if (loading) return;
    if (reset) { page = 1; moreBtn.classList.add("hidden"); }
    loading = true;
    if (firstLoad) showSkeleton();
    try {
      const url = `/api/dramas?state=done&sort=updated&page=${page}&page_size=24&q=${encodeURIComponent(query)}` +
        (wsFilter ? `&watch_state=${wsFilter}` : "");
      const data = await fetch(url).then((r) => r.json());
      total = data.total || 0;
      $("total").textContent = `共 ${total} 部`;
      hideSkeleton();
      if (reset) grid.innerHTML = "";
      grid.insertAdjacentHTML("beforeend", data.items.map(cardHTML).join(""));
      const noMore = page * 24 >= total;
      moreBtn.classList.toggle("hidden", noMore || total === 0);
      $("empty").classList.toggle("hidden", total !== 0);
      $("empty-text").textContent = query
        ? `没有找到「${query}」`
        : wsFilter === "watched" ? "还没有看完的短剧" : wsFilter === "watching" ? "还没有在看的短剧" : "还没有短剧";
      if (!noMore) page++;
    } catch (e) {
      hideSkeleton();
      $("empty").classList.remove("hidden");
      $("empty-text").textContent = "加载失败，下拉刷新或稍后再试";
    } finally { loading = false; firstLoad = false; }
  }

  async function loadResume() {
    try {
      const data = await fetch("/api/dramas?state=done&sort=updated&page=1&page_size=10&watch_state=watching").then((r) => r.json());
      const items = (data.items || []).filter((d) => d.last_episode > 0);
      const sec = $("resume-sec"), row = $("resume-row");
      if (!items.length) { sec.classList.add("hidden"); row.innerHTML = ""; return; }
      sec.classList.remove("hidden");
      row.innerHTML = items.map((d) => {
        const eps = d.episodes_local || d.episodes_expected || 0;
        const pct = eps ? Math.min(100, Math.round((d.last_episode / eps) * 100)) : 0;
        const cover = d.has_cover
          ? `<img class="rcover" src="${djToken.with(`/api/dramas/${d.id}/cover`)}" alt="">`
          : '<div class="rcover"></div>';
        return `<div class="rcard" data-id="${d.id}">${cover}<div class="rinfo">
          <div class="rtitle">${esc(d.title)}</div>
          <div><div class="rprog-text">看到第 ${d.last_episode} 集 / 共 ${eps} 集</div>
          <div class="rprog"><i style="width:${pct}%"></i></div>
          <button class="rbtn">▶ 继续</button></div></div></div>`;
      }).join("");
    } catch (e) {}
  }

  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".card[data-id]");
    if (card) openDrama(+card.dataset.id);
  });
  $("resume-row").addEventListener("click", (e) => {
    const card = e.target.closest(".rcard[data-id]");
    if (card) openDrama(+card.dataset.id);
  });
  $("chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $("chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    chip.classList.add("on");
    wsFilter = chip.dataset.ws;
    load(true);
  });
  let qTimer;
  qInput.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { query = qInput.value.trim(); load(true); }, 350);
  });
  $("clear-q").addEventListener("click", () => { qInput.value = ""; query = ""; load(true); });
  moreBtn.addEventListener("click", () => load(false));
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting) && !moreBtn.classList.contains("hidden")) load(false);
    }, { rootMargin: "400px" }).observe($("sentinel"));
  }

  /* ================= 播放器 ================= */
  const video = $("video");
  let drama = null, curEp = 1, haveEps = new Set(), expected = 0, switching = false;
  let hudTimer = null, hintTimer = null, toastTimer = null, lastPosSave = 0;

  function updateEpLabel() {
    $("p-ep").textContent = `第 ${curEp} / ${expected || "?"} 集`;
  }
  function updateSpeedBtn() {
    $("speed-btn").textContent = SPEEDS[spIdx].toFixed(2).replace(/0$/, "").replace(/\.0$/, "") + "×";
  }
  function updateQBtn() {
    $("q-btn").textContent = Q_LABELS[qIdx];
  }

  function toast(msg, ms, retry) {
    const el = $("toast");
    el.innerHTML = "";
    el.append(msg);
    if (retry) {
      const b = document.createElement("button");
      b.textContent = "重试";
      b.onclick = () => { el.classList.add("hidden"); playCur(false); };
      el.append(b);
    }
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms || 1800);
  }

  function flashEp(n) {
    const el = $("ep-flash");
    el.textContent = `${n}`; // 只显示数字，无黑底
    el.classList.remove("hidden");
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add("hidden"), 700);
  }

  function showHud(sticky) {
    $("hud").classList.remove("off");
    clearTimeout(hudTimer);
    if (!sticky) hudTimer = setTimeout(() => {
      if (!video.paused && $("drawer").classList.contains("hidden")) $("hud").classList.add("off");
    }, 3200);
  }
  function toggleHud() {
    if ($("hud").classList.contains("off")) showHud();
    else { clearTimeout(hudTimer); $("hud").classList.add("off"); }
  }
  function togglePlay() { video.paused ? video.play().catch(() => {}) : video.pause(); }

  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !drama) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${drama.title} · 第${curEp}集`,
        artist: "短剧",
        artwork: [{ src: djToken.with(`/api/dramas/${drama.id}/cover`), sizes: "512x512" }],
      });
      navigator.mediaSession.setActionHandler("play", () => video.play().catch(() => {}));
      navigator.mediaSession.setActionHandler("pause", () => video.pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
    } catch (e) {}
  }

  function saveLastPos() {
    const abs = qOff + video.currentTime;
    if (drama && abs > 1) savePos(drama.id, curEp, abs);
  }

  function displayCur() { return qOff + video.currentTime; }
  function displayDur() {
    if (QUALS[qIdx]) return epDur; // 转码流：服务端探的真时长（绝对值）
    return isFinite(video.duration) && video.duration ? video.duration : 0;
  }
  function fetchEpDur() {
    epDur = 0;
    fetch(`/api/dramas/${drama.id}/episodes/${curEp}/meta`)
      .then((r) => r.json())
      .then((m) => { epDur = m.duration || 0; })
      .catch(() => {});
  }

  function epUrl() {
    const q = QUALS[qIdx];
    return djToken.with(
      `/api/dramas/${drama.id}/episodes/${curEp}` + (q ? `?q=${q}&t=${qOff.toFixed(2)}` : "")
    );
  }

  function playCur(flash) {
    const pos = loadPos()[drama.id + ":" + curEp] || 0;
    // 转码流直接从断点开流（不能加载后 seek，流是单向的）；原画文件可拖动，加载后 seek 恢复
    qOff = QUALS[qIdx] && pos > 3 ? pos : 0;
    if (QUALS[qIdx]) fetchEpDur();
    video.src = epUrl();
    video.playbackRate = SPEEDS[spIdx];
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = SPEEDS[spIdx];
      if (!qOff && pos > 3 && video.duration && pos < video.duration * 0.95) video.currentTime = pos;
    }, { once: true });
    video.play().catch(() => {});
    fetch(`/api/dramas/${drama.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_state: "watching", last_episode: curEp }),
    }).catch(() => {});
    drama.watch_state = "watching";
    drama.last_episode = curEp;
    updateEpLabel();
    highlightEp();
    if (flash !== false) flashEp(curEp);
    updateMediaSession();
    showHud();
  }

  function epsSorted() { return drama.episodes.map((e) => e.ep).sort((a, b) => a - b); }

  function step(dir) {
    if (!drama || switching) return;
    const eps = epsSorted();
    const i = eps.indexOf(curEp);
    const t = i >= 0 ? eps[i + dir] : null;
    if (t == null) { toast(dir > 0 ? "已经是最后一集" : "已经是第一集"); return; }
    switching = true;
    saveLastPos();
    curEp = t;
    playCur(true);
    setTimeout(() => { switching = false; }, 500);
  }

  function finishAll() {
    savePos(drama.id, curEp, 0);
    fetch(`/api/dramas/${drama.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_state: "watched", last_episode: curEp }),
    }).catch(() => {});
    drama.watch_state = "watched";
    $("fp-title").textContent = drama.title;
    $("finish-panel").classList.remove("hidden");
    showHud(true);
  }

  async function openDrama(id) {
    try {
      const d = await fetch(`/api/dramas/${id}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
      drama = d;
      haveEps = new Set(d.episodes.map((e) => e.ep));
      expected = d.episodes_expected || (d.episodes.length ? Math.max(...d.episodes.map((e) => e.ep)) : 0);
      let start = d.watch_state === "watched" ? 1 : (d.last_episode || 1);
      if (!haveEps.has(start)) {
        start = d.episodes.length ? d.episodes[0].ep : 1;
        for (const e of d.episodes) if (e.ep > (d.last_episode || 0)) { start = e.ep; break; }
      }
      curEp = start;
      $("p-title").textContent = d.title;
      $("finish-panel").classList.add("hidden");
      $("home").classList.add("hidden");
      $("player").classList.remove("hidden");
      buildDrawer();
      playCur(true);
      updateSpeedBtn();
      maybeHint();
    } catch (e) { toast("加载失败"); }
  }

  function closePlayer() {
    saveLastPos();
    drama = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    $("player").classList.add("hidden");
    $("drawer").classList.add("hidden");
    $("finish-panel").classList.add("hidden");
    $("hud").classList.remove("off");
    $("home").classList.remove("hidden");
    loadResume();
    load(true);
  }

  /* ---- 选集抽屉 ---- */
  function buildDrawer() {
    $("drawer-title").textContent = `选集 · 共 ${expected} 集`;
    let html = "";
    for (let n = 1; n <= expected; n++) {
      html += `<button data-ep="${n}" class="${haveEps.has(n) ? "" : "miss"}">${n}</button>`;
    }
    $("ep-grid").innerHTML = html;
  }
  function highlightEp() {
    $("ep-grid").querySelectorAll("button").forEach((b) => {
      const n = +b.dataset.ep;
      b.classList.toggle("cur", n === curEp);
      b.classList.toggle("watched", n < curEp && haveEps.has(n));
    });
  }
  function openDrawer() {
    $("drawer").classList.remove("hidden");
    showHud(true);
    requestAnimationFrame(() => {
      const b = $("ep-grid").querySelector("button.cur");
      if (b) b.scrollIntoView({ block: "center" });
    });
  }
  function closeDrawer() { $("drawer").classList.add("hidden"); showHud(); }
  $("ep-grid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-ep]");
    if (!b) return;
    if (b.classList.contains("miss")) { toast("这一集还没有下载"); return; }
    curEp = +b.dataset.ep;
    playCur(true);
    closeDrawer();
  });

  /* ---- 手势 ---- */
  let tStart = null, lpTimer = null, boosted = false, lastTapT = 0, lastTapX = 0, moved = false;
  let wheelLock = 0, lastTouchEnd = 0;

  video.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    tStart = { x: t.clientX, y: t.clientY, t: Date.now() };
    moved = false; boosted = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (tStart && !moved) {
        boosted = true;
        video.playbackRate = 3; // 长按默认 3 倍速
        $("boost").textContent = "3倍速";
        $("boost").classList.remove("hidden");
      }
    }, 350);
  }, { passive: true });
  video.addEventListener("touchmove", (e) => {
    if (!tStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - tStart.x) > 10 || Math.abs(t.clientY - tStart.y) > 10) moved = true;
  }, { passive: true });
  video.addEventListener("touchend", (e) => {
    clearTimeout(lpTimer);
    lastTouchEnd = Date.now();
    if (!tStart) return;
    const dt = Date.now() - tStart.t;
    const t = e.changedTouches[0];
    const dx = t.clientX - tStart.x, dy = t.clientY - tStart.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (boosted) {
      video.playbackRate = SPEEDS[spIdx];
      $("boost").classList.add("hidden");
      boosted = false;
      tStart = null; return;
    }
    if (adx < 12 && ady < 12 && !moved) {
      /* 单击显隐 HUD / 双击左右快进 */
      const now = Date.now();
      const w = video.clientWidth;
      const rx = t.clientX / w;
      if (now - lastTapT < 300 && Math.abs(t.clientX - lastTapX) < w / 3 && (rx < 0.34 || rx > 0.66)) {
        const delta = rx < 0.34 ? -10 : 10;
        seekAbs(displayCur() + delta);
        toast((delta > 0 ? "快进" : "快退") + " 10 秒", 700);
        lastTapT = 0;
      } else {
        toggleHud();
        lastTapT = now; lastTapX = t.clientX;
      }
    } else if (ady >= 46 && ady >= adx * 1.4 && dt < 700) {
      step(dy < 0 ? 1 : -1); /* 上滑下一集 / 下滑上一集 */
    }
    tStart = null;
  }, { passive: true });
  function endBoost() {
    clearTimeout(lpTimer);
    if (boosted) {
      video.playbackRate = SPEEDS[spIdx];
      $("boost").classList.add("hidden");
      boosted = false;
    }
    tStart = null;
  }
  video.addEventListener("touchcancel", endBoost, { passive: true });
  if (!matchMedia("(pointer: coarse)").matches) {
    video.addEventListener("click", () => { if (Date.now() - lastTouchEnd > 400) toggleHud(); });
  }
  window.addEventListener("wheel", (e) => {
    if ($("player").classList.contains("hidden")) return;
    const now = Date.now();
    if (now - wheelLock < 500 || Math.abs(e.deltaY) < 20) return;
    wheelLock = now;
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
  window.addEventListener("keydown", (e) => {
    if ($("player").classList.contains("hidden")) return;
    if (e.key === "Escape") closePlayer();
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowLeft") seekAbs(displayCur() - 10);
    else if (e.key === "ArrowRight") seekAbs(displayCur() + 10);
    else if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
  });

  /* ---- 进度条 ---- */
  const barWrap = $("bar-wrap");

  function reopenAt(abs) {
    qOff = abs;
    const wasPlaying = !video.paused;
    video.src = epUrl();
    video.playbackRate = SPEEDS[spIdx];
    video.addEventListener("loadedmetadata", () => { video.playbackRate = SPEEDS[spIdx]; }, { once: true });
    if (wasPlaying) {
      video.play().catch(() => {});
      $("spinner").classList.remove("hidden"); // 起播前等 ffmpeg 出片
    }
  }

  function seekAbs(abs) {
    abs = Math.max(0, abs);
    const d = displayDur();
    if (d) abs = Math.min(abs, d - 0.5);
    if (!QUALS[qIdx]) { video.currentTime = abs; return; }
    // 转码流单向：目标在已缓冲范围内原地拖，否则换新起点重开流
    let bufEnd = 0;
    try { if (video.buffered.length) bufEnd = video.buffered.end(video.buffered.length - 1); } catch (e) {}
    if (abs <= qOff + bufEnd + 2) video.currentTime = abs - qOff;
    else reopenAt(abs);
  }

  function seekAt(clientX) {
    const r = barWrap.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const d = displayDur();
    if (d) seekAbs(p * d);
  }
  let seeking = false;
  barWrap.addEventListener("pointerdown", (e) => { seeking = true; barWrap.setPointerCapture(e.pointerId); seekAt(e.clientX); });
  barWrap.addEventListener("pointermove", (e) => { if (seeking) seekAt(e.clientX); });
  barWrap.addEventListener("pointerup", () => { seeking = false; });

  video.addEventListener("timeupdate", () => {
    const d = displayDur(), cur = displayCur();
    $("bar-fill").style.width = d ? (cur / d) * 100 + "%" : "0";
    $("t-cur").textContent = fmt(cur);
    if (d) $("t-dur").textContent = fmt(d);
    if (drama && Date.now() - lastPosSave > 5000 && cur > 1) {
      lastPosSave = Date.now();
      savePos(drama.id, curEp, cur);
    }
  });
  video.addEventListener("progress", () => {
    try {
      const d = displayDur();
      if (video.buffered.length && d) {
        $("bar-buf").style.width = ((qOff + video.buffered.end(video.buffered.length - 1)) / d) * 100 + "%";
      }
    } catch (e) {}
  });
  video.addEventListener("play", () => { $("play-btn").textContent = "⏸"; showHud(); });
  video.addEventListener("pause", () => { $("play-btn").textContent = "▶"; showHud(true); });
  video.addEventListener("waiting", () => $("spinner").classList.remove("hidden"));
  ["playing", "canplay"].forEach((ev) => video.addEventListener(ev, () => $("spinner").classList.add("hidden")));
  video.addEventListener("ended", () => {
    if (!drama) return;
    savePos(drama.id, curEp, 0);
    const eps = epsSorted();
    const i = eps.indexOf(curEp);
    if (i >= 0 && i + 1 < eps.length) step(1);
    else finishAll();
  });
  video.addEventListener("error", () => {
    if (!drama) return;
    $("spinner").classList.add("hidden");
    toast(`第 ${curEp} 集播放失败`, 5000, true);
  });

  /* ---- 按钮 ---- */
  $("back-btn").addEventListener("click", closePlayer);
  $("play-btn").addEventListener("click", togglePlay);
  $("prev-btn").addEventListener("click", () => step(-1));
  $("next-btn").addEventListener("click", () => step(1));
  $("speed-btn").addEventListener("click", () => {
    spIdx = (spIdx + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[spIdx];
    try { localStorage.setItem("dj_speed", String(spIdx)); } catch (e) {}
    updateSpeedBtn();
    toast(SPEEDS[spIdx] + "× 播放", 900);
  });
  $("q-btn").addEventListener("click", () => {
    if (!drama) return;
    qIdx = (qIdx + 1) % QUALS.length;
    try { localStorage.setItem("dj_quality", String(qIdx)); } catch (e) {}
    updateQBtn();
    // 同一时间点换流：转码记下当前绝对位置作新 t；回原画加载后 seek 回去
    const pos = displayCur();
    const wasPlaying = !video.paused;
    qOff = QUALS[qIdx] ? pos : 0;
    if (QUALS[qIdx]) fetchEpDur();
    video.src = epUrl();
    video.playbackRate = SPEEDS[spIdx];
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = SPEEDS[spIdx];
      if (!qOff && pos > 0.5) video.currentTime = pos;
    }, { once: true });
    if (wasPlaying) {
      video.play().catch(() => {});
      $("spinner").classList.remove("hidden");
    }
    toast(QUALS[qIdx] ? Q_LABELS[qIdx] + " · 服务端实时转码" : "原画", 1400);
  });
  $("drawer-btn").addEventListener("click", openDrawer);
  $("drawer-close").addEventListener("click", closeDrawer);
  $("fp-replay").addEventListener("click", () => {
    $("finish-panel").classList.add("hidden");
    seekAbs(0);
    video.play().catch(() => {});
  });
  $("fp-home").addEventListener("click", closePlayer);

  /* ---- 手势教学 ---- */
  function showGestureHint() {
    const el = $("gesture-hint");
    el.classList.remove("hidden");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.add("hidden"), 3800);
  }
  function maybeHint() {
    let seen = false;
    try { seen = localStorage.getItem("dj_hint") === "1"; } catch (e) {}
    if (!seen) {
      showGestureHint();
      try { localStorage.setItem("dj_hint", "1"); } catch (e) {}
    }
  }
  $("gesture-hint").addEventListener("click", () => $("gesture-hint").classList.add("hidden"));
  $("help-btn").addEventListener("click", showGestureHint);

  /* ---- 位置持久化 ---- */
  window.addEventListener("pagehide", saveLastPos);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveLastPos(); });

  /* ---- 启动 ---- */
  updateSpeedBtn();
  updateQBtn();
  load(true);
  loadResume();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
