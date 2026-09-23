/**
 * 토스 예수금 원시 응답 — KRW·USD 매수가능금액이 서로를 포함하는지(통합증거금) 본다.
 * 합산하면 이중 계산이 되는지 판단하려고 만든다. 조회만 한다 (주문 API 없음).
 *
 * 실행: node spike/06-toss-cash.ts
 * 토큰은 서버와 같은 D1 저장소를 쓴다 — 새로 발급하면 운영 서버의 토큰이 무효가 될 수 있다.
 */
import { defaultAccountSeq, tossBuyingPower, tossExchangeRate, tossHoldings, type TossContext } from "@alphafolio/broker";
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
const seq = await defaultAccountSeq(ctx);
const [krw, usd, rate, holdings] = await Promise.all([
	tossBuyingPower(ctx, seq, "KRW"),
	tossBuyingPower(ctx, seq, "USD"),
	tossExchangeRate(ctx),
	tossHoldings(ctx, seq),
]);
console.log("KRW buying-power:", JSON.stringify(krw));
console.log("USD buying-power:", JSON.stringify(usd));
console.log("환율:", JSON.stringify(rate));
// 보유 응답에 현금 관련 필드가 있는지 (키 이름만 — 금액·종목은 찍지 않는다)
const top = holdings as unknown as Record<string, unknown>;
console.log("holdings 최상위 키:", Object.keys(top).join(", "));
for (const [k, v] of Object.entries(top)) if (v && typeof v === "object" && !Array.isArray(v)) console.log(`  ${k}:`, Object.keys(v as object).join(", "));
