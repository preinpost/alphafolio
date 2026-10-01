/**
 * 체결 어댑터 실측 (PLAN §40 2단계) — **조회만** 한다. 주문·취소는 보내지 않는다.
 *
 *   1. 호가: KIS 국장(005930) · KIS 미장(AAPL 나스닥, ORCL 뉴욕) · 토스 국장·미장 · Binance 현물(BTCUSDT·ETHUSDT·bStock AAPLBUSDT, 공개 — 키 불필요) · Binance 미국 주식(AAPL·NVDA, 키 있으면)
 *      — 정렬, 호가 단위, 최우선 호가 차이
 *   2. 상태 조회 경로: KIS 오늘 일별 체결(TTTC0081R) · 미장 체결 내역(TTTS3035R) 이 규격 파라미터로 통과하는가 (건수만 출력)
 *
 * 실행: node spike/13-exec-venues.ts
 * KIS 토큰 캐시가 없으면 멈춘다 (발급 때 문자가 간다). 계좌 정보·주문 내용은 출력하지 않는다.
 */
import {
	binanceStockVenue,
	equityOpenOrders,
	equityPosition,
	binanceVenue,
	callKisApi,
	gridOf,
	kisVenue,
	kstShort,
	localDate,
	midPrice,
	parseAccount,
	tokenKey,
	tossVenue,
	type Book,
	type ExecVenue,
	type KisContext,
	type TossContext,
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
const kis: KisContext | null = kisKey
	? (() => {
			const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
			return { creds: { appKey: kisKey, appSecret: secrets.get("KIS_APP_SECRET", user) ?? "", cano: account.cano, prdtCd: account.prdtCd, env: "real" as const }, store, owner: user };
		})()
	: null;
const tossId = secrets.get("TOSS_CLIENT_ID", user);
const toss: TossContext | null = tossId ? { creds: { clientId: tossId, clientSecret: secrets.get("TOSS_CLIENT_SECRET", user) ?? "" }, store, owner: user } : null;

console.log(`사용자 ${user} · KIS ${kis ? "있음" : "없음"} · 토스 ${toss ? "있음" : "없음"} · ${kstShort(Date.now())} KST`);
if (kis) {
	const cached = await store.get(tokenKey(user, "real", kis.creds.appKey));
	if (!cached) {
		console.log("KIS 토큰 캐시 없음 — 문자 발급을 피하려고 멈춘다 (서버를 한 번 띄운 뒤 다시)");
		process.exit(1);
	}
	console.log(`KIS 토큰 캐시: 만료 ${kstShort(cached.expiresAt)}`);
}

function show(v: ExecVenue, b: Book): void {
	const f = (l: { price: number; volume: number } | undefined) => (l ? `${l.price} × ${l.volume}` : "없음");
	const g = gridOf(v);
	const onTick = [...b.asks, ...b.bids].every((l) => g.roundPrice(l.price, "down") === l.price);
	const sorted = b.asks.every((l, i) => i === 0 || l.price > b.asks[i - 1]!.price) && b.bids.every((l, i) => i === 0 || l.price < b.bids[i - 1]!.price);
	console.log(
		`  ${v.label} ${v.symbol}: 매도 ${b.asks.length}단 (최우선 ${f(b.asks[0])}) · 매수 ${b.bids.length}단 (최우선 ${f(b.bids[0])}) · 중간 ${midPrice(b)} · 정렬 ${sorted ? "✓" : "✗"} · 호가 단위 ${onTick ? "✓" : "✗"}`,
	);
}

async function probe(label: string, make: () => Promise<ExecVenue>): Promise<void> {
	try {
		const v = await make();
		const t0 = Date.now();
		const b = await v.book();
		show(v, b);
		console.log(`    ${Date.now() - t0}ms`);
	} catch (err) {
		console.log(`  ${label}: 실패 — ${err instanceof Error ? err.message : err}`);
	}
}

console.log("\n1. 호가");
if (kis) {
	await probe("KIS 005930", () => kisVenue(kis, "005930"));
	await probe("KIS AAPL", () => kisVenue(kis, "AAPL"));
	await probe("KIS ORCL", () => kisVenue(kis, "ORCL"));
}
if (toss) {
	await probe("토스 005930", () => tossVenue(toss, "005930"));
	await probe("토스 AAPL", () => tossVenue(toss, "AAPL"));
}
// 호가·종목 규칙은 공개 — 빈 키로 (서명 경로는 부르지 않는다)
await probe("Binance BTCUSDT", () => binanceVenue({ key: "", secret: "" }, "BTCUSDT"));
await probe("Binance ETHUSDT", () => binanceVenue({ key: "", secret: "" }, "ETHUSDT"));
// bStock (토큰화 미국 주식) — 같은 현물 쌍
await probe("Binance AAPLBUSDT", () => binanceVenue({ key: "", secret: "" }, "AAPLBUSDT"));
// Binance 미국 주식 직접 거래 — 키가 있으면 (규칙·호가는 키만, 미체결·보유 추정은 서명 조회. 주문은 보내지 않는다)
const bKey = secrets.get("BINANCE_API_KEY", user);
const bin = bKey ? { key: bKey, secret: secrets.get("BINANCE_API_SECRET", user) ?? "" } : null;
if (bin) {
	await probe("Binance 미국 주식 AAPL", () => binanceStockVenue(bin, "AAPL"));
	await probe("Binance 미국 주식 NVDA", () => binanceStockVenue(bin, "NVDA"));
	try {
		const open = await equityOpenOrders(bin);
		const pos = await equityPosition(bin, "AAPL");
		console.log(`  Binance 미국 주식 서명 조회: 미체결 ${open.length}건 · AAPL 체결 내역 보유 추정 ${pos.qty}주`);
	} catch (err) {
		console.log(`  Binance 미국 주식 서명 조회: 실패 — ${err instanceof Error ? err.message : err}`);
	}
}

console.log("\n2. 상태 조회 경로 (건수만)");
if (kis) {
	const kr = localDate(Date.now(), "Asia/Seoul").ymd.replaceAll("-", "");
	const ny = localDate(Date.now(), "America/New_York").ymd.replaceAll("-", "");
	try {
		const r = await callKisApi(
			kis,
			"TTTC0081R",
			{ INQR_STRT_DT: kr, INQR_END_DT: kr, SLL_BUY_DVSN_CD: "00", PDNO: "005930", ORD_GNO_BRNO: "", ODNO: "", CCLD_DVSN: "00", INQR_DVSN: "00", INQR_DVSN_1: "", INQR_DVSN_3: "00", EXCG_ID_DVSN_CD: "KRX" },
			{ trId: "TTTC0081R" },
		);
		const rows = r.pages.flatMap((p) => (Array.isArray(p.output1) ? p.output1 : []));
		console.log(`  KIS 국장 일별 체결 ${kr}: 통과 · ${rows.length}건 · 필드 ${Object.keys((rows[0] ?? {}) as object).filter((k) => /qty|avg|odno/.test(k)).join(",") || "(없음)"}`);
	} catch (err) {
		console.log(`  KIS 국장 일별 체결: 실패 — ${err instanceof Error ? err.message : err}`);
	}
	try {
		const r = await callKisApi(
			kis,
			"TTTS3035R",
			{ PDNO: "AAPL", ORD_STRT_DT: ny, ORD_END_DT: ny, SLL_BUY_DVSN: "00", CCLD_NCCS_DVSN: "00", OVRS_EXCG_CD: "NASD", SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "" },
			{ pages: 1 },
		);
		const rows = r.pages.flatMap((p) => (Array.isArray(p.output) ? p.output : []));
		console.log(`  KIS 미장 체결 내역 ${ny}: 통과 · ${rows.length}건`);
	} catch (err) {
		console.log(`  KIS 미장 체결 내역: 실패 — ${err instanceof Error ? err.message : err}`);
	}
}
process.exit(0);
