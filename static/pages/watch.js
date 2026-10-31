/* 桌面播放页：逐集播放、断点续播、选集/倍速/进度 */
import { $, api, patch, esc } from "../shared.js";

const watch = { id: null, eps: [], cur: 0 };

export async function renderWatch([id, ep]) {
  const d = await api(`/api/dramas/${id}`);
  watch.id = d.id;
  watch.eps = d.episodes;
  const target = Number(ep) || d.last_episode || d.episodes[0]?.ep;
  $("#watch-title").textContent = d.title;

  const sel = $("#ep-select");
  sel.innerHTML = d.episodes.map((e) => `<option value="${e.ep}">第 ${e.ep} 集</option>`).join("");
  sel.onchange = () => playEpisode(Number(sel.value));

  $("#ep-grid").innerHTML = d.episodes
    .map((e) => `<button data-ep="${e.ep}" title="${esc(e.file)} · ${e.size_mb}MB">${e.ep}</button>`)
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

  patch(`/api/dramas/${watch.id}`, { last_episode: ep, watch_state: "watching" });

  $("#ep-grid").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("current", Number(b.dataset.ep) === ep);
  });
  $(`#ep-grid button[data-ep="${ep}"]`)?.scrollIntoView({ block: "nearest" });
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
