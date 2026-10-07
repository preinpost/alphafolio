/**
 * 스파이크 15 — Binance USDⓈ-M 선물 API 연동 점검. **조회(GET)만** 한다 — 주문·레버리지 변경·이체 없음.
 *
 *   1. 선물 서버 시간 차이 (서명 요청은 recvWindow 5초 안이어야 한다)
 *   2. 키 권한 (`GET /sapi/v1/account/apiRestrictions`) — enableFutures 가 꺼져 있으면 선물 계좌 조회가 -2015 로 거절된다
 *   3. 선물 계좌 (`GET /fapi/v3/account`) — 잔고·증거금
 *   4. 열린 포지션 (`GET /fapi/v3/positionRisk`)
 *   5. 포지션 모드 (`GET /fapi/v1/positionSide/dual`) · 멀티에셋 모드 (`GET /fapi/v1/multiAssetsMargin`)
 *   6. 거래 제한 지표 (`GET /fapi/v1/apiTradingStatus`) · BTCUSDT 수수료 (`GET /fapi/v1/commissionRate`)
 *
 * 키 출처: BINANCE_API_KEY·BINANCE_API_SECRET env → 없으면 D1 에 저장된 사용자 키 (AF_D1_* · AF_AUTH_SECRET 필요).
 * 키는 출력하지 않는다 (오류 메시지에서도 가린다).
 *
 * 실행: node spike/15-binance-futures-check.ts            실계좌
 *       node spike/15-binance-futures-check.ts --testnet  선물 테스트넷 (현물 테스트넷 키와 다르다)
 */
import { binanceSign } from "../packages/broker/src/data/gateway.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const testnet = process.argv.includes("--testnet");
const FAPI = testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
const SAPI = "https://api.binance.com";

async function loadCreds(): Promise<{ key: string; secret: string; from: string } | null> {
	const key = process.env.BINANCE_API_KEY?.trim();
	const secret = process.env.BINANCE_API_SECRET?.trim();
	if (key && secret) return { key, secret, from: "env" };
	if (!process.env.AF_D1_ACCOUNT_ID || !process.env.AF_D1_DATABASE_ID || !process.env.AF_D1_TOKEN) return null;
	const { d1ConfigFromEnv } = await import("@alphafolio/ledger");
	const { SecretStore } = await import("../apps/server/src/secrets.ts");
	const user = process.env.AF_ADMIN_USER ?? "alpha";
	const store = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
	await store.load();
	const k = store.get("BINANCE_API_KEY", user);
	const s = store.get("BINANCE_API_SECRET", user);
	return k && s ? { key: k, secret: s, from: `D1 (사용자 ${user})` } : null;
}

const creds = await loadCreds();
if (!creds) {
	console.error(
		"Binance 키를 찾지 못했습니다.\n" +
			"  · 직접 넣기:  BINANCE_API_KEY=… BINANCE_API_SECRET=… node spike/15-binance-futures-check.ts\n" +
			"  · 앱에 저장한 키: .env 에 AF_D1_ACCOUNT_ID · AF_D1_DATABASE_ID · AF_D1_TOKEN 을 채운다",
	);
	process.exit(2);
}
const c = creds;

function scrub(text: string): string {
	return text.split(c.key).join("****").split(c.secret).join("****");
}

async function call(base: string, path: string, params: Record<string, string> = {}, sign = true): Promise<unknown> {
	const q = new URLSearchParams(params);
	if (sign) {
		q.set("timestamp", String(Date.now()));
		q.set("recvWindow", "5000");
	}
	let qs = q.toString();
	if (sign) qs = `${qs}&signature=${binanceSign(qs, c.secret)}`;
	const res = await fetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
		headers: sign ? { "X-MBX-APIKEY": c.key } : {},
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		/* 아래에서 원문으로 보고 */
	}
	const o = data as { code?: number; msg?: string } | null;
	if (!res.ok || (o && typeof o.code === "number" && o.code < 0)) {
		throw new Error(scrub(`HTTP ${res.status} code=${o?.code ?? "-"} ${o?.msg ?? text.slice(0, 160)}`));
	}
	return data;
}

/** 자주 보는 오류 코드 → 원인 */
const HINTS: Record<string, string> = {
	"-2015": "키가 틀렸거나, 허용 IP 밖이거나, 이 키에 선물 권한(Enable Futures)이 없습니다",
	"-2014": "API 키 형식이 올바르지 않습니다",
	"-1021": "PC 시계가 Binance 서버와 어긋났습니다 (recvWindow 밖)",
	"-1022": "서명이 맞지 않습니다 — Secret Key 를 확인하세요",
	"-4059": "선물 계정이 아직 열리지 않았을 수 있습니다",
};

let failed = 0;
async function check(label: string, fn: () => Promise<string | string[]>): Promise<void> {
	try {
		const out = await fn();
		console.log(`✅ ${label}`);
		for (const line of Array.isArray(out) ? out : [out]) if (line) console.log(`     ${line}`);
	} catch (e) {
		failed += 1;
		const msg = e instanceof Error ? e.message : String(e);
		const code = /code=(-\d+)/.exec(msg)?.[1];
		console.log(`❌ ${label}\n     ${msg}${code && HINTS[code] ? `\n     → ${HINTS[code]}` : ""}`);
	}
}

const n = (v: unknown): string => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });

console.log(`Binance 선물 점검 — ${testnet ? "테스트넷" : "실계좌"} · 키 출처 ${c.from}\n`);

await check("선물 서버 시간", async () => {
	const t0 = Date.now();
	const r = (await call(FAPI, "/fapi/v1/time", {}, false)) as { serverTime: number };
	const drift = r.serverTime - Math.round((t0 + Date.now()) / 2);
	if (Math.abs(drift) > 1000) throw new Error(`PC 시계 차이 ${drift}ms — 1초 넘게 어긋나면 서명 요청이 거절될 수 있습니다`);
	return `PC 시계 차이 ${drift}ms`;
});

if (!testnet) {
	await check("키 권한 (apiRestrictions)", async () => {
		const r = (await call(SAPI, "/sapi/v1/account/apiRestrictions")) as Record<string, unknown>;
		const lines = [
			`조회 ${r.enableReading ? "허용" : "꺼짐"} · 현물 거래 ${r.enableSpotAndMarginTrading ? "허용" : "꺼짐"} · 선물 ${r.enableFutures ? "허용" : "꺼짐"}`,
			`IP 제한 ${r.ipRestrict ? "있음" : "없음"} · 출금 ${r.enableWithdrawals ? "⚠️ 허용됨 (끄는 것을 권장)" : "꺼짐"}`,
		];
		if (!r.enableFutures) throw new Error(`${lines.join(" / ")}\n     → Binance API 관리에서 이 키의 "Enable Futures" 를 켜야 합니다`);
		return lines;
	});
}

await check("선물 계좌 (USDⓈ-M)", async () => {
	const r = (await call(FAPI, "/fapi/v3/account")) as {
		totalWalletBalance: string;
		totalUnrealizedProfit: string;
		totalMarginBalance: string;
		availableBalance: string;
		totalInitialMargin: string;
		assets?: Array<{ asset: string; walletBalance: string }>;
	};
	const held = (r.assets ?? []).filter((a) => Number(a.walletBalance) !== 0).map((a) => `${a.asset} ${n(a.walletBalance)}`);
	return [
		`지갑 ${n(r.totalWalletBalance)} · 미실현 ${n(r.totalUnrealizedProfit)} · 증거금 잔고 ${n(r.totalMarginBalance)} · 주문 가능 ${n(r.availableBalance)} (USD 환산)`,
		`보유 자산: ${held.length ? held.join(", ") : "없음 — 선물 지갑으로 이체해야 거래할 수 있습니다"}`,
	];
});

await check("열린 포지션", async () => {
	const r = (await call(FAPI, "/fapi/v3/positionRisk")) as Array<Record<string, string>>;
	const open = r.filter((p) => Number(p.positionAmt) !== 0);
	if (!open.length) return "없음";
	return open.map(
		(p) =>
			`${p.symbol} ${p.positionSide} ${n(p.positionAmt)} @ ${n(p.entryPrice)} · 미실현 ${n(p.unRealizedProfit)} · 청산가 ${n(p.liquidationPrice)} · ${p.marginType ?? ""}`,
	);
});

await check("계정 모드", async () => {
	const dual = (await call(FAPI, "/fapi/v1/positionSide/dual")) as { dualSidePosition: boolean };
	const multi = (await call(FAPI, "/fapi/v1/multiAssetsMargin")) as { multiAssetsMargin: boolean };
	return `포지션 모드 ${dual.dualSidePosition ? "양방향 (Hedge)" : "단방향 (One-way)"} · 멀티에셋 증거금 ${multi.multiAssetsMargin ? "켜짐" : "꺼짐"}`;
});

await check("거래 제한 지표 (apiTradingStatus)", async () => {
	const r = (await call(FAPI, "/fapi/v1/apiTradingStatus")) as { indicators?: Record<string, Array<{ isLocked: boolean; indicator: string; value: number; triggerValue: number }>> };
	const locked = Object.entries(r.indicators ?? {}).flatMap(([sym, xs]) => xs.filter((x) => x.isLocked).map((x) => `${sym} ${x.indicator}=${x.value}/${x.triggerValue}`));
	if (locked.length) throw new Error(`거래 제한 걸림: ${locked.join(", ")}`);
	return "제한 없음";
});

await check("수수료 (BTCUSDT)", async () => {
	const r = (await call(FAPI, "/fapi/v1/commissionRate", { symbol: "BTCUSDT" })) as { makerCommissionRate: string; takerCommissionRate: string };
	return `메이커 ${(Number(r.makerCommissionRate) * 100).toFixed(4)}% · 테이커 ${(Number(r.takerCommissionRate) * 100).toFixed(4)}%`;
});

console.log(failed ? `\n${failed}개 항목 실패` : "\n모든 항목 통과 — 선물 API 사용 가능");
process.exit(failed ? 1 : 0);
