/**
 * KIS 실시간(웹소켓) 실측 — 구독 → N초 수신 → 요약.
 * 실행: node spike/09-kis-stream.ts [TR:종목 …] [초]
 *   예: node spike/09-kis-stream.ts H0STCNT0:005930 H0STASP0:005930 H0UPCNT0:0001 5
 */
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { parseAccount, type KisContext } from "@alphafolio/broker";
import { renderStream, streamKis } from "../packages/broker/src/kis/stream.ts";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secrets = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
await secrets.load();
const appKey = secrets.get("KIS_APP_KEY", user);
const appSecret = secrets.get("KIS_APP_SECRET", user);
if (!appKey || !appSecret) throw new Error("KIS 키 없음");
const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const ctx: KisContext = {
	creds: { appKey, appSecret, cano: account.cano, prdtCd: account.prdtCd, env: "real" },
	store: createBrokerTokenStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? ""),
	owner: user,
};
const args = process.argv.slice(2);
const seconds = /^\d+$/.test(args.at(-1) ?? "") ? Number(args.pop()) : 5;
const reqs = (args.length ? args : ["H0STCNT0:005930", "H0STASP0:005930"]).map((a) => {
	const [api, key] = a.split(":");
	return { api: api!, key: key! };
});
const t0 = Date.now();
const r = await streamKis(ctx, reqs, { seconds });
console.log(renderStream(r));
console.log(`\n(${Date.now() - t0}ms, closedBy=${r.closedBy}, 건수 ${r.subs.map((s) => s.records.length).join("/")}, 필드수 확인 ${r.subs.map((s) => `${s.records[0]?.length ?? "-"}/${s.api.fields.length}`).join(" ")})`);
