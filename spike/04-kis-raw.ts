/**
 * KIS 원시 응답 확인 — 정규화에서 버려지는 필드가 있는지 본다.
 *
 * 확인 항목:
 *   a. 국내 현재가 응답에 종목명 필드가 있는가 (지금 심볼로 폴백되고 있다)
 *   b. 국내 잔고가 "빈 계좌"인지 "조용히 빈 응답"인지
 *
 * 실행: node spike/04-kis-raw.ts
 */
import { domesticBalance, domesticPrice, memoryTokenStore, overseasBalance, parseAccount } from "@alphafolio/broker";
import type { KisContext } from "@alphafolio/broker";
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

loadEnv();

// 앱 설정에 저장한 키(= D1 user_secrets)를 그대로 쓴다.
const user = process.env.AF_AUTH_USER ?? "alpha";
const secrets = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
await secrets.load();

const appKey = secrets.get("KIS_APP_KEY", user);
const appSecret = secrets.get("KIS_APP_SECRET", user);
if (!appKey || !appSecret) {
	console.error(`사용자 "${user}" 의 KIS 키가 저장소에 없습니다.`);
	process.exit(1);
}

const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const ctx: KisContext = {
	creds: { appKey, appSecret, cano: account.cano, prdtCd: account.prdtCd, env: "real" },
	store: memoryTokenStore(),
	owner: "spike",
};

function preview(o: unknown, keys: string[]): string {
	const r = (o ?? {}) as Record<string, unknown>;
	return keys.map((k) => `${k}=${JSON.stringify(r[k])}`).join("  ");
}

async function main(): Promise<void> {
	console.log("── a. 국내 현재가 응답의 이름 후보 필드 ──────────────");
	const price = await domesticPrice(ctx, "005930");
	const out = (price.output ?? {}) as Record<string, unknown>;
	const nameish = Object.entries(out).filter(([k, v]) => /name|isnm/i.test(k) || (typeof v === "string" && /삼성/.test(v)));
	console.log(nameish.length > 0 ? nameish.map(([k, v]) => `  ${k} = ${String(v)}`).join("\n") : "  (이름 필드 없음)");
	console.log(`  전체 필드 수: ${Object.keys(out).length}`);

	console.log("\n── b. 국내 잔고 ──────────────────────────────────────");
	const bal = await domesticBalance(ctx);
	const rows = Array.isArray(bal.output1) ? bal.output1 : [];
	console.log(`  rt_cd=${bal.rt_cd} msg=${bal.msg1}`);
	console.log(`  output1 행 수: ${rows.length}`);
	for (const r of rows.slice(0, 5)) {
		console.log(`    ${preview(r, ["pdno", "prdt_name", "hldg_qty", "evlu_amt"])}`);
	}
	const sum = (Array.isArray(bal.output2) ? bal.output2[0] : bal.output2) ?? {};
	console.log(`  output2: ${preview(sum, ["dnca_tot_amt", "tot_evlu_amt", "nass_amt", "scts_evlu_amt"])}`);

	console.log("\n── c. 해외 잔고 ──────────────────────────────────────");
	const ovs = await overseasBalance(ctx);
	const ovsRows = Array.isArray(ovs.output1) ? ovs.output1 : [];
	console.log(`  rt_cd=${ovs.rt_cd} msg=${ovs.msg1}`);
	console.log(`  output1 행 수: ${ovsRows.length}`);
	for (const r of ovsRows.slice(0, 5)) {
		console.log(`    ${preview(r, ["pdno", "prdt_name", "cblc_qty13", "ovrs_now_pric1", "bass_exrt"])}`);
	}
}

main().catch((e: unknown) => {
	console.error("실패:", e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
