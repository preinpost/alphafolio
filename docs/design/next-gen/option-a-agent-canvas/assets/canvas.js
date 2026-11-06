/* Agent Canvas — publishing demo only. Mock data, no network, no real logic. */
(() => {
  const root = document.documentElement;
  const pref = () => localStorage.getItem("af-a-theme") || "system";
  const apply = () => {
    const m = pref();
    root.dataset.theme = m === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : m;
  };
  apply();

  const I = {
    chat: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/>',
  };
  const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
  window.icon = svg;

  const page = document.body.dataset.page;
  // Exactly the 5 menus of the real app (App.tsx NAV)
  const NAV = [
    ["chat", "chat.html", "챗"],
    ["portfolio", "portfolio.html", "투자", "trend"],
    ["journal", "journal.html", "일지", "book"],
    ["ledger", "ledger.html", "가계부", "wallet"],
    ["settings", "settings.html", "설정", "gear"],
  ];
  const navIcon = (i) => (i ? svg(i) : '<span class="orb"></span>');
  const CONVS = [
    ["오늘", [["삼성전자 10주 매수", "order.html"], ["보유 종목 점검 · ETH 감시", "chat.html", true]]],
    ["이번 주", [["이번 달 지출 정리", "chat.html", false, true], ["엔비디아 실적 발표 영향", "chat.html"], ["BTC 손절 감시 자동 매매", "chat.html"]]],
  ];
  const convList = () => CONVS.map(([when, items]) => `<div class="side-when">${when}</div>` + items.map(([t, h, active, unread]) => {
    const ds = document.body.dataset;
    const on = active ? page === "chat" && !("empty" in ds) && !ds.conv : h === "order.html" && ds.conv === "order";
    return `<a class="conv ${on ? "active" : ""}" href="${h}">${unread ? '<i class="dot" aria-label="안 읽음"></i>' : ""}<span>${t}</span><button class="del" aria-label="${t} 삭제" data-toast="대화를 지웠습니다">${svg("trash")}</button></a>`;
  }).join("")).join("");

  const rail = document.querySelector("[data-rail]");
  if (rail) {
    rail.className = "rail";
    rail.setAttribute("aria-label", "주요 화면");
    rail.innerHTML = `
      <a class="brand" href="chat-new.html"><span class="brand-mark"></span>alphafolio</a>
      <a class="btn sm block new" href="chat-new.html">${svg("plus")}새 대화</a>
      ${NAV.map(([k, h, l, i]) => `<a class="nav-item ${k === page ? "active" : ""}" href="${h}" ${k === page ? 'aria-current="page"' : ""}>${navIcon(i)}${l}</a>`).join("")}
      <div class="side-label">최근 대화</div>
      <div class="convs">${convList()}</div>
      <div class="rail-foot">
        <div class="who">ms<small>관리자</small></div>
        <button class="icon-btn plain" data-theme-toggle aria-label="테마 전환">${svg("moon")}</button>
        <button class="icon-btn plain" aria-label="로그아웃" data-toast="데모에서는 로그아웃하지 않습니다">${svg("logout")}</button>
      </div>`;
  }
  const drawer = document.getElementById("drawer");
  if (drawer) {
    drawer.innerHTML = `<div class="between" style="padding:0 4px 12px"><a class="brand" href="chat-new.html"><span class="brand-mark"></span>alphafolio</a><button class="icon-btn plain" data-close aria-label="닫기">${svg("x")}</button></div>
      <a class="btn sm block" href="chat-new.html">${svg("plus")}새 대화</a>
      <div class="side-label">최근 대화</div><div class="convs">${convList()}</div>`;
  }

  const tb = document.querySelector("[data-tabbar]");
  if (tb) {
    tb.className = "tabbar";
    tb.setAttribute("aria-label", "주요 화면");
    tb.innerHTML = NAV.map(([k, h, l, i]) => `<a href="${h}" class="${k === page ? "active" : ""}" ${k === page ? 'aria-current="page"' : ""}>${navIcon(i)}${l}</a>`).join("");
  }

  // Composer — chat only (real Composer.tsx: 이미지 첨부 · 입력 · 보내기/중지 · 면책 문구)
  document.querySelectorAll("[data-composer]").forEach((el) => {
    document.body.classList.add("has-composer");
    const chips = (el.dataset.chips || "").split("|").filter(Boolean);
    const busy = el.dataset.busy !== undefined;
    el.className = "composer-dock";
    el.innerHTML = `<div class="composer-inner">
      ${chips.length ? `<div class="suggest hscroll fade-x${el.dataset.chipsMobile !== undefined ? " mob" : ""}" role="group" aria-label="제안">${chips.map((c) => `<a class="sg" href="chat.html">${c}</a>`).join("")}</div>` : ""}
      <form class="composer" onsubmit="event.preventDefault(); location.href='chat.html'">
        <button type="button" class="icon-plain" aria-label="이미지 첨부">${svg("image")}</button>
        <label class="sr-only" for="cmp">메시지</label>
        <textarea id="cmp" rows="1" placeholder="${busy ? "응답 중 — 이어서 입력해도 돼요" : "무엇이든 물어보세요"}"></textarea>
        ${busy ? `<button type="button" class="send" aria-label="응답 중지" data-toast="응답을 멈췄습니다">${svg("stop")}</button>` : `<button class="send" aria-label="보내기">${svg("send")}</button>`}
      </form>
      <div class="disclaimer">AI 분석은 참고용이며, 투자 판단과 그 책임은 본인에게 있습니다.</div></div>`;
  });

  document.querySelectorAll("[data-i]").forEach((e) => (e.outerHTML = svg(e.dataset.i)));

  // Theme: quick toggle (sidebar) + settings picker (라이트/다크/시스템)
  const syncPick = () => document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === pref()));
  syncPick();
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-toggle]");
    const s = e.target.closest("[data-theme-set]");
    if (t) { e.preventDefault(); localStorage.setItem("af-a-theme", root.dataset.theme === "dark" ? "light" : "dark"); apply(); syncPick(); }
    if (s) { localStorage.setItem("af-a-theme", s.dataset.themeSet); apply(); syncPick(); }
  });

  // Toast
  const toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  document.body.appendChild(toastEl);
  let tt;
  window.toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(tt);
    tt = setTimeout(() => toastEl.classList.remove("show"), 2200);
  };
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toast]");
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    window.toast(t.dataset.toast);
  }, true);

  // Segmented tabs: <div class="seg" data-seg="grp"><button data-v="a">
  document.querySelectorAll(".seg[data-seg]").forEach((seg) => {
    const g = seg.dataset.seg;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.classList.contains("on")));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
      document.querySelectorAll(`[data-panel^="${g}:"]`).forEach((p) => (p.hidden = p.dataset.panel !== `${g}:${b.dataset.v}`));
      if (seg.dataset.hash !== undefined) history.replaceState(null, "", "#" + b.dataset.v);
      const sc = seg.closest(".hscroll");
      if (sc) sc.scrollTo({ left: b.offsetLeft - (sc.clientWidth - b.offsetWidth) / 2, behavior: "smooth" });
    });
    if (seg.dataset.hash !== undefined && location.hash) seg.querySelector(`[data-v="${location.hash.slice(1)}"]`)?.click();
  });

  // Single-select chip groups
  document.querySelectorAll("[data-chips]").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const on = b.getAttribute("aria-pressed") === "true";
    g.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", g.dataset.chips === "toggle" ? String(!on) : "true");
  }));
  // Pressable rows (계좌 → 그 계좌만)
  document.querySelectorAll("[data-press]").forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") === "true";
    document.querySelectorAll(`[data-press="${b.dataset.press}"]`).forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", String(!on));
    const pill = document.getElementById(b.dataset.press + "-pill");
    if (pill) { pill.hidden = on; pill.querySelector("b").textContent = b.querySelector(".name").firstChild.textContent.trim(); }
  }));
  document.querySelectorAll("[data-unpress]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(`[data-press="${b.dataset.unpress}"]`).forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.closest(".filter-pill").hidden = true;
  }));

  // Show/hide helpers: data-show="id" data-hide="id"
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-show]");
    const h = e.target.closest("[data-hide]");
    if (s) { e.preventDefault(); s.dataset.show.split(" ").forEach((id) => (document.getElementById(id).hidden = false)); if (s.dataset.selfHide !== undefined) s.hidden = true; }
    if (h) { e.preventDefault(); h.dataset.hide.split(" ").forEach((id) => (document.getElementById(id).hidden = true)); }
  });

  // Sheets & drawer
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  document.body.appendChild(scrim);
  const closeAll = () => { document.body.classList.remove("sheet-open"); document.querySelectorAll(".sheet.open,.drawer.open").forEach((s) => s.classList.remove("open")); };
  scrim.onclick = closeAll;
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); closeAll(); document.getElementById(o.dataset.open).classList.add("open"); document.body.classList.add("sheet-open"); }
    if (e.target.closest("[data-close]")) closeAll();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeAll());

  // Countdown: <span data-timer="272">
  document.querySelectorAll("[data-timer]").forEach((el) => {
    let s = +el.dataset.timer;
    const out = el.querySelector("b") || el;
    const tick = () => { out.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; if (s > 0) s--; };
    tick(); setInterval(tick, 1000);
  });

  // Slide-to-confirm + accessible two-step button alternative
  document.querySelectorAll(".slide").forEach((s) => {
    const knob = s.querySelector(".slide-knob"), fill = s.querySelector(".slide-fill"), label = s.querySelector(".slide-label span");
    let x0 = 0, dx = 0, max = 0, active = false;
    const set = (v) => { knob.style.transform = `translateX(${v}px)`; fill.style.width = v + 58 + "px"; };
    const finish = () => {
      max = s.clientWidth - 58; set(max); s.classList.add("done"); label.textContent = "접수하는 중입니다…"; alt.hidden = true;
      navigator.vibrate?.(20);
      setTimeout(() => s.dispatchEvent(new CustomEvent("confirmed", { bubbles: true })), 800);
    };
    knob.addEventListener("pointerdown", (e) => { if (s.classList.contains("done")) return; active = true; x0 = e.clientX; max = s.clientWidth - 58; s.classList.add("dragging"); knob.setPointerCapture(e.pointerId); });
    knob.addEventListener("pointermove", (e) => { if (!active) return; dx = Math.max(0, Math.min(max, e.clientX - x0)); set(dx); });
    const end = () => { if (!active) return; active = false; s.classList.remove("dragging"); if (dx > max * 0.9) finish(); else { set(0); dx = 0; } };
    knob.addEventListener("pointerup", end); knob.addEventListener("pointercancel", end);
    knob.tabIndex = 0;
    knob.setAttribute("role", "button");
    knob.setAttribute("aria-label", label.textContent);
    knob.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !s.classList.contains("done")) { e.preventDefault(); finish(); } });
    const alt = document.createElement("button");
    alt.type = "button";
    alt.className = "slide-alt";
    const altText = s.dataset.alt || "밀기 어려우면 버튼으로 확인";
    alt.textContent = altText;
    let armT;
    alt.addEventListener("click", () => {
      if (!alt.classList.contains("armed")) {
        alt.classList.add("armed"); alt.textContent = s.dataset.armed || "한 번 더 눌러 주문 보내기";
        clearTimeout(armT); armT = setTimeout(() => { alt.classList.remove("armed"); alt.textContent = altText; }, 4000);
      } else { clearTimeout(armT); if (!s.classList.contains("done")) finish(); }
    });
    s.insertAdjacentElement("afterend", alt);
  });

  // Line chart: <svg data-chart="1,2,3">
  document.querySelectorAll("svg[data-chart]").forEach((el) => {
    const v = el.dataset.chart.split(",").map(Number), w = 600, h = 200;
    const mn = Math.min(...v), mx = Math.max(...v), p = 10;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * w, p + (1 - (y - mn) / (mx - mn || 1)) * (h - p * 2)]);
    const d = pts.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
    const id = "g" + Math.random().toString(36).slice(2, 7);
    el.setAttribute("viewBox", `0 0 ${w} ${h}`);
    el.setAttribute("preserveAspectRatio", "none");
    el.setAttribute("role", "img");
    el.classList.add("chart");
    el.innerHTML = `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".2"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${h * f}" y2="${h * f}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>`).join("")}
      <path d="${d} L${w} ${h} L0 ${h}Z" fill="url(#${id})"/>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  });

  // Right-edge fade on horizontal scrollers: clears when scrolled to the end, fades left once scrolled
  document.querySelectorAll(".fade-x").forEach((el) => {
    const upd = () => {
      const fits = el.scrollWidth <= el.clientWidth + 1;
      const end = fits || el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      el.classList.toggle("at-end", end);
      el.classList.toggle("scrolled", el.scrollLeft > 2);
      el.classList.toggle("at-mid", !end && el.scrollLeft > 2);
    };
    el.addEventListener("scroll", upd, { passive: true });
    addEventListener("resize", upd);
    upd();
  });

  // Watch event toast demo: append #alert to any URL
  if (location.hash === "#alert") {
    const w = document.createElement("div");
    w.className = "watch-toast";
    w.setAttribute("role", "alert");
    w.innerHTML = `<span class="ic">${svg("bell")}</span><div class="grow"><b>감시 발동 · ETH 1시간봉</b><p>종가 2,588.40 USDT — 2,600 아래로 마감했습니다.</p><div class="row"><a class="btn xs primary" href="settings.html#watch">열기</a><button class="btn xs ghost" onclick="this.closest('.watch-toast').remove()">닫기</button></div></div>`;
    document.body.appendChild(w);
  }
})();
