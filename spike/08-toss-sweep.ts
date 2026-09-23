/**
 * 토스 조회 API 전수 실측 — 카탈로그의 GET 29개를 실제 키로 한 번씩 호출한다 (PLAN §32).
 * 예시값: 종목 005930, 지수 KOSPI·국채, 선택지 파라미터는 첫 번째 값. 주문·조건주문 상세는 목록에서 id 를 받아 쓴다.
 * 조회만 한다 (쓰기 API 는 게이트웨이가 거절). 응답 데이터는 저장하지 않고 행 수만 찍는다.
 *
 * 실행: node spike/08-toss-sweep.ts
 * 토큰은 서버와 같은 D1 저장소 — 새로 발급하면 운영 서버의 토큰이 무효가 될 수 있다.
 */
import { callTossApi, isTossWrite, renderTossResult, tossCatalog, type TossContext } from "@alphafolio/broker";
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secret = process.env.AF_AUTH_SECRET ?? "";
const secrets = new SecretStore(() => d1ConfigFromEnv(), secret, false);
await secrets.load();
const ctx: TossContext = {
	creds: { clientId: secrets.get("TOSS_CLIENT_ID", user) ?? "", clientSecret: secrets.get("TOSS_CLIENT_SECRET", user) ?? "" },
	store: createBrokerTokenStore(() => d1ConfigFromEnv(), secret),
	owner: user,
};

const SAMPLE: Record<string, Record<string, string>> = {
	getPrices: { symbols: "005930,AAPL" },
	getStocks: { symbols: "005930,AAPL" },
	getMarketIndicatorPrices: { symbols: "KOSPI,KOSDAQ,KR_BOND_3Y,KR_BOND_10Y" },
	getMarketIndicatorCandles: { symbol: "KOSPI", interval: "1d", count: "5" },
	getMarketIndicatorInvestorTrading: { symbol: "KOSPI", interval: "1d", count: "5" },
	getExchangeRate: { baseCurrency: "USD", quoteCurrency: "KRW" },
	getCandles: { symbol: "005930", interval: "1d", count: "5" },
	getRankings: { type: "MARKET_TRADING_AMOUNT", marketCountry: "KR", duration: "1d", count: "5" },
};

const ids: Record<string, string> = {};
const rows: Array<[string, string, string]> = [];
const reads = Object.entries(tossCatalog().apis).filter(([, a]) => !isTossWrite(a));
// 목록을 먼저 불러야 상세의 id 를 얻는다
reads.sort(([a], [b]) => Number(/^get(Order|ConditionalOrder)$/.test(a)) - Number(/^get(Order|ConditionalOrder)$/.test(b)));

for (const [id, api] of reads) {
	const input: Record<string, string> = { ...(SAMPLE[id] ?? {}) };
	for (const [n, p] of Object.entries(api.params)) {
		if (n in input || n === "X-Tossinvest-Account" || !p.required) continue;
		if (n === "symbol") input[n] = "005930";
		else if (n === "orderId") input[n] = ids.orderId ?? "";
		else if (n === "conditionalOrderId") input[n] = ids.conditionalOrderId ?? "";
		else if (p.enum) input[n] = p.enum[0]!;
	}
	if ((id === "getOrder" && !ids.orderId) || (id === "getConditionalOrder" && !ids.conditionalOrderId)) {
		rows.push([id, "skip", "목록이 비어 id 없음"]);
		continue;
	}
	try {
		const r = await callTossApi(ctx, id, input);
		const out = renderTossResult(r.api, r.data, { limit: 1 });
		// 상세 조회용 id — 목록 응답에서
		const d = r.data as Record<string, unknown>;
		const first = Array.isArray(d?.orders) ? (d.orders as Array<Record<string, unknown>>)[0] : Array.isArray(d?.conditionalOrders) ? (d.conditionalOrders as Array<Record<string, unknown>>)[0] : undefined;
		if (id === "getOrders" && first?.orderId) ids.orderId = String(first.orderId);
		if (id === "getConditionalOrders" && first?.conditionalOrderId) ids.conditionalOrderId = String(first.conditionalOrderId);
		rows.push([id, out.empty ? "empty" : "ok", `${out.rowCount}행`]);
	} catch (err) {
		rows.push([id, "error", err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 110) : String(err)]);
	}
}
for (const [id, s, m] of rows) console.log(`${s === "ok" ? "✅" : s === "empty" ? "⚪" : s === "skip" ? "⏭️" : "❌"} ${id.padEnd(34)} ${m}`);
const c = (s: string) => rows.filter((r) => r[1] === s).length;
console.log(`\nok ${c("ok")} · empty ${c("empty")} · skip ${c("skip")} · error ${c("error")} / ${rows.length}`);
process.exit(0);
