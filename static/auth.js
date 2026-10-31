/* 访问令牌支持（需先于 app.js / watch.js 加载）
   - 令牌存 localStorage dj_token
   - 全局 fetch 包装：自动带 X-Auth-Token 头；401 时弹输入框引导
   - <img>/<video> 无法带请求头，URL 用 djToken.with() 补 ?token= */
(() => {
  const KEY = "dj_token";
  window.djToken = {
    get() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } },
    set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} },
    with(url) {
      const t = this.get();
      return t ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t) : url;
    },
  };

  const raw = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    init = init || {};
    const t = djToken.get();
    if (t) {
      const h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      h.set("X-Auth-Token", t);
      init.headers = h;
    }
    const res = await raw(input, init);
    if (res.status === 401) gate();
    return res;
  };

  let gating = false;
  function gate() {
    if (gating || document.getElementById("dj-gate")) return;
    gating = true;
    const box = document.createElement("div");
    box.id = "dj-gate";
    box.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:99999";
    box.innerHTML =
      '<form style="background:#1a1a22;color:#eee;padding:22px;border-radius:14px;display:flex;flex-direction:column;gap:12px;min-width:270px;font-family:sans-serif">' +
      "<b>此服务已启用访问令牌</b>" +
      '<span style="font-size:12px;color:#999">输入服务端 .env 中的 AUTH_TOKEN</span>' +
      '<input name="t" type="password" autocomplete="current-password" placeholder="访问令牌" autofocus ' +
      'style="padding:9px;border-radius:8px;border:1px solid #444;background:#0b0b12;color:#eee">' +
      '<button style="padding:9px;border:0;border-radius:8px;background:#FF2D55;color:#fff;font-weight:700">进入</button>' +
      "</form>";
    box.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      djToken.set(e.target.t.value.trim());
      location.reload();
    };
    document.body.appendChild(box);
  }
})();
