/** 옵션 시세 원시 응답 확인 — 국내 옵션 전광판·종목 시세, 해외 옵션·선물 */
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { callKisApi, parseAccount, type KisContext } from "@alphafolio/broker";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";
loadEnv();
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secrets = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
await secrets.load();
const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const ctx: KisContext = {
	creds: { appKey: secrets.get("KIS_APP_KEY", user)!, appSecret: secrets.get("KIS_APP_SECRET", user)!, cano: account.cano, prdtCd: account.prdtCd, env: "real" },
	store: createBrokerTokenStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? ""),
	owner: user,
};
const show = async (api: string, params: Record<string, string>) => {
	try {
		const r = await callKisApi(ctx, api, params, { pages: Number(process.env.PAGES ?? 1) });
		if (process.env.PAGES) {
			for (const k of ["output1", "output2"]) {
				const rows = r.pages.flatMap((p) => (p[k] as Array<Record<string, string>> | undefined) ?? []);
				const atm = rows.filter((x) => x.atm_cls_name === "ATM");
				console.log(k, rows.length, "ATM", atm.map((x) => `${x.optn_shrn_iscd} ${x.acpr} ${x.optn_prpr} iv ${x.hts_ints_vltl} d ${x.delta_val} g ${x.gama} t ${x.theta} v ${x.vega}`));
			}
			return;
		}
		const j = JSON.stringify(r.pages?.[0] ?? r, null, 0);
		console.log(`== ${api}`, j.slice(0, Number(process.env.N ?? 1500)));
	} catch (e) {
		console.log(`== ${api} 오류`, (e as Error).message);
	}
};
const [mode, ...rest] = process.argv.slice(2);
if (mode === "list") await show("FHPIO056104C0", { FID_COND_SCR_DIV_CODE: "509", FID_COND_MRKT_DIV_CODE: "", FID_COND_MRKT_CLS_CODE: "" });
if (mode === "board") await show("FHPIF05030100", { FID_COND_MRKT_DIV_CODE: "O", FID_COND_SCR_DIV_CODE: "20503", FID_MRKT_CLS_CODE: "CO", FID_MTRT_CNT: rest[0]!, FID_COND_MRKT_CLS_CODE: "", FID_MRKT_CLS_CODE1: "PO" });
if (mode === "quote") await show("FHMIF10000000", { FID_COND_MRKT_DIV_CODE: rest[1] ?? "O", FID_INPUT_ISCD: rest[0]! });
if (mode === "ovo") {
	await show("HHDFO55010000", { SRS_CD: rest[0]! });
	await show("HHDFO55010100", { SRS_CD: rest[0]! });
}
if (mode === "ovf") await show("HHDFC55010000", { SRS_CD: rest[0]! });
if (mode === "greeks") {
	const { createDerivativesTools } = await import("../packages/broker/src/derivatives/tool.ts");
	const [tool] = createDerivativesTools({ brokers: { kis: () => ctx } });
	const args = { code: rest[0]!, ...(rest[1] ? { quantity: Number(rest[1]) } : {}) };
	const r = (await tool!.execute("x", args as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
	console.log(r.content[0]!.text);
}
