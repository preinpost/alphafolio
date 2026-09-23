/**
 * KIS 조회 API 전수 실측 — 카탈로그의 GET 257개를 실제 키로 한 번씩 호출해 분류한다 (PLAN §31).
 *
 *   ok      데이터가 왔다
 *   empty   정상 응답인데 데이터가 없다 (장 시간·조회일 영향 포함)
 *   param   KIS 가 입력값을 거절했다 — 대개 이 스크립트가 넣은 **예시값** 문제다 (API 가 안 되는 게 아니다)
 *   denied  권한·서비스 미신청·계좌 종류 불일치
 *   error   그 밖의 실패
 *
 * 예시값은 규격의 입력 안내에서 추측한다 (예: "J:KRX" → J, 종목 005930, 해외 AAPL, 날짜 최근 30일).
 * 결과: packages/broker/src/kis/catalog-status.json — **ok 인 API 목록만** 저장한다 (응답 데이터·계좌 정보는 저장하지 않는다).
 *   empty·param 은 API 문제인지 예시값 문제인지 가릴 수 없다 — 실제로 순위 API 18개가 empty 였는데 규격 예시대로
 *   채우니 전부 30행씩 왔다. 그래서 실패 쪽은 모델에게 보여주지 않는다 (멀쩡한 API 를 피하게 된다).
 *
 * 실행: node spike/07-kis-sweep.ts
 * 토큰은 서버와 같은 D1 저장소·같은 소유자로 — 새로 발급하면 알림이 가고 발급 횟수 제한에 걸린다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callKisApi, defaultFor, isWriteApi, kisCatalog, renderKisResult, type CatalogApi, KisError, parseAccount, type KisContext } from "@alphafolio/broker";
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { createBrokerTokenStore } from "../apps/server/src/broker-tokens.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secret = process.env.AF_AUTH_SECRET ?? "";
const secrets = new SecretStore(() => d1ConfigFromEnv(), secret, false);
await secrets.load();
const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
const ctx: KisContext = {
	creds: {
		appKey: secrets.get("KIS_APP_KEY", user) ?? "",
		appSecret: secrets.get("KIS_APP_SECRET", user) ?? "",
		cano: account.cano,
		prdtCd: account.prdtCd,
		env: "real",
	},
	store: createBrokerTokenStore(() => d1ConfigFromEnv(), secret),
	owner: user,
};

/** 입력 안내에서 첫 번째 선택지를 뽑는다: `J:KRX, NX:NXT` → J, `"1" 입력` → 1 */
function firstOption(desc: string): string | undefined {
	// 규격의 예시가 가장 정확하다: ex) "111111111"
	const ex = /ex\)?\s*["'“]([^"'”]{1,12})["'”]/i.exec(desc);
	if (ex) return ex[1];
	const quoted = /["'“]([A-Za-z0-9]{1,6})["'”]/.exec(desc);
	const opt = /(?:^|[\s(,])([A-Z0-9]{1,5})\s*[:：]/.exec(desc);
	return (opt?.[1] ?? quoted?.[1]) || undefined;
}

function sample(api: CatalogApi, code: string, spec: [string, number, string]): string {
	const c = code.toUpperCase();
	const [label, , desc] = spec;
	const overseas = api.category.includes("해외");
	const sector = /업종|지수/.test(api.name) || /업종/.test(label);
	if (/^NDAY$|DAY_CNT|_NDAY/.test(c)) return firstOption(desc) ?? "0";
	if (/DATE|_DT$|_YMD|BYMD/.test(c) || /일자|날짜/.test(label)) {
		if (/_2$|END|종료|TO/.test(c) || /종료|끝/.test(label)) return "today";
		if (/_1$|STRT|시작|FROM/.test(c) || /시작/.test(label)) return "today-30";
		return "today-1";
	}
	if (/HOUR|TIME|_TM$/.test(c)) return firstOption(desc) ?? "";
	if (c === "FID_INPUT_ISCD" || /종목코드|종목번호/.test(label)) {
		if (sector) return "0001";
		if (/ETF|ETN|NAV/.test(api.name)) return "069500";
		if (overseas) return "AAPL";
		return firstOption(desc)?.length === 6 ? (firstOption(desc) as string) : "005930";
	}
	if (/^(SYMB|PDNO|OVRS_PDNO|ITEM_CD)$/.test(c) || /심볼|상품번호/.test(label)) return overseas ? "AAPL" : "005930";
	if (/EXCD|EXCG_CD|EXCG/.test(c) || /거래소/.test(label)) return firstOption(desc) ?? (c.includes("OVRS") ? "NASD" : "NAS");
	if (/CRCY|통화/.test(c + label)) return "USD";
	if (/^AUTH$/.test(c)) return "";
	return firstOption(desc) ?? "";
}

/** 예시값 추측으로는 안 되는 API — 규격 예시대로 손으로 채운 값 (필터가 비면 대상이 0개가 된다) */
const OVERRIDES: Record<string, Record<string, string>> = {
	"domestic_stock.v1_국내주식-047": { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "0000", FID_DIV_CLS_CODE: "0", FID_BLNG_CLS_CODE: "0", FID_TRGT_CLS_CODE: "111111111", FID_TRGT_EXLS_CLS_CODE: "0000000000", FID_INPUT_PRICE_1: "", FID_INPUT_PRICE_2: "", FID_VOL_CNT: "" },
	"domestic_stock.v1_국내주식-091": { fid_cond_mrkt_div_code: "J", fid_div_cls_code: "0", fid_input_iscd: "0000", fid_trgt_cls_code: "0", fid_trgt_exls_cls_code: "0", fid_input_price_1: "", fid_input_price_2: "", fid_vol_cnt: "" },
};

type Status = "ok" | "empty" | "param" | "denied" | "error";
const results: Record<string, { status: Status; msg?: string }> = {};
const apis = Object.entries(kisCatalog().apis).filter(([, a]) => !isWriteApi(a));
console.log(`조회 API ${apis.length}개 점검 (호출 간격 300ms, 약 ${Math.ceil((apis.length * 0.35) / 60)}분)`);

let n = 0;
for (const [key, api] of apis) {
	n++;
	const input: Record<string, string> = {};
	for (const [code, spec] of Object.entries(api.params)) {
		if (code === "CANO" || code === "ACNT_PRDT_CD" || /^CTX_AREA_/i.test(code)) continue;
		// 고정값은 게이트웨이가 채운다 — 모델이 쓸 때와 같은 조건으로 점검한다
		if (defaultFor(api, code, spec) !== undefined) continue;
		input[code] = sample(api, code, spec);
	}
	if (OVERRIDES[key]) Object.assign(input, OVERRIDES[key]);
	try {
		const r = await callKisApi(ctx, key, input, { trId: api.trIds[0] });
		const out = renderKisResult(r);
		results[key] = { status: out.empty ? "empty" : "ok" };
	} catch (err) {
		const msg = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 140) : String(err);
		const code = err instanceof KisError ? err.code : undefined;
		const status: Status = /자료가 없|조회된 데이터가 없|없습니다\.?$/.test(msg)
			? "empty"
			: /권한|신청|서비스|계좌|허용되지|미등록|가입/.test(msg)
				? "denied"
				: /입력|INPUT|유효|형식|필수|잘못|범위|코드를 확인|파라미터/.test(msg) || code === "OPCODE"
					? "param"
					: "error";
		results[key] = { status, msg };
	}
	if (n % 25 === 0) console.log(`  ${n}/${apis.length}`);
}

const count = (s: Status) => Object.values(results).filter((r) => r.status === s).length;
console.log(`\nok ${count("ok")} · empty ${count("empty")} · param ${count("param")} · denied ${count("denied")} · error ${count("error")}`);

// 분류별 대표 사유
for (const s of ["param", "denied", "error"] as Status[]) {
	const reasons = new Map<string, number>();
	for (const r of Object.values(results)) if (r.status === s && r.msg) reasons.set(r.msg.replace(/^.*? 실패: /, "").slice(0, 60), (reasons.get(r.msg.replace(/^.*? 실패: /, "").slice(0, 60)) ?? 0) + 1);
	const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
	if (top.length > 0) console.log(`\n[${s}] 주요 사유:\n${top.map(([m, c]) => `  ${c}× ${m}`).join("\n")}`);
}

// 분류별·카테고리별
const byCat = new Map<string, Record<Status, number>>();
for (const [key, r] of Object.entries(results)) {
	const cat = kisCatalog().apis[key]!.category;
	const row = byCat.get(cat) ?? { ok: 0, empty: 0, param: 0, denied: 0, error: 0 };
	row[r.status]++;
	byCat.set(cat, row);
}
console.log("\n카테고리별 (ok/empty/param/denied/error):");
for (const [cat, r] of [...byCat.entries()].sort()) console.log(`  ${cat.padEnd(20)} ${r.ok}/${r.empty}/${r.param}/${r.denied}/${r.error}`);

const dest = join(dirname(fileURLToPath(import.meta.url)), "../packages/broker/src/kis/catalog-status.json");
const ok = Object.entries(results).filter(([, r]) => r.status === "ok").map(([k]) => k).sort();
writeFileSync(dest, JSON.stringify({ checked: new Date().toISOString().slice(0, 10), ok }, null, 0));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.data/kis-sweep.json"), JSON.stringify(results, null, 2));
console.log(`\n저장: ${dest}\n상세(사유 포함, gitignore): .data/kis-sweep.json`);
process.exit(0);
