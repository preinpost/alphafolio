/**
 * 주식 분·시간봉 감시 실측 (PLAN §40 ②③) — 실제 KIS 키로 감시기와 같은 경로(fetchWatchBars)를 돌린다.
 *
 *   1. 국장 005930 — KRX(J) 1분·3분·5분·1시간봉, 통합(UN) 확장 5분봉. 하루 봉 거래량 합 ↔ KIS 일봉 거래량, 마지막 봉 종가 ↔ 일봉 종가(종가 단일가)
 *   2. 미장 AAPL — 정규장 1분·3분·5분·1시간봉, 확장 5분봉. 거래량 합 ↔ KIS 일봉 거래량
 *   3. 캐시 — 같은 조건을 다시 부르면 호출이 1번인가
 *
 * 실행: node spike/12-watch-intraday.ts   (토큰은 서버와 같은 D1 저장소 — 캐시가 살아 있으면 새로 발급하지 않는다)
 * 시세만 조회한다. 계좌 정보는 출력하지 않는다.
 */
import {
	barCloseAt,
	domesticChart,
	fetchWatchBars,
	fireIndices,
	kstShort,
	localDate,
	overseasChart,
	parseAccount,
	toDomesticBars,
	toOverseasBars,
	tokenKey,
	warmupFor,
	type BrokerAccess,
	type Condition,
	type KisContext,
	type WatchBar,
} from "@alphafolio/broker";
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

setDefaultAutoSelectFamilyAttemptTimeout(2_000);
loadEnv();
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secret = process.env.AF_AUTH_SECRET ?? "";
const secrets = new SecretStore(() => d1ConfigFromEnv(), secret, false);
await secrets.load();
const store = createBrokerTokenStore(() => d1ConfigFromEnv(), secret);

const kisKey = secrets.get("KIS_APP_KEY", user);
if (!kisKey) {
	console.log(`사용자 ${user} 에게 KIS 키가 없습니다`);
	process.exit(1);
}
const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const kis: KisContext = {
	creds: { appKey: kisKey, appSecret: secrets.get("KIS_APP_SECRET", user) ?? "", cano: account.cano, prdtCd: account.prdtCd, env: "real" },
	store,
	owner: user,
};
const cached = await store.get(tokenKey(user, "real", kis.creds.appKey));
console.log(`사용자 ${user} · KIS 토큰 캐시: ${cached ? `살아 있음 (만료 ${kstShort(cached.expiresAt)})` : "없음 — 이번 실행에서 새로 발급된다 (문자)"}`);

// KIS 호출 수 세기
let kisCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => {
	if (String(u).includes("koreainvestment")) kisCalls++;
	return realFetch(u, init);
}) as typeof fetch;

const access: BrokerAccess = { kis: () => kis };
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
const base = (over: Partial<Condition>): Condition => ({
	market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "krx" } },
	interval: "5m",
	when: "bar_close",
	all: [{ left: { ind: "rvol", length: 5 }, op: ">=", right: 2 }],
	confirmBars: 1,
	fire: "on_enter",
	...over,
});

async function run(label: string, c: Condition, limit: number): Promise<WatchBar[]> {
	const before = kisCalls;
	const t0 = Date.now();
	const bars = await fetchWatchBars(c, limit, { access });
	const first = bars[0];
	const last = bars.at(-1);
	const fires = fireIndices(c, bars).filter((i) => i >= warmupFor(c));
	console.log(
		`${label}: ${bars.length}봉 · KIS ${kisCalls - before}번 · ${Date.now() - t0}ms · ${first ? kstShort(first.t) : "-"} ~ ${last ? `${kstShort(last.t)} (마감 ${kstShort(barCloseAt(c, last.t))})` : "-"} · 마지막 종가 ${fmt(last?.close)} · 조건 발동 ${fires.length}번`,
	);
	return bars;
}

/** 현지 날짜별 거래량 합·마지막 종가 */
function byDay(bars: WatchBar[], tz: string): Map<string, { volume: number; close: number; n: number }> {
	const m = new Map<string, { volume: number; close: number; n: number }>();
	for (const b of bars) {
		const d = localDate(b.t, tz).ymd.replace(/-/g, "");
		const cur = m.get(d) ?? { volume: 0, close: 0, n: 0 };
		m.set(d, { volume: cur.volume + b.volume, close: b.close, n: cur.n + 1 });
	}
	return m;
}

function compare(label: string, ours: Map<string, { volume: number; close: number; n: number }>, daily: Array<{ date: string; close: number; volume?: number }>) {
	console.log(`  ${label} — 날짜 · 봉 수 · 거래량 합 / 일봉 거래량 (비율) · 마지막 봉 종가 / 일봉 종가`);
	for (const [d, v] of [...ours].slice(-4)) {
		const k = daily.find((x) => x.date.replace(/-/g, "").slice(0, 8) === d);
		const ratio = k?.volume ? (v.volume / k.volume).toFixed(4) : "-";
		console.log(`    ${d}  ${String(v.n).padStart(3)}봉  ${fmt(v.volume).padStart(12)} / ${fmt(k?.volume).padStart(12)} (${ratio})  ${fmt(v.close)} / ${fmt(k?.close)}`);
	}
}

// ── 국장 ──
console.log("\n══ 국장 005930");
const krx1 = await run("KRX 1분봉 (rvol 10일 예열)", base({ interval: "1m", all: [{ left: { ind: "rvol" }, op: ">=", right: 3 }] }), 4400);
await run("KRX 1분봉 (다시 — 캐시)", base({ interval: "1m", all: [{ left: { ind: "rvol" }, op: ">=", right: 3 }] }), 4400);
const krx5 = await run("KRX 5분봉", base({}), 400);
await run("KRX 5분봉 (다시 — 캐시)", base({}), 400);
const krx1h = await run("KRX 1시간봉", base({ interval: "1h" }), 40);
await run("KRX 3분봉", base({ interval: "3m", all: [{ left: "rsi14", op: "<", right: 30 }] }), 200);
const un5 = await run(
	"통합 확장 5분봉 (08:00–20:00)",
	base({ market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "integrated" } }, session: "extended" }),
	400,
);
const dJ = toDomesticBars(await domesticChart(kis, "005930", "D", { market: "J" }));
const dUN = toDomesticBars(await domesticChart(kis, "005930", "D", { market: "UN" }));
compare("KRX 1분봉 ↔ KIS 일봉(J)", byDay(krx1, "Asia/Seoul"), dJ);
compare("KRX 5분봉 ↔ KIS 일봉(J)", byDay(krx5, "Asia/Seoul"), dJ);
compare("KRX 1시간봉 ↔ KIS 일봉(J)", byDay(krx1h, "Asia/Seoul"), dJ);
compare("통합 확장 5분봉 ↔ KIS 일봉(UN)", byDay(un5, "Asia/Seoul"), dUN);

// ── 미장 ──
console.log("\n══ 미장 AAPL");
const us = (over: Partial<Condition>) => base({ market: { venue: "us", symbol: "AAPL", feed: { provider: "kis" } }, ...over });
const us1 = await run("정규장 1분봉", us({ interval: "1m" }), 1200);
await run("정규장 1분봉 (다시 — 캐시)", us({ interval: "1m" }), 1200);
const us5 = await run("정규장 5분봉", us({}), 300);
await run("정규장 5분봉 (다시 — 캐시)", us({}), 300);
const us3 = await run("정규장 3분봉", us({ interval: "3m" }), 300);
const us1h = await run("정규장 1시간봉", us({ interval: "1h" }), 30);
const usx = await run("확장 5분봉 (04:00–20:00)", us({ session: "extended" }), 600);
const dUS = toOverseasBars(await overseasChart(kis, "AAPL", "NAS", "D"));
compare("정규장 1분봉 ↔ KIS 일봉", byDay(us1, "America/New_York"), dUS);
compare("정규장 5분봉 ↔ KIS 일봉", byDay(us5, "America/New_York"), dUS);
compare("정규장 3분봉 ↔ KIS 일봉", byDay(us3, "America/New_York"), dUS);
compare("정규장 1시간봉 ↔ KIS 일봉", byDay(us1h, "America/New_York"), dUS);
compare("확장 5분봉 ↔ KIS 일봉", byDay(usx, "America/New_York"), dUS);
const lastDay = [...byDay(us1h, "America/New_York").keys()].at(-1);
console.log(`  마지막 거래일(${lastDay}) 1시간봉:`);
for (const b of us1h.filter((x) => localDate(x.t, "America/New_York").ymd.replace(/-/g, "") === lastDay)) {
	console.log(`    ${kstShort(b.t)} KST  O ${fmt(b.open)} H ${fmt(b.high)} L ${fmt(b.low)} C ${fmt(b.close)} V ${fmt(b.volume)}`);
}
console.log(`\nKIS 호출 합계 ${kisCalls}번`);
