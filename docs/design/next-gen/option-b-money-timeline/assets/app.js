/* Alphafolio · Proposal B — demo-only interactions (no real functionality) */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- theme ---------- */
  const saved = localStorage.getItem("afB-theme");
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const q = new URLSearchParams(location.search).get("theme");
  document.documentElement.dataset.theme = q || saved || (prefersDark ? "dark" : "light");
  window.toggleTheme = () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    localStorage.setItem("afB-theme", t);
  };

  /* ---------- icons ---------- */
  const sv = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    chat: sv('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    trend: sv('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    book: sv('<path d="M4 4h11a3 3 0 0 1 3 3v14H7a3 3 0 0 1-3-3z"/><path d="M4 18a3 3 0 0 1 3-3h11"/><path d="M8 8h6"/>'),
    wallet: sv('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><circle cx="16.5" cy="15" r="1.2" fill="currentColor"/><path d="M6 6V5a2 2 0 0 1 2-2h9"/>'),
    gear: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    plus: sv('<path d="M12 5v14M5 12h14"/>', 2.2),
    menu: sv('<path d="M4 7h16M4 12h16M4 17h10"/>'),
    search: sv('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    x: sv('<path d="M18 6 6 18M6 6l12 12"/>', 2.2),
    moon: sv('<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>'),
    out: sv('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l-5-5 5-5M5 12h11"/>'),
    send: sv('<path d="M12 19V5M5 12l7-7 7 7"/>', 2.4),
    img: sv('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
    refresh: sv('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
    left: sv('<path d="M15 5l-7 7 7 7"/>', 2.2),
    right: sv('<path d="M9 5l7 7-7 7"/>', 2.2),
    down: sv('<path d="m6 9 6 6 6-6"/>', 2.2),
    edit: sv('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    trash: sv('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    copy: sv('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  };
  window.ICONS = I;
  $$("[data-icon]").forEach(el => { el.insertAdjacentHTML("afterbegin", I[el.dataset.icon] || ""); });

  const page = document.body.dataset.page;
  /* 실제 앱 App.tsx NAV 와 같은 5개 메뉴, 같은 순서 */
  const nav = [
    ["chat", "챗", "chat.html", I.chat],
    ["portfolio", "투자", "portfolio.html", I.trend],
    ["journal", "일지", "journal.html", I.book],
    ["ledger", "가계부", "ledger.html", I.wallet],
    ["settings", "설정", "settings.html", I.gear],
  ];
  /* 최근 대화 — 실제 앱 ConversationList 와 같은 묶음(오늘·어제·지난 7일·지난 30일·이전), 응답 중·새 답 점 */
  const convs = [
    { t: "하이닉스 일부 정리할까", g: "오늘" },
    { t: "삼성전자 실적 발표 정리", g: "오늘", live: true },
    { t: "11월 지출 정리", g: "어제", unread: true },
    { t: "ETH 4시간봉 감시", g: "지난 7일" },
    { t: "미국 배당주 비교", g: "지난 7일" },
    { t: "BTC 선물 롱 진입", g: "지난 30일" },
    { t: "TradingView 알림 정리", g: "지난 30일" },
    { t: "연금저축 ETF 고르기", g: "이전" },
  ];
  window.CONVS = convs;
  const qs = new URLSearchParams(location.search);
  /* 챗 화면에서만 보고 있는 대화가 있다 (새 대화면 없음) */
  const curConv = page === "chat" && !qs.get("new") ? +(qs.get("c") || 0) : -1;
  const esc = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const convList = () => {
    let last = "";
    return convs.map((c, i) => {
      const head = c.g !== last ? `<div class="conv-group">${c.g}</div>` : ""; last = c.g;
      const dot = c.live ? `<span class="dot live" role="img" aria-label="응답 중" title="응답 중"></span>`
        : c.unread && i !== curConv ? `<span class="dot" role="img" aria-label="새 답" title="새 답"></span>` : "";
      return `${head}<div class="conv-row ${c.unread && i !== curConv ? "unread" : ""}" ${i === curConv ? 'aria-current="true"' : ""}>
        <a class="conv-open" href="chat.html?c=${i}"><span class="t">${esc(c.t)}</span>${dot}</a>
        <button class="conv-del" data-del="${i}" aria-label="&quot;${esc(c.t)}&quot; 삭제" title="삭제">${I.trash}</button></div>`;
    }).join("");
  };
  const navHtml = () => nav.map(([k, l, h, ic]) => `<a href="${h}" class="nav-item ${k === page ? "on" : ""}" ${k === page ? 'aria-current="page"' : ""}>${ic}<span>${l}</span></a>`).join("");

  /* ---------- shell — 실제 앱 App.tsx 와 같은 구조 ----------
     ≥768px: 왼쪽 사이드바(로고 · 새 대화 · 메뉴 5 · 최근 대화 · 상태/나) + 본문(화면마다 자기 topbar)
     <768px: 하단 탭바 + 챗 화면의 ☰ 로 여는 왼쪽 대화 드로어 (대화를 읽는 중에는 탭바를 접는다) */
  const app = $(".app");
  if (app && !document.body.hasAttribute("data-noshell")) {
    const shell = document.createElement("div");
    shell.className = "shell";
    app.parentNode.insertBefore(shell, app);
    const side = document.createElement("aside");
    side.className = "sidebar";
    side.innerHTML = `<div class="side-head"><a class="side-brand" href="chat.html" aria-label="홈(챗)으로"><i>α</i>AlphaFolio</a></div>
      <a class="btn soft side-new" href="chat.html?new=1">${I.plus}새 대화</a>
      <nav class="nav" aria-label="주요 화면">${navHtml()}</nav>
      <div class="side-label">최근 대화</div>
      <div class="convs">${convList()}</div>
      <div class="side-foot">
        <div class="status-line"><span class="led"></span><span class="t" title="anthropic/claude-sonnet-4.5">claude-sonnet-4.5</span><span class="ver num">v0.42.0</span></div>
        <div class="side-me"><span class="avatar">MS</span><span class="who">민수<small>관리자</small></span>
          <button class="icon-btn sm" onclick="toggleTheme()" aria-label="테마 전환" title="테마 전환">${I.moon}</button>
          <button class="icon-btn sm" aria-label="로그아웃" title="로그아웃" data-toast="로그아웃 (데모)">${I.out}</button></div>
      </div>`;
    shell.append(side, app);

    const tab = document.createElement("nav");
    tab.className = "tabbar";
    tab.setAttribute("aria-label", "주요 화면");
    tab.innerHTML = nav.map(([k, l, h, ic]) => `<a href="${h}" class="${k === page ? "on" : ""}" ${k === page ? 'aria-current="page"' : ""}>${ic}${l}</a>`).join("");
    document.body.append(tab);

    /* 모바일 대화 드로어 — 실제 앱처럼 화면 이동(메뉴)도 여기서 한다 */
    const drawer = document.createElement("div");
    drawer.className = "drawer";
    drawer.inert = true;
    drawer.innerHTML = `<div class="dscrim"></div>
      <div class="panel" role="dialog" aria-label="메뉴">
        <div class="panel-h"><strong>AlphaFolio</strong><button class="icon-btn" data-drawer-close aria-label="닫기">${I.x}</button></div>
        <a class="btn soft side-new" href="chat.html?new=1">${I.plus}새 대화</a>
        <nav class="nav" aria-label="주요 화면">${navHtml()}</nav>
        <div class="side-label">최근 대화</div>
        <div class="convs">${convList()}</div>
      </div>`;
    document.body.append(drawer);
    const setDrawer = on => { drawer.classList.toggle("open", on); drawer.inert = !on; };
    window.openDrawer = () => setDrawer(true);
    window.closeDrawer = () => setDrawer(false);
    drawer.querySelector(".dscrim").onclick = closeDrawer;
    drawer.querySelector("[data-drawer-close]").onclick = closeDrawer;
    document.addEventListener("click", e => { if (e.target.closest("[data-drawer]")) openDrawer(); });
    /* Esc 로 닫기 · 데스크톱 폭이 되면 닫기 (App.tsx 와 같음) */
    addEventListener("keydown", e => e.key === "Escape" && closeDrawer());
    matchMedia("(min-width: 768px)").addEventListener("change", m => m.matches && closeDrawer());
    /* 챗 화면 왼쪽 가장자리(24px)에서 밀어 열기 · 열린 드로어를 왼쪽으로 밀어 닫기 */
    let sx = null;
    addEventListener("touchstart", e => { const t = e.touches[0]; if (innerWidth >= 768) return; if (drawer.classList.contains("open") || (page === "chat" && t.clientX < 24)) sx = t.clientX; }, { passive: true });
    addEventListener("touchend", e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (dx > 90) openDrawer(); if (dx < -90) closeDrawer(); }, { passive: true });

    /* 대화 삭제 — 되돌릴 수 없어 확인을 받는다 (응답 중이면 답도 멈춘다고 알림) */
    const del = document.createElement("div");
    del.className = "sheet"; del.id = "sheet-convdel";
    del.setAttribute("role", "dialog"); del.setAttribute("aria-label", "대화 삭제");
    del.innerHTML = `<div class="grab"></div><h3>대화를 삭제할까요?</h3><p class="lead" id="convDelText"></p>
      <div class="actions"><button class="btn" data-close>취소</button><button class="btn danger" id="convDelOk">삭제</button></div>`;
    document.body.append(del);
    let delI = -1;
    document.addEventListener("click", e => {
      const b = e.target.closest("[data-del]"); if (!b) return;
      e.preventDefault(); delI = +b.dataset.del; const c = convs[delI];
      $("#convDelText").innerHTML = `“${esc(c.t)}”<br>되돌릴 수 없습니다.${c.live ? " 작성 중인 답도 멈춥니다." : ""}`;
      closeDrawer(); openSheet("convdel");
    });
    $("#convDelOk").onclick = () => {
      $$(`[data-del="${delI}"]`).forEach(b => b.closest(".conv-row").remove());
      closeSheets(); toast("대화를 삭제했습니다");
    };
  }
  /* 대화를 읽는 중(메시지 있음)에는 모바일 탭바를 접는다 — App.tsx .chat-reading */
  if (page === "chat" && !qs.get("new")) document.body.classList.add("chat-reading");

  /* fake replies — publishing demo only (조회 결과는 카드 없이 텍스트로) */
  const canned = [
    { steps: ["시세 조회 · 005930"], text: "삼성전자는 지금 <b>61,400원</b>, 전일 대비 <b class='up'>+1.32%</b>예요." },
    { steps: ["보유 종목 조회 · 3개 계좌"], text: "보유 14종목 중 9개가 수익이에요. SK하이닉스 비중이 <b>22.4%</b>로 가장 커요." },
    { steps: ["가계부 · 11월 조회"], text: "11월 지출은 <b>1,128,400원</b>이에요. 식비가 41%로 가장 많아요." },
  ];
  let ci = 0;
  document.addEventListener("submit", e => {
    const f = e.target.closest("[data-composer]"); if (!f) return;
    e.preventDefault();
    const inp = f.querySelector("input"); talk(f.closest(".sheet, .app") || document, inp.value || "삼성전자 얼마야"); inp.value = "";
  });
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-sugs] button"); if (b) talk(b.closest(".sheet, .app") || document, b.textContent);
  });
  function talk(root, text) {
    const box = root.querySelector("[data-msgs]"); if (!box) return;
    $$(".hello", root).forEach(h => h.remove());
    const inPage = box.closest(".app");
    const scroll = () => inPage ? scrollTo({ top: 1e6, behavior: "smooth" }) : (box.scrollTop = 1e6);
    const r = canned[ci++ % canned.length];
    box.insertAdjacentHTML("beforeend", `<div class="msg me">${text}</div>`);
    const t = document.createElement("div"); t.className = "msg ai typing"; t.innerHTML = "<span></span><span></span><span></span>";
    box.append(t); scroll();
    setTimeout(() => {
      t.remove();
      r.steps.forEach(s => box.insertAdjacentHTML("beforeend", `<div class="tool-step"><i>✓</i>${s}</div>`));
      box.insertAdjacentHTML("beforeend", `<div class="msg ai">${r.text}</div>`);
      scroll();
    }, 800);
  }

  /* ---------- sheets ---------- */
  let scrim = $(".scrim");
  if (!scrim) { scrim = document.createElement("div"); scrim.className = "scrim"; document.body.append(scrim); }
  window.openSheet = id => {
    $$(".sheet.on").forEach(s => s.classList.remove("on"));
    const s = $("#sheet-" + id); if (!s) return;
    s.classList.add("on"); scrim.classList.add("on");
  };
  window.closeSheets = () => { $$(".sheet.on").forEach(s => s.classList.remove("on")); scrim.classList.remove("on"); };
  scrim.onclick = closeSheets;
  /* 대화상자 기본 동작 — Esc 로 닫기 (단축키 아님) */
  addEventListener("keydown", e => e.key === "Escape" && closeSheets());
  document.addEventListener("click", e => {
    const o = e.target.closest("[data-open]"); if (o) { e.preventDefault(); openSheet(o.dataset.open); }
    if (e.target.closest("[data-close]")) closeSheets();
  });
  /* drag-to-dismiss on grab handle */
  document.addEventListener("pointerdown", e => {
    const g = e.target.closest(".grab"); if (!g) return;
    const s = g.closest(".sheet"); const y0 = e.clientY;
    const mv = ev => { const d = Math.max(0, ev.clientY - y0); s.style.transition = "none"; s.style.transform = `translate(-50%, ${d}px)`; };
    const up = ev => { s.style.transition = ""; s.style.transform = ""; if (ev.clientY - y0 > 100) closeSheets(); removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });

  /* ---------- segmented / tabs / single-select groups ---------- */
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (b) {
      const group = b.parentElement;
      $$("[data-tab]", group).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
      const scope = b.dataset.scope ? $(b.dataset.scope) : document;
      $$("[data-panel]", scope).forEach(p => p.classList.toggle("on", p.dataset.panel === b.dataset.tab));
      return;
    }
    const s = e.target.closest(".seg > button, .pick > button, [data-one] > button");
    if (s) $$(":scope > button", s.parentElement).forEach(x => { x.classList.toggle("on", x === s); x.setAttribute("aria-pressed", x === s); });
  });

  /* ---------- toast ---------- */
  let toastEl;
  window.toast = msg => {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; toastEl.setAttribute("role", "status"); document.body.append(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("on");
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove("on"), 2200);
  };
  document.addEventListener("click", e => { const t = e.target.closest("[data-toast]"); if (t) toast(t.dataset.toast); });

  /* ---------- count up ---------- */
  window.countUp = (el, to, ms = 1100) => {
    const t0 = performance.now();
    const step = t => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 4);
      el.textContent = Math.round(to * e).toLocaleString("ko-KR");
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  $$("[data-count]").forEach(el => countUp(el, +el.dataset.count));

  /* ---------- demo bar ---------- */
  if (!document.body.hasAttribute("data-nodemo")) {
    const d = document.createElement("div"); d.className = "demo-bar";
    d.innerHTML = `<a href="index.html" aria-label="개요로">←<span>개요</span></a><button onclick="toggleTheme()" aria-label="테마 전환">${I.moon.replace("<svg", '<svg width="16" height="16"')}<span>테마</span></button>`;
    const tb = $(".app .topbar");
    if (tb) { d.classList.add("inline"); tb.append(d); } else document.body.append(d);
  }
  if (new URLSearchParams(location.search).get("sheet")) addEventListener("load", () => openSheet(new URLSearchParams(location.search).get("sheet")));
})();
