/* Alphafolio — Proposal C · Pro Workspace — 데모 동작만 (API 없음) */
(function () {
  const root = document.documentElement;
  const saved = localStorage.getItem("af-c-theme");
  root.dataset.theme = saved === "light" || saved === "dark" ? saved : root.dataset.theme || "dark";

  const s = (d, w = 1.7) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    chat: s('<path d="M4 5h16v11H9l-5 4z"/>'),
    trend: s('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    journal: s('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M9 9h6M9 13h6"/>'),
    wallet: s('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>'),
    gear: s('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>', 2),
    refresh: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
    search: s('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 2),
    x: s('<path d="M6 6l12 12M18 6L6 18"/>', 2),
    left: s('<path d="M15 6l-6 6 6 6"/>', 2),
    right: s('<path d="M9 6l6 6-6 6"/>', 2),
    down: s('<path d="M6 9l6 6 6-6"/>', 2),
    up: s('<path d="M6 15l6-6 6 6"/>', 2),
    menu: s('<path d="M4 7h16M4 12h16M4 17h10"/>', 2),
    edit: s('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
    send: s('<path d="M12 19V5M6 11l6-6 6 6"/>', 2.2),
    image: s('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
    check: s('<path d="M5 12l5 5 9-10"/>', 2.2),
    alert: s('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>'),
    info: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    shield: s('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
    copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    trash: s('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    pause: s('<path d="M9 5v14M15 5v14"/>', 2.2),
    play: s('<path d="M7 5l12 7-12 7z"/>'),
    spark: s('<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/>'),
    loader: s('<path d="M12 3a9 9 0 1 1-9 9"/>', 2.2),
    sun: s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: s('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    logout: s('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
    link: s('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    stop: s('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  };
  window.I = I;
  // [data-i="name"] → svg
  const paintIcons = (scope = document) => scope.querySelectorAll("[data-i]").forEach((el) => { if (!el.dataset.painted) { el.insertAdjacentHTML("afterbegin", I[el.dataset.i] || ""); el.dataset.painted = "1"; } });
  window.paintIcons = paintIcons;

  const NAV = [["chat", "챗", "chat"], ["portfolio", "투자", "trend"], ["journal", "일지", "journal"], ["ledger", "가계부", "wallet"], ["settings", "설정", "gear"]];
  const page = document.body.dataset.page;

  const rail = document.querySelector(".rail");
  if (rail) {
    rail.setAttribute("aria-label", "주요 화면");
    rail.innerHTML = `<a href="index.html" class="logo" title="시안 개요" aria-label="시안 개요">α</a>` +
      NAV.map(([p, l, i]) => `<a href="${p}.html" class="${p === page ? "on" : ""}" ${p === page ? 'aria-current="page"' : ""}>${I[i]}${l}</a>`).join("") +
      `<span class="sp"></span><button class="icon-btn" data-theme-toggle aria-label="테마 전환">${I.moon}</button><span class="avatar" title="ms · 관리자">MS</span>`;
  }
  const tabbar = document.querySelector(".tabbar");
  if (tabbar) {
    tabbar.setAttribute("aria-label", "주요 화면");
    tabbar.innerHTML = NAV.map(([p, l, i]) => `<a href="${p}.html" class="${p === page ? "on" : ""}" ${p === page ? 'aria-current="page"' : ""}>${I[i]}${l}${p === "chat" && page !== "chat" ? '<i class="dot" aria-label="새 답"></i>' : ""}</a>`).join("");
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-toggle]");
    if (t) { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; localStorage.setItem("af-c-theme", root.dataset.theme); }
  });

  /* 세그먼트·칩: 같은 그룹 안에서 하나만 */
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".seg button, [data-single] > .chip");
    if (!b) return;
    b.parentElement.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  });

  /* 시트 */
  let scrim = document.querySelector(".scrim");
  if (!scrim) { scrim = document.createElement("div"); scrim.className = "scrim"; document.body.append(scrim); }
  let last = null;
  window.openSheet = (id) => {
    document.querySelectorAll(".sheet.open, .drawer.open").forEach((x) => x.classList.remove("open"));
    const el = document.getElementById(id);
    if (!el) return;
    last = document.activeElement;
    el.classList.add("open"); document.body.classList.add("sheet-open");
    el.tabIndex = -1;
    setTimeout(() => (el.querySelector("[data-autofocus]") || el).focus({ preventScroll: true }), 50);
  };
  window.closeSheet = () => {
    document.querySelectorAll(".sheet.open, .drawer.open").forEach((x) => x.classList.remove("open"));
    document.body.classList.remove("sheet-open");
    last?.focus?.({ preventScroll: true });
  };
  scrim.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]"); if (o) { e.preventDefault(); openSheet(o.dataset.open); }
    if (e.target.closest("[data-close]")) closeSheet();
  });

  let tt;
  window.toast = (msg) => {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
    el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), 2200);
  };
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-toast]"); if (t) toast(t.dataset.toast); });

  /* 차트 — 총자산 추이 (area) */
  window.areaChart = (vals, { w = 600, h = 150, color = "var(--accent)" } = {}) => {
    const min = Math.min(...vals), max = Math.max(...vals), pad = 8;
    const xs = (i) => (i / (vals.length - 1)) * w, ys = (v) => pad + (1 - (v - min) / (max - min || 1)) * (h - pad * 2);
    const d = vals.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join("");
    const id = "g" + Math.random().toString(36).slice(2, 7);
    const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${h * f}" y2="${h * f}" stroke="var(--line)" stroke-dasharray="2 4"/>`).join("");
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="총자산 추이"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${d}L${w},${h}L0,${h}Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="${w}" cy="${ys(vals.at(-1))}" r="3.5" fill="${color}"/></svg>`;
  };

  /* 확인 카드 — 길게 눌러 확정 + 버튼 대안 */
  window.wireConfirm = (scope = document) => {
    scope.querySelectorAll(".confirm").forEach((card) => {
      if (card.dataset.wired) return; card.dataset.wired = "1";
      const hold = card.querySelector(".hold-btn");
      const left = card.querySelector(".c-h .left");
      const bar = card.querySelector(".expiry i");
      let remain = Number(card.dataset.remain || 272), total = Number(card.dataset.total || 300);
      const tick = () => {
        if (!card.isConnected || card.classList.contains("done") || card.classList.contains("closed")) return clearInterval(iv);
        remain = Math.max(0, remain - 1);
        if (left) left.textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")} 후 만료`;
        if (bar) bar.style.width = `${(remain / total) * 100}%`;
      };
      const iv = setInterval(tick, 1000); tick();
      const done = () => {
        const f = card.querySelector(".c-f");
        f.innerHTML = `<div class="c-done"><span class="badge warn"><span class="spin-i">${I.loader}</span>접수 중</span>접수하는 중입니다.</div>`;
        setTimeout(() => {
          card.classList.add("done"); card.querySelector(".expiry")?.remove(); if (left) left.textContent = "";
          f.innerHTML = `<div class="c-done"><span class="badge ok">${I.check.replace("<svg", '<svg width="11" height="11"')}완료</span>${card.dataset.doneMsg || "접수되었습니다 (데모 — 실제로 전송되지 않음)"}</div>`;
        }, 900);
      };
      card.querySelector("[data-dismiss]")?.addEventListener("click", () => {
        card.classList.add("closed"); card.querySelector(".expiry")?.remove(); if (left) left.textContent = "닫음";
        card.querySelector(".c-f").innerHTML = `<div class="c-done">닫았습니다. 필요하면 다시 요청하세요.</div>`;
      });
      if (hold) {
        let tm;
        const start = (e) => { if (e.button > 0) return; hold.classList.add("holding"); tm = setTimeout(() => { hold.classList.remove("holding"); done(); }, 800); };
        const cancel = () => { hold.classList.remove("holding"); clearTimeout(tm); };
        hold.addEventListener("pointerdown", start);
        ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => hold.addEventListener(ev, cancel));
        // 키보드·스크린리더(클릭 detail 0)는 누르면 바로 확정 — 길게 누르기는 포인터 전용 안전장치
        hold.addEventListener("click", (e) => { if (e.detail === 0) done(); });
      }
      // 길게 누르기 대안 — 일반 버튼 하나로 바꾼다 (탭 한 번 = 확정)
      const now = card.querySelector(".now-btn");
      now?.addEventListener("click", done);
      card.querySelector("[data-alt]")?.addEventListener("click", (e) => {
        const on = now.hidden;
        now.hidden = !on; hold.hidden = on;
        e.currentTarget.textContent = on ? "길게 눌러 확정으로" : "길게 누르기 어려우면 — 버튼으로 확정";
        (on ? now : hold).focus();
      });
    });
  };

  paintIcons();
  document.addEventListener("DOMContentLoaded", () => { paintIcons(); wireConfirm(); });
  if (document.readyState !== "loading") wireConfirm();
})();
