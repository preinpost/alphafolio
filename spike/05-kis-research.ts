/**
 * KIS 재무·컨센서스 원시 응답 확인.
 *
 * 포털 스펙의 필드명이 부정확해서(컨센서스는 ELW 라벨이 섞여 있다) 정규화 전에
 * 실제 모양을 눈으로 본다.
 *
 * 실행: node spike/05-kis-research.ts [종목코드…]
 */
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import {
	domesticConsensus,
	domesticFinancialRatios,
	domesticIncomeStatement,
	parseAccount,
	type KisContext,
} from "@alphafolio/broker";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

loadEnv();

const user = process.env.AF_AUTH_USER ?? "alpha";
const secrets = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
await secrets.load();

const appKey = secrets.get("KIS_APP_KEY", user);
const appSecret = secrets.get("KIS_APP_SECRET", user);
if (!appKey || !appSecret) {
	console.error("KIS 키가 없습니다.");
	process.exit(1);
}

const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const ctx: KisContext = {
	creds: { appKey, appSecret, cano: account.cano, prdtCd: account.prdtCd, env: "real" },
	// 서버와 같은 D1 토큰 캐시를 쓴다 — KIS 는 토큰 발급이 1분당 1회로 제한되고
	// 발급마다 알림톡이 간다. 메모리 스토어를 쓰면 스파이크를 돌릴 때마다 재발급된다.
	store: createBrokerTokenStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? ""),
	owner: "spike",
};

const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["005930", "226340"];

function show(title: string, value: unknown): void {
	const rows = Array.isArray(value) ? value : value ? [value] : [];
	console.log(`  ${title}: ${rows.length}행`);
	const first = rows[0] as Record<string, unknown> | undefined;
	if (!first) return;
	const entries = Object.entries(first).filter(([, v]) => String(v ?? "").trim() !== "");
	console.log(`    ${entries.map(([k, v]) => `${k}=${String(v)}`).join("  ")}`.slice(0, 420));
}

for (const symbol of symbols) {
	console.log(`\n══ ${symbol} ══════════════════════════════`);

	const ratios = await domesticFinancialRatios(ctx, symbol);
	console.log("[재무비율]");
	show("output", ratios.output);

	const income = await domesticIncomeStatement(ctx, symbol);
	console.log("[손익계산서]");
	show("output", income.output);

	const cons = await domesticConsensus(ctx, symbol);
	console.log("[컨센서스]");
	console.log(`  top-level: ${Object.entries(cons).filter(([k, v]) => !k.startsWith("output") && String(v ?? "").trim() !== "").map(([k, v]) => `${k}=${String(v)}`).join("  ")}`.slice(0, 300));
	for (const key of ["output1", "output2", "output3", "output4"]) {
		if (cons[key] !== undefined) show(key, cons[key]);
	}
}
