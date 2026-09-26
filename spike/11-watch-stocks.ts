/**
 * 주식 감시 실측 (PLAN §40) — 실제 키로 국장·미장 일봉·주봉을 받아 감시 경로를 확인한다.
 *
 *   1. KIS 만 / 토스만 따로 일봉 → 이어 받기 봉 수, 날짜, 거래량 비교 (국장 거래량에 NXT 가 포함되는가)
 *   2. 우리가 일봉을 묶은 주봉 ↔ KIS 주봉 대조
 *   3. fetchWatchBars(감시기와 같은 경로)로 조건 판정
 *   4. 고정 출처 — 국장 KIS KRX(J) · KIS 통합(UN) · 토스 통합이 서로 어떻게 다른가 (통합끼리는 같아야 한다)
 *
 * 실행: node spike/11-watch-stocks.ts
 * 토큰은 서버와 같은 D1 저장소·같은 소유자로 — 캐시가 살아 있으면 새로 발급하지 않는다 (KIS 는 발급 때 문자가 간다).
 * 계좌 정보는 출력하지 않는다 (시세만).
 */
import {
	domesticChart,
	fetchStockDaily,
	fetchWatchBars,
	fireIndices,
	kstShort,
	parseAccount,
	toDomesticBars,
	tokenKey,
	weeklyFromDaily,
	warmupFor,
	type BrokerAccess,
	type Condition,
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
			return {
				creds: { appKey: kisKey, appSecret: secrets.get("KIS_APP_SECRET", user) ?? "", cano: account.cano, prdtCd: account.prdtCd, env: "real" as const },
				store,
				owner: user,
			};
		})()
	: null;
const tossId = secrets.get("TOSS_CLIENT_ID", user);
const toss: TossContext | null = tossId ? { creds: { clientId: tossId, clientSecret: secrets.get("TOSS_CLIENT_SECRET", user) ?? "" }, store, owner: user } : null;

console.log(`사용자 ${user} · KIS ${kis ? "있음" : "없음"} · 토스 ${toss ? "있음" : "없음"}`);
if (kis) {
	const cached = await store.get(tokenKey(user, "real", kis.creds.appKey));
	console.log(`KIS 토큰 캐시: ${cached ? `살아 있음 (만료 ${kstShort(cached.expiresAt)})` : "없음 — 이번 실행에서 새로 발급된다 (문자)"}`);
}

const kisOnly: BrokerAccess = kis ? { kis: () => kis } : {};
const tossOnly: BrokerAccess = toss ? { toss: () => toss } : {};
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

for (const [venue, symbol] of [
	["krx", "005930"],
	["us", "AAPL"],
] as const) {
	console.log(`\n══ ${venue === "krx" ? "국장" : "미장"} ${symbol}`);
	const got: Record<string, Map<string, number>> = {};
	for (const [label, access] of [
		["KIS", kisOnly],
		["토스", tossOnly],
	] as const) {
		if (Object.keys(access).length === 0) continue;
		try {
			const t0 = Date.now();
			const { bars, source } = await fetchStockDaily(access, venue, symbol, 300);
			got[label] = new Map(bars.map((b) => [b.date.replace(/-/g, "").slice(0, 8), b.volume ?? 0]));
			console.log(`${label}: 일봉 ${bars.length}개 (${source}, ${Date.now() - t0}ms) ${bars[0]?.date} ~ ${bars.at(-1)?.date} · 마지막 종가 ${fmt(bars.at(-1)?.close)} 거래량 ${fmt(bars.at(-1)?.volume)}`);
		} catch (err) {
			console.log(`${label}: 실패 — ${err instanceof Error ? err.message : err}`);
		}
	}
	if (got.KIS && got["토스"]) {
		const days = [...got.KIS.keys()].filter((d) => got["토스"]?.has(d)).slice(-6);
		console.log("거래량 비교 (KIS / 토스 / 비율):");
		for (const d of days) {
			const a = got.KIS.get(d) as number;
			const b = got["토스"]?.get(d) as number;
			console.log(`  ${d}  ${fmt(a).padStart(14)}  ${fmt(b).padStart(14)}  ${(b / a).toFixed(4)}`);
		}
	}

	// 주봉 대조 (국장만 — KIS 국내 주봉)
	if (venue === "krx" && kis) {
		try {
			const { bars } = await fetchStockDaily(kisOnly, venue, symbol, 60);
			const ours = weeklyFromDaily(venue, bars).slice(-4);
			const theirs = toDomesticBars(await domesticChart(kis, symbol, "W")).slice(-4);
			console.log("주봉 대조 (우리 묶음 / KIS 주봉):");
			for (const w of ours) {
				const k = theirs.find((x) => Math.abs(Date.parse(`${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}T09:00:00+09:00`) - w.t) < 7 * 86_400_000);
				console.log(`  ${kstShort(w.t).slice(0, 5)}주  종가 ${fmt(w.close)} / ${fmt(k?.close)}  거래량 ${fmt(w.volume)} / ${fmt(k?.volume)}  (KIS 날짜 ${k?.date ?? "없음"})`);
			}
		} catch (err) {
			console.log(`주봉 대조 실패 — ${err instanceof Error ? err.message : err}`);
		}
	}

	// 감시 경로 그대로
	const access: BrokerAccess = { ...kisOnly, ...tossOnly };
	for (const interval of ["1d", "1w"] as const) {
		const c: Condition = { market: { venue, symbol }, interval, when: "bar_close", all: [{ left: "vol_chg_pct", op: ">=", right: 40 }], confirmBars: 1, fire: "on_enter" };
		try {
			const bars = await fetchWatchBars(c, interval === "1d" ? 122 : 54, { access });
			const fires = fireIndices(c, bars).filter((i) => i >= warmupFor(c));
			const last = bars.at(-1);
			console.log(
				`감시 ${interval}: 닫힌 봉 ${bars.length}개 · 마지막 ${last ? kstShort(last.t) : "-"} · 거래량 +40% 이상 ${fires.length}번 · 최근 ${fires
					.slice(-3)
					.map((i) => kstShort(bars[i]!.t).slice(0, 5))
					.join(", ")}`,
			);
		} catch (err) {
			console.log(`감시 ${interval}: 실패 — ${err instanceof Error ? err.message : err}`);
		}
	}
}

// 4. 고정 출처 (국장)
console.log("\n══ 국장 005930 고정 출처 (최근 3일: 종가 / 거래량)");
const both: BrokerAccess = { ...kisOnly, ...tossOnly };
for (const feed of [
	{ provider: "kis", basis: "krx" },
	{ provider: "kis", basis: "integrated" },
	{ provider: "toss", basis: "integrated" },
] as const) {
	try {
		const { bars } = await fetchStockDaily(both, "krx", "005930", 5, feed);
		console.log(`  ${feed.provider}/${feed.basis}: ${bars.slice(-3).map((b) => `${b.date} ${fmt(b.close)} / ${fmt(b.volume)}`).join("  ")}`);
	} catch (err) {
		console.log(`  ${feed.provider}/${feed.basis}: 실패 — ${err instanceof Error ? err.message : err}`);
	}
}

