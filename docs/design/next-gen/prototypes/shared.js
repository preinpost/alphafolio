// 공용: 테마 토글, ⌘K 팔레트, 레일, 포맷터, 햅틱 흉내
const AF = (() => {
	const won = (n) => (n < 0 ? "-" : "") + "₩" + Math.abs(Math.round(n)).toLocaleString("ko-KR");
	const pct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";
	const signed = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(Math.round(n)).toLocaleString("ko-KR");
	const tone = (n) => (n > 0 ? "up" : n < 0 ? "down" : "muted");
	const haptic = (ms = 10) => navigator.vibrate?.(ms);

	function theme() {
		const saved = localStorage.getItem("af-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
		document.documentElement.dataset.theme = saved;
		const b = document.createElement("button");
		b.className = "chip toggle-theme";
		b.textContent = saved === "dark" ? "☀ 라이트" : "☾ 다크";
		b.onclick = () => {
			const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
			document.documentElement.dataset.theme = t;
			localStorage.setItem("af-theme", t);
			b.textContent = t === "dark" ? "☀ 라이트" : "☾ 다크";
		};
		document.body.appendChild(b);
	}

	function rail(active) {
		const items = [["home.html", "◎", "브리핑"], ["portfolio.html", "▦", "포트폴리오"], ["timeline.html", "≡", "타임라인"], ["order.html", "⇅", "주문"]];
		const el = document.querySelector(".rail");
		if (!el) return;
		el.innerHTML = `<a class="logo" href="index.html" title="AlphaFolio">α</a>` +
			items.map(([h, i, t]) => `<a href="${h}" title="${t}" class="${h === active ? "on" : ""}">${i}</a>`).join("") +
			`<div class="spacer"></div><a href="#" title="⌘K" onclick="AF.openPalette();return false">⌘</a>`;
	}

	const commands = [
		["이동", "브리핑 홈", "home.html", "G H"],
		["이동", "포트폴리오 딥뷰", "portfolio.html", "G P"],
		["이동", "머니 타임라인", "timeline.html", "G T"],
		["이동", "주문 확인 흐름", "order.html", "G O"],
		["에이전트", "삼성전자 10주 지정가 매수 준비", "order.html", "↵"],
		["에이전트", "이번 달 식비가 왜 늘었어?", "timeline.html", "↵"],
		["에이전트", "반도체 비중 30% 넘으면 알려줘", "home.html", "↵"],
		["에이전트", "환율 1,450원 되면 포트폴리오 어떻게 돼?", "portfolio.html#whatif", "↵"],
		["종목", "삼성전자 005930", "portfolio.html", ""],
		["종목", "NVIDIA NVDA", "portfolio.html", ""],
		["종목", "SK하이닉스 000660", "portfolio.html", ""],
	];
	let sel = 0;
	function palette() {
		const bg = document.createElement("div");
		bg.className = "palette-bg";
		bg.innerHTML = `<div class="palette"><input placeholder="명령, 종목, 또는 무엇이든 물어보세요…" /><ul></ul></div>`;
		document.body.appendChild(bg);
		const input = bg.querySelector("input"), ul = bg.querySelector("ul");
		const render = () => {
			const q = input.value.trim();
			let list = commands.filter((c) => !q || c[1].includes(q) || c[0].includes(q));
			if (q && !list.length) list = [["에이전트", `“${q}” 에이전트에게 묻기`, "home.html", "↵"]];
			sel = Math.min(sel, list.length - 1);
			let last = "";
			ul.innerHTML = list.map((c, i) => {
				const g = c[0] !== last ? `<div class="group">${(last = c[0])}</div>` : "";
				return `${g}<li class="${i === sel ? "sel" : ""}" data-h="${c[2]}"><span>${c[1]}</span><span class="k">${c[3]}</span></li>`;
			}).join("");
			ul.querySelectorAll("li").forEach((li) => (li.onclick = () => (location.href = li.dataset.h)));
		};
		input.oninput = () => { sel = 0; render(); };
		input.onkeydown = (e) => {
			const n = ul.querySelectorAll("li").length;
			if (e.key === "ArrowDown") { sel = (sel + 1) % n; render(); e.preventDefault(); }
			if (e.key === "ArrowUp") { sel = (sel - 1 + n) % n; render(); e.preventDefault(); }
			if (e.key === "Enter") ul.querySelectorAll("li")[sel]?.click();
		};
		bg.onclick = (e) => e.target === bg && bg.classList.remove("open");
		addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); AF.openPalette(); }
			if (e.key === "Escape") bg.classList.remove("open");
		});
		AF.openPalette = () => { bg.classList.add("open"); input.value = ""; sel = 0; render(); input.focus(); };
	}

	// 숫자 카운트업
	function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString("ko-KR"), dur = 900) {
		const t0 = performance.now();
		const step = (t) => {
			const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
			el.textContent = fmt(to * e);
			if (p < 1) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	// 스파크라인 SVG
	function spark(data, w = 120, h = 32, color = "currentColor", fill = true) {
		const min = Math.min(...data), max = Math.max(...data), r = max - min || 1;
		const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / r) * (h - 4) - 2]);
		const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
		const id = "g" + Math.random().toString(36).slice(2, 7);
		return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="color:${color};overflow:visible">
			${fill ? `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${d} L${w} ${h} L0 ${h}Z" fill="url(#${id})"/>` : ""}
			<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
	}
	const walk = (n, start, vol, drift = 0, seed = 7) => {
		let s = seed, v = start; const out = [];
		for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; v *= 1 + ((s / 233280 - 0.5) * vol + drift); out.push(v); }
		return out;
	};

	function init(active) { theme(); rail(active); palette(); }
	return { won, pct, signed, tone, haptic, init, countUp, spark, walk, openPalette: () => {} };
})();
