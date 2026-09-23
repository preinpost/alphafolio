/**
 * 서버 스모크 테스트 — 기동 → 로그인 → 가계부 REST → WS 대화 왕복.
 *
 * 실행: node apps/server/scripts/smoke.mjs
 * 서버를 임의 포트로 직접 띄우고 끝나면 종료시킨다 (실행 중인 서버가 있어도 충돌 없음).
 */
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { hashPassword } from "../src/users.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = "smoke";
const PASSWORD = "smoke-pw-1234";
const USER2 = "smoke2user";
const PASSWORD2 = "smoke2-pw-5678";
const SECRET = "smoke-secret-fixed";

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const server = spawn(process.execPath, [join(ROOT, "apps/server/src/index.ts")], {
	cwd: ROOT,
	env: {
		...process.env,
		AF_PORT: String(PORT),
		AF_HOST: "127.0.0.1",
		// 멀티유저 — scrypt 해시 목록
		AF_USERS: JSON.stringify([
			{ name: USER, passwordHash: hashPassword(PASSWORD) },
			{ name: USER2, passwordHash: hashPassword(PASSWORD2) },
		]),
		AF_AUTH_SECRET: SECRET,
		// env 폴백 검증용 (카탈로그에 있는 사용자 스코프 키)
		NCP_APIGW_API_KEY_ID: "env-fallback-value-xyz",
		AF_DATA_DIR: join(ROOT, ".data/smoke"),
		// 시도 제한을 짧게 잡아 테스트 가능하게 한다 (기본 5회/300초 → 900초 잠금)
		AF_LOGIN_MAX_ATTEMPTS: "3",
		AF_LOGIN_WINDOW_SEC: "60",
		AF_LOGIN_LOCKOUT_SEC: "2",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

const stop = () => {
	server.kill("SIGTERM");
	setTimeout(() => server.kill("SIGKILL"), 2000).unref();
};

async function waitForHealth(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`서버가 조기 종료됨 (code=${server.exitCode})\n${serverLog}`);
		try {
			const r = await fetch(`${BASE}/api/health`);
			if (r.ok) return r.json();
		} catch {
			/* 아직 기동 전 */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`기동 타임아웃\n${serverLog}`);
}

async function main() {
	console.log("\n── 기동 ──────────────────────────────────────────────");
	const health = await waitForHealth();
	check("기동 + /api/health", health.ok === true, `model=${health.model} ledger=${health.ledger}`);

	console.log("\n── 인증 ──────────────────────────────────────────────");
	const noAuth = await fetch(`${BASE}/api/state`);
	check("토큰 없이 /api/state 차단", noAuth.status === 401, `HTTP ${noAuth.status}`);

	const badLogin = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user: USER, password: "wrong" }),
	});
	check("잘못된 비밀번호 거부", badLogin.status === 401, `HTTP ${badLogin.status}`);

	// 시도 제한 — 한도(3회)를 넘기면 429 + Retry-After
	let limited = null;
	for (let i = 0; i < 4; i++) {
		const r = await fetch(`${BASE}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ user: USER, password: `wrong-${i}` }),
		});
		if (r.status === 429) {
			limited = { attempt: i + 1, retryAfter: r.headers.get("retry-after") };
			break;
		}
	}
	check(
		"반복 실패 시 잠금(429)",
		limited !== null,
		limited ? `${limited.attempt}번째 시도에서 차단, Retry-After=${limited.retryAfter}s` : "차단되지 않음",
	);

	// 올바른 비밀번호도 잠금 중에는 막힌다
	const duringLock = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user: USER, password: PASSWORD }),
	});
	check("잠금 중에는 정상 비밀번호도 거부", duringLock.status === 429, `HTTP ${duringLock.status}`);

	// 잠금 해제 대기 (AF_LOGIN_LOCKOUT_SEC=2)
	await new Promise((r) => setTimeout(r, 2500));

	const login = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user: USER, password: PASSWORD }),
	});
	check("잠금 해제 후 로그인 성공", login.ok, `HTTP ${login.status}`);
	const { token } = await login.json();
	check("로그인 → 토큰 발급", typeof token === "string" && token.includes("."), `len=${token?.length}`);

	const authed = { authorization: `Bearer ${token}` };
	const state = await fetch(`${BASE}/api/state`, { headers: authed });
	const stateBody = await state.json();
	check("토큰으로 /api/state 접근", state.ok, `툴 ${stateBody.tools?.length ?? 0}개`);

	console.log("\n── 가계부 REST (에이전트 우회 경로) ──────────────────");
	let txId = null;
	if (health.ledger) {
		const created = await fetch(`${BASE}/api/ledger/transactions`, {
			method: "POST",
			headers: { ...authed, "content-type": "application/json" },
			body: JSON.stringify({
				date: new Date().toISOString().slice(0, 10),
				amount: 4500,
				type: "expense",
				category: "식비",
				merchant: "[smoke] 테스트",
			}),
		});
		const tx = await created.json();
		txId = tx.id;
		check("POST /api/ledger/transactions", created.ok && tx.amount === -4500, `id=${tx.id}`);

		const month = new Date().toISOString().slice(0, 7);
		const sum = await fetch(`${BASE}/api/ledger/summary?from=${month}-01&to=${month}-31`, { headers: authed });
		const rows = await sum.json();
		check("GET /api/ledger/summary", sum.ok && Array.isArray(rows), `${rows.length}개 카테고리`);

		const del = await fetch(`${BASE}/api/ledger/transactions/${txId}`, { method: "DELETE", headers: authed });
		const delBody = await del.json();
		check("DELETE /api/ledger/transactions/:id", del.ok && delBody.deleted === true);
	} else {
		check("가계부 REST", false, "AF_D1_* 미설정으로 건너뜀");
	}

	console.log("\n── 멀티유저 격리 ─────────────────────────────────────");
	const login2 = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user: USER2, password: PASSWORD2 }),
	});
	const body2 = await login2.json();
	check("두번째 계정 로그인", login2.ok && body2.user === USER2, `user=${body2.user}`);

	const me1 = await (await fetch(`${BASE}/api/me`, { headers: authed })).json();
	const me2 = await (
		await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${body2.token}` } })
	).json();
	check("토큰마다 다른 사용자로 식별", me1.user === USER && me2.user === USER2, `${me1.user} / ${me2.user}`);

	// 한쪽 대화가 다른 쪽으로 새지 않는지 — user2 소켓을 열어두고 user1이 대화한다
	const eavesdrop = await wsWatch(body2.token);
	const isolated = await wsTest(token, "짧게 인사만 해줘.");
	await new Promise((r) => setTimeout(r, 500));
	eavesdrop.close();
	check(
		"다른 사용자 소켓으로 이벤트 누출 없음",
		eavesdrop.received.length === 0,
		eavesdrop.received.length === 0 ? "누출 0건" : `누출 ${eavesdrop.received.length}건: ${eavesdrop.received.join(",")}`,
	);
	check("격리 상태에서도 본인 응답은 수신", isolated.text.length > 0);

	// 대화별 세션 (PLAN §24) — 대화 id 는 URL 에 들어간다. 남의 대화 id 로는 열 수 없어야 한다.
	console.log("\n── 대화별 세션 · 백그라운드 응답 ─────────────────────");
	const stolen = await wsOpen(body2.token, isolated.sessionId);
	check(
		"다른 사용자의 대화 id 로는 열 수 없음",
		stolen.type === "session_missing",
		`${stolen.type}${stolen.messages ? ` (메시지 ${stolen.messages.length}개 노출)` : ""}`,
	);
	const mine = await wsOpen(token, isolated.sessionId);
	check(
		"내 대화는 id 로 다시 열림 (이전 메시지 복원)",
		mine.type === "ready" && mine.sessionId === isolated.sessionId && mine.messages.length >= 2,
		`${mine.type} 메시지 ${mine.messages?.length ?? 0}개`,
	);

	// 탭 A 는 대화 X 를 보고, 탭 B 가 새 대화에서 묻는다 — A 에는 내용이 아니라 활동 표시만 가야 한다
	const tabA = wsWatch(token, isolated.sessionId);
	const tabB = await wsTest(token, "한 단어로만 답해: 하늘은 무슨 색?");
	await new Promise((r) => setTimeout(r, 500));
	tabA.close();
	const crossTalk = tabA.received.filter((t) => t !== "activity");
	check(
		"다른 대화를 보는 탭에는 활동 표시만",
		tabB.sessionId !== isolated.sessionId && crossTalk.length === 0 && tabA.received.includes("activity"),
		`받은 것: ${tabA.received.join(",") || "(없음)"}`,
	);

	// 묻고 바로 앱을 끈다 → 서버가 끝까지 답하고 → 다시 열면 답이 있다
	const bg = await wsFireAndClose(token, "숫자 1부터 5까지 쉼표로 이어서 한 줄로만 써줘.");
	let listed = null;
	for (let i = 0; i < 90 && bg.sessionId; i++) {
		const list = await (await fetch(`${BASE}/api/sessions`, { headers: authed })).json();
		listed = list.find((x) => x.id === bg.sessionId) ?? null;
		if (listed && !listed.streaming && listed.messageCount >= 2) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	const reopened = bg.sessionId ? await wsOpen(token, bg.sessionId) : { type: "none" };
	const answer = (reopened.messages ?? [])
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.content)
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	check(
		"소켓을 끊어도 답이 끝까지 만들어짐 (다시 열면 보임)",
		reopened.type === "ready" && /1.*2.*3.*4.*5/.test(answer),
		`목록 ${listed ? `"${listed.title}" streaming=${listed.streaming}` : "없음"} / 답 "${answer.slice(0, 40)}"`,
	);
	check("대화 목록 제목 = 첫 메시지", listed?.title?.startsWith("숫자 1부터 5까지") === true, listed?.title ?? "(없음)");

	// 이미지 첨부 — 서버 검증 → 모델까지 실제로 가는지 (단색 PNG 의 색을 맞히게 한다)
	console.log("\n── 이미지 첨부 ───────────────────────────────────────");
	const fake = await wsTest(token, "이거 봐줘", [{ mimeType: "image/png", data: Buffer.from("%PDF-1.7 not an image").toString("base64") }]);
	check("이미지가 아닌 첨부는 모델 호출 전에 거절", /지원하는 이미지/.test(fake.error ?? ""), fake.error ?? "(오류 없음)");
	const red = await wsTest(token, "이 이미지는 무슨 색이야? 색 이름 한 단어로만 답해.", [{ mimeType: "image/png", data: solidPng(64, 64, [230, 20, 20]) }]);
	check("모델이 첨부 이미지를 읽음", /빨|레드|red|적색/i.test(red.text), red.error ?? red.text.slice(0, 40));
	const redBack = red.sessionId ? await wsOpen(token, red.sessionId) : {};
	check(
		"첨부 이미지가 대화에 남음 (다시 열면 보임)",
		(redBack.messages ?? []).some((m) => m.role === "user" && m.content.some((b) => b.type === "image" && b.dataUrl?.startsWith("data:image/png"))),
	);

	// 가계부 분리 (PLAN §23) — 가입을 열면 모르는 사람이 같은 D1 을 쓴다. 남의 가계부에 닿으면 안 된다.
	if (health.ledger) {
		console.log("\n── 가계부 분리 · 초대 ────────────────────────────────");
		const u1 = { ...authed, "content-type": "application/json" };
		const u2 = { authorization: `Bearer ${body2.token}`, "content-type": "application/json" };
		const post = (h, path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: h, body: JSON.stringify(body ?? {}) });

		const book = await (await post(u1, "/api/ledgers", { name: "[smoke] 공유" })).json();
		const q = `ledger=${encodeURIComponent(book.id)}`;
		const t = await (
			await post(u1, `/api/ledger/transactions?${q}`, {
				date: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10),
				amount: 1200,
				type: "expense",
				merchant: "[smoke] 격리",
			})
		).json();
		check("가계부 만들고 거기에 기록", Boolean(book.id) && t.amount === -1200, book.name);

		const peek = await fetch(`${BASE}/api/ledger/transactions?${q}`, { headers: u2 });
		const steal = await fetch(`${BASE}/api/ledger/transactions/${t.id}`, { method: "DELETE", headers: u2 });
		const still = await (await fetch(`${BASE}/api/ledger/transactions?${q}`, { headers: u1 })).json();
		check(
			"멤버 아니면 가계부·거래 id 로 접근 불가 (404)",
			peek.status === 404 && steal.status === 404 && still.length === 1,
			`조회 ${peek.status} / 삭제 ${steal.status} / 남은 행 ${still.length}`,
		);

		const inv = await (await post(u1, `/api/ledgers/${book.id}/invites`, { invitee: USER2 })).json();
		const inbox = await (await fetch(`${BASE}/api/ledgers`, { headers: u2 })).json();
		const accepted = await post(u2, `/api/invites/${inv.id}/accept`);
		const shared = await (await fetch(`${BASE}/api/ledger/transactions?${q}`, { headers: u2 })).json();
		check(
			"초대 → 앱에서 수락 → 공유",
			inbox.invites?.some((i) => i.id === inv.id) && accepted.ok && shared.length === 1,
			`받은 초대 ${inbox.invites?.length} / 수락 ${accepted.status} / 보이는 행 ${shared.length}`,
		);

		const memberInvite = await post(u2, `/api/ledgers/${book.id}/invites`, { invitee: USER });
		const kicked = await fetch(`${BASE}/api/ledgers/${book.id}/members/${USER2}`, { method: "DELETE", headers: u1 });
		const after = await fetch(`${BASE}/api/ledger/transactions?${q}`, { headers: u2 });
		check(
			"멤버는 초대 불가, 내보내면 접근 끊김",
			memberInvite.status === 403 && kicked.ok && after.status === 404,
			`초대 ${memberInvite.status} / 내보내기 ${kicked.status} / 이후 조회 ${after.status}`,
		);

		const wrong = await fetch(`${BASE}/api/ledgers/${book.id}`, {
			method: "DELETE",
			headers: u1,
			body: JSON.stringify({ confirmName: "틀린 이름" }),
		});
		const gone = await fetch(`${BASE}/api/ledgers/${book.id}`, {
			method: "DELETE",
			headers: u1,
			body: JSON.stringify({ confirmName: book.name }),
		});
		check("가계부 삭제는 이름 확인 필요", wrong.status === 400 && gone.ok, `틀림 ${wrong.status} / 맞음 ${gone.status}`);
	}

	console.log("\n── 시크릿 저장소 ─────────────────────────────────────");
	const authed2 = { authorization: `Bearer ${body2.token}` };

	// 화이트리스트 밖 이름은 거부 — 임의 env 주입 통로가 되면 안 된다
	const bad = await fetch(`${BASE}/api/secrets`, {
		method: "PUT",
		headers: { ...authed, "content-type": "application/json" },
		body: JSON.stringify({ name: "NODE_OPTIONS", value: "--inspect" }),
	});
	check("화이트리스트 밖 키 거부", bad.status === 400, `HTTP ${bad.status}`);

	// D1 접속 정보는 서버 env 전용이다 — 앱에서 저장할 수 없어야 한다
	const d1put = await fetch(`${BASE}/api/secrets`, {
		method: "PUT",
		headers: { ...authed, "content-type": "application/json" },
		body: JSON.stringify({ name: "AF_D1_TOKEN", value: "should-be-rejected" }),
	});
	check("D1 키는 앱에서 저장 불가", d1put.status === 400, `HTTP ${d1put.status}`);

	// 사용자별 키 — user1 이 저장한 값이 user2 에게 보이면 안 된다
	await fetch(`${BASE}/api/secrets`, {
		method: "PUT",
		headers: { ...authed, "content-type": "application/json" },
		body: JSON.stringify({ name: "KIS_APP_KEY", value: "user1-kis-key-abcdef" }),
	});
	const s1 = await (await fetch(`${BASE}/api/secrets`, { headers: authed })).json();
	const s2 = await (await fetch(`${BASE}/api/secrets`, { headers: authed2 })).json();
	const kis1 = s1.items.find((i) => i.name === "KIS_APP_KEY");
	const kis2 = s2.items.find((i) => i.name === "KIS_APP_KEY");
	check("증권 키는 사용자별로 분리", kis1.source === "user" && kis2.source === "none", `${kis1.source} / ${kis2.source}`);
	check("원문 대신 마스킹만 반환", kis1.preview !== null && !JSON.stringify(s1).includes("user1-kis-key-abcdef"), kis1.preview);
	check("D1에 저장됨 (파일 아님)", s1.storageReady === true, `storageReady=${s1.storageReady}`);

	// env 폴백 — 저장값이 없으면 서버 env 를 쓴다
	const naverId = s1.items.find((i) => i.name === "NCP_APIGW_API_KEY_ID");
	check("저장값 없으면 env 폴백", naverId.source === "env", naverId.source);

	// 저장값이 env 를 덮는지 → 삭제하면 다시 env 로 돌아오는지
	await fetch(`${BASE}/api/secrets`, {
		method: "PUT",
		headers: { ...authed, "content-type": "application/json" },
		body: JSON.stringify({ name: "NCP_APIGW_API_KEY_ID", value: "my-own-naver-key-id" }),
	});
	const s1b = await (await fetch(`${BASE}/api/secrets`, { headers: authed })).json();
	check("저장값이 env 보다 우선", s1b.items.find((i) => i.name === "NCP_APIGW_API_KEY_ID").source === "user");

	await fetch(`${BASE}/api/secrets/NCP_APIGW_API_KEY_ID`, { method: "DELETE", headers: authed });
	await fetch(`${BASE}/api/secrets/KIS_APP_KEY`, { method: "DELETE", headers: authed });
	const s1c = await (await fetch(`${BASE}/api/secrets`, { headers: authed })).json();
	check("삭제 후 env 값으로 폴백", s1c.items.find((i) => i.name === "NCP_APIGW_API_KEY_ID").source === "env");

	const d1test = await (await fetch(`${BASE}/api/secrets/test/d1`, { method: "POST", headers: authed })).json();
	check("D1 연결 테스트", d1test.ok === true, d1test.message);

	console.log("\n── 증권 (자격증명 없는 상태) ─────────────────────────");
	// 키가 없을 때 500 으로 터지지 않고 "설정이 필요하다"로 떨어져야 한다
	const noKeyPortfolio = await fetch(`${BASE}/api/portfolio`, { headers: authed });
	const noKeyBody = await noKeyPortfolio.json();
	check(
		"키 없이 /api/portfolio → 503 안내",
		noKeyPortfolio.status === 503 && String(noKeyBody.error).includes("설정"),
		`HTTP ${noKeyPortfolio.status} ${String(noKeyBody.error).slice(0, 40)}…`,
	);

	const noKeyQuote = await fetch(`${BASE}/api/quote?symbol=005930`, { headers: authed });
	check("키 없이 /api/quote → 503 안내", noKeyQuote.status === 503, `HTTP ${noKeyQuote.status}`);

	// 모델에 실제로 노출된 툴 확인 — 허용목록이 아니라 거부목록이라 회귀가 나기 쉽다
	const stateTools = (await (await fetch(`${BASE}/api/state`, { headers: authed })).json()).tools ?? [];
	const need = [
		"ledger_add",
		"market_price",
		"market_technical",
		"market_timing",
		"stock_research",
		"market_movers",
		"market_news",
		"market_financials",
		"portfolio_holdings",
		"portfolio_signals",
		"finance_overview",
		"order_prepare",
		"order_list",
	];
	const missingTools = need.filter((t) => !stateTools.includes(t));
	check("우리 툴 전부 노출", missingTools.length === 0, missingTools.join(", ") || `${stateTools.length}개`);

	// 코딩 툴은 절대 노출되면 안 된다 (금융 앱에 파일시스템·셸이 필요 없다)
	const leaked = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"].filter((t) =>
		stateTools.includes(t),
	);
	check("코딩 툴 미노출", leaked.length === 0, leaked.join(", ") || "없음");

	// pi 확장(pi-web-access)이 로드됐는지 — 거부목록으로 바꾼 이유가 이것이다
	check(
		"확장 툴(web_search) 로드",
		stateTools.includes("web_search") && stateTools.includes("fetch_content"),
		stateTools.filter((t) => /web_search|fetch_content|source_check/.test(t)).join(", ") || "(없음)",
	);

	// 증권 키도 사용자별이어야 한다
	const brokerItems = (await (await fetch(`${BASE}/api/secrets`, { headers: authed })).json()).items;
	const kisNames = brokerItems.filter((i) => i.name.startsWith("KIS_")).map((i) => i.name);
	const tossNames = brokerItems.filter((i) => i.name.startsWith("TOSS_")).map((i) => i.name);
	check("KIS 키가 설정 카탈로그에 있음", kisNames.length === 3, kisNames.join(", "));
	check("토스 키가 설정 카탈로그에 있음", tossNames.length === 2, tossNames.join(", "));

	// 두 증권사 모두 미설정이면 "연결된 증권 계정이 없다"로 떨어져야 한다 (한쪽만 언급하면 안 됨)
	check(
		"미설정 안내가 두 증권사를 모두 언급",
		String(noKeyBody.error).includes("KIS") && String(noKeyBody.error).includes("토스"),
		String(noKeyBody.error).slice(0, 60),
	);

	// 토스 키를 넣어도 사용자별로 분리되는지 (KIS 와 같은 경로)
	await fetch(`${BASE}/api/secrets`, {
		method: "PUT",
		headers: { ...authed, "content-type": "application/json" },
		body: JSON.stringify({ name: "TOSS_CLIENT_ID", value: "toss-client-id-sample" }),
	});
	const afterToss = await (await fetch(`${BASE}/api/secrets`, { headers: authed })).json();
	const otherToss = await (await fetch(`${BASE}/api/secrets`, { headers: authed2 })).json();
	check(
		"토스 키도 사용자별로 분리",
		afterToss.items.find((i) => i.name === "TOSS_CLIENT_ID").source === "user" &&
			otherToss.items.find((i) => i.name === "TOSS_CLIENT_ID").source === "none",
	);
	await fetch(`${BASE}/api/secrets/TOSS_CLIENT_ID`, { method: "DELETE", headers: authed });

	console.log("\n── 주문 안전장치 ─────────────────────────────────────");
	// 주문 실행 경로는 "에이전트가 주문을 낼 수 없다"는 보장의 마지막 관문이다.
	// 토큰이 없거나 위조·만료·재사용이면 전부 막혀야 한다.
	const execute = (token, hdrs = authed) =>
		fetch(`${BASE}/api/orders/execute`, {
			method: "POST",
			headers: { ...hdrs, "content-type": "application/json" },
			body: JSON.stringify(token === undefined ? {} : { token }),
		});

	const noAuthExec = await fetch(`${BASE}/api/orders/execute`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: "whatever" }),
	});
	check("인증 없이 주문 실행 차단", noAuthExec.status === 401, `HTTP ${noAuthExec.status}`);

	const noToken = await execute(undefined);
	check("토큰 없이 주문 실행 차단", noToken.status === 400, `HTTP ${noToken.status}`);

	const garbage = await execute("not-a-real-token");
	check("위조 토큰 차단", garbage.status === 400, `HTTP ${garbage.status}`);

	// 서명은 올바르지만 다른 시크릿으로 만든 토큰
	const forged = await execute(
		Buffer.from(JSON.stringify({ u: USER, symbol: "005930", exp: Date.now() + 60000, nonce: "x" })).toString(
			"base64url",
		) + ".fakesignature",
	);
	check("서명 불일치 토큰 차단", forged.status === 400, `HTTP ${forged.status}`);

	console.log("\n── WebSocket (에이전트 경로) ─────────────────────────");
	const basic = await wsTest(token, "오늘 날짜만 한 문장으로 알려줘.");
	check("WS 인증 + ready", basic.ready);
	check("에이전트 응답 수신", basic.text.length > 0, basic.text.slice(0, 60).replace(/\n/g, " "));

	// 증권 툴이 실제로 모델에 노출되는지 — 키가 없으면 안내로 끝나야 한다
	const brokerRun = await wsTest(token, "삼성전자 지금 주가 얼마야?");
	check(
		"에이전트가 market_price 시도",
		brokerRun.toolCalls.includes("market_price"),
		brokerRun.toolCalls.join(" → ") || "(호출 없음)",
	);
	check(
		"키 없을 때 설정 안내로 응답",
		/설정|키|등록/.test(brokerRun.text),
		brokerRun.text.slice(0, 60).replace(/\n/g, " "),
	);

	// 이 프로젝트의 핵심 주장 — 에이전트 경로와 REST 경로가 같은 DB를 본다 (PLAN.md §3.2)
	if (health.ledger) {
		console.log("\n── 이중 경로 검증 (자연어 입력 → REST 조회) ────────");
		const ledgerRun = await wsTest(token, "오늘 점심으로 [smoke2] 식당에서 6500원 썼어. 기록해줘.");
		check(
			"자연어 → ledger_add 호출",
			ledgerRun.toolCalls.includes("ledger_add"),
			ledgerRun.toolCalls.join(" → ") || "(호출 없음)",
		);

		// 자정 롤오버에도 깨지지 않도록 어제~오늘 범위로 조회한다
		const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
		const yesterday = new Date(Date.now() + 9 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
		const listed = await fetch(`${BASE}/api/ledger/transactions?from=${yesterday}&to=${today}&limit=50`, { headers: authed });
		const rows = await listed.json();
		const hit = (r) => r.merchant?.includes("smoke2") || r.memo?.includes("smoke2");
		const found = rows.find(hit);
		check(
			"에이전트가 쓴 건을 REST가 조회",
			Boolean(found) && found.amount === -6500,
			found ? `${found.date} ${found.amount}원 ${found.category ?? ""} source=${found.source}` : "찾지 못함",
		);

		for (const r of rows.filter(hit)) {
			await fetch(`${BASE}/api/ledger/transactions/${r.id}`, { method: "DELETE", headers: authed });
		}
		console.log("  🧹 테스트 행 정리 완료");
	}

	// 스모크 계정이 소유한 가계부(첫 기록 때 자동 생성된 개인 가계부 포함)를 지운다 — 실 D1 에 남지 않게.
	// 소유자 토큰으로만 지울 수 있으므로 다른 사용자의 가계부는 건드릴 수 없다.
	if (health.ledger) {
		let removed = 0;
		for (const tk of [token, body2.token]) {
			const h = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
			const { ledgers = [] } = await (await fetch(`${BASE}/api/ledgers`, { headers: h })).json();
			for (const l of ledgers.filter((l) => l.role === "owner")) {
				const r = await fetch(`${BASE}/api/ledgers/${encodeURIComponent(l.id)}`, {
					method: "DELETE",
					headers: h,
					body: JSON.stringify({ confirmName: l.name }),
				});
				if (r.ok) removed++;
			}
		}
		console.log(`  🧹 스모크 가계부 ${removed}개 정리`);
	}

	console.log("\n──────────────────────────────────────────────────────");
	const failed = results.filter((r) => !r.ok);
	if (failed.length === 0) {
		console.log(`\n✅ 스모크 통과 (${results.length}/${results.length})`);
	} else {
		console.log(`\n❌ 실패 ${failed.length}건 / 전체 ${results.length}건`);
		console.log("\n--- 서버 로그 ---\n" + serverLog);
		process.exitCode = 1;
	}
}

/**
 * 대화를 보내지 않고 이벤트만 받는 감시 소켓.
 * 다른 사용자·다른 대화의 스트림이 새는지 확인하는 용도다.
 */
function wsWatch(token, sessionId = null) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	const received = [];
	ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, sessionId })));
	ws.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		// ready/pong 은 자기 자신의 접속 응답이라 누출이 아니다
		if (m.type !== "ready" && m.type !== "pong") received.push(m.type);
	});
	return {
		received,
		close: () => ws.close(),
	};
}

/** 단색 PNG (base64) — 이미지 첨부 스모크용. 외부 파일 없이 만든다. */
function solidPng(w, h, [r, g, b]) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

/** 대화 하나를 열고 첫 응답(ready 또는 session_missing)을 돌려준다. */
function wsOpen(token, sessionId) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => {
			ws.close();
			resolve({ type: "timeout" });
		}, 15_000);
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, sessionId })));
		ws.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "ready" || m.type === "session_missing" || m.type === "error") {
				clearTimeout(timer);
				ws.close();
				resolve(m);
			}
		});
	});
}

/** 새 대화에서 묻고 **답을 기다리지 않고** 끊는다 — 사용자가 앱을 끈 상황. { sessionId } */
function wsFireAndClose(token, prompt) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
		ws.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type !== "ready") return;
			ws.send(JSON.stringify({ type: "prompt", text: prompt }));
			// 서버가 prompt 를 받을 시간만 주고 끊는다
			setTimeout(() => {
				ws.close();
				resolve({ sessionId: m.sessionId });
			}, 300);
		});
		ws.on("error", () => resolve({ sessionId: null }));
	});
}

/** WS로 프롬프트 한 번 왕복. { ready, sessionId, text, toolCalls } 를 돌려준다. */
function wsTest(token, prompt, images) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const out = { ready: false, sessionId: null, text: "", toolCalls: [], error: null };
		let settled = false;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.close();
			resolve(out);
		};

		const timer = setTimeout(finish, 90_000);

		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "ready") {
				out.ready = true;
				out.sessionId = msg.sessionId;
				ws.send(JSON.stringify({ type: "prompt", text: prompt, ...(images ? { images } : {}) }));
				return;
			}
			// 서버가 pi 원본 이벤트를 그대로 흘리지 않고 StreamMessage로 좁혀서 보낸다
			// (@alphafolio/protocol — 사고 토큰 비노출 + 페이로드 축소)
			switch (msg.type) {
				case "error":
					out.error = msg.message;
					// 이미지 검증 거절처럼 일부러 오류를 기대하는 경우는 호출부가 판정한다
					if (!images) check("WS 오류", false, msg.message);
					finish();
					return;
				case "text_delta":
					out.text += msg.delta;
					return;
				case "tool_start":
					out.toolCalls.push(msg.name);
					return;
				case "agent_end":
					finish();
					return;
				default:
					return;
			}
		});
		ws.on("error", (err) => {
			check("WS 연결", false, String(err));
			finish();
		});
	});
}

main()
	.catch((err) => {
		console.error("\n❌ 스모크 실패:", err.message);
		process.exitCode = 1;
	})
	.finally(stop);
