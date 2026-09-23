/**
 * KIS 범용 조회 (PLAN §31).
 *
 * 지켜야 할 것:
 *   - 쓰기(주문·정정·취소) API 는 네트워크에 닿기 전에 거절한다
 *   - 계좌번호는 서버 값만 쓴다 (모델이 넣은 값 무시)
 *   - 모르는 파라미터·빠진 필수 파라미터는 조용히 넘기지 않는다
 *   - 날짜 토큰은 한국 시간 기준
 *   - 연속조회는 서버가 이어 받고, 한도에서 멈추면 알린다
 *   - 응답 필드는 한글 이름으로, 빈 열은 뺀다
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	buildKisQuery,
	callKisApi,
	fixedValue,
	strictValue,
	findKisApis,
	isWriteApi,
	kisCatalog,
	renderKisResult,
	resolveDateToken,
	resolveKisApi,
	type CatalogApi,
} from "../src/kis/gateway.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { KisContext } from "../src/kis/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

let seq = 0;
function ctx(cano?: string): KisContext {
	seq++;
	return {
		creds: { appKey: `key-${seq}-${Math.random()}`, appSecret: "s", env: "real", ...(cano ? { cano, prdtCd: "01" } : {}) },
		store: memoryTokenStore(),
		owner: `u${seq}`,
	};
}

interface Seen {
	url: URL;
	headers: Record<string, string>;
}

/** 가짜 KIS — pages 를 차례로 돌려준다 (tr_cont 헤더 포함) */
function fakeKis(pages: Array<{ body: Record<string, unknown>; trCont?: string }>): Seen[] {
	const seen: Seen[] = [];
	let i = 0;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }));
		seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		const p = pages[Math.min(i++, pages.length - 1)]!;
		return new Response(JSON.stringify({ rt_cd: "0", msg1: "정상", ...p.body }), { headers: { tr_cont: p.trCont ?? "D" } });
	}) as typeof fetch;
	return seen;
}

function noNetwork(): void {
	globalThis.fetch = (async () => {
		throw new Error("네트워크에 닿으면 안 된다");
	}) as typeof fetch;
}

const INVESTOR = "FHPTJ04160001"; // 종목별 투자자매매동향(일별)
const api = (ref: string): CatalogApi => {
	const hit = resolveKisApi(ref);
	assert.ok(hit, ref);
	return hit.api;
};

describe("카탈로그", () => {
	it("조회 257개 · 쓰기 18개, 모든 API 에 TR ID 와 경로가 있다", () => {
		const all = Object.values(kisCatalog().apis);
		assert.equal(all.filter((a) => !isWriteApi(a)).length, 257);
		assert.equal(all.filter(isWriteApi).length, 18);
		for (const a of all) {
			assert.ok(a.trIds.length > 0 && a.path.startsWith("/uapi/"), a.name);
		}
	});

	it("쓰기로 분류된 것은 전부 주문·정정·취소·예약 류다 (조회를 막지 않았다)", () => {
		for (const a of Object.values(kisCatalog().apis).filter(isWriteApi)) {
			assert.match(a.name, /주문|정정|취소|예약/, a.name);
		}
	});
});

describe("찾기", () => {
	it("'외국인 수급' 으로 투자자 매매동향 API 가 나온다", () => {
		const names = findKisApis("외국인 수급 동향").map((f) => f.api.name);
		assert.ok(names.some((n) => /투자자매매동향|외국인/.test(n)), names.join(" / "));
	});

	it("붙여 쓴 말도 찾는다 ('외국인수급동향')", () => {
		const names = findKisApis("외국인수급동향").map((f) => f.api.name);
		assert.ok(names.some((n) => /투자자매매동향|외국인/.test(n)), names.join(" / "));
	});

	it("TR ID 로 찾으면 그 API 가 맨 위", () => {
		assert.equal(findKisApis(INVESTOR)[0]?.api.trIds[0], INVESTOR);
	});

	it("공매도·신용·시가총액·배당도 찾는다", () => {
		for (const [q, re] of [
			["공매도 추이", /공매도/],
			["신용잔고", /신용잔고/],
			["시총 순위", /시가총액/],
			["배당률 상위", /배당/],
		] as const) {
			const names = findKisApis(q).map((f) => f.api.name);
			assert.ok(names.some((n) => re.test(n)), `${q}: ${names.join(" / ")}`);
		}
	});

	it("없는 말이면 빈 목록", () => {
		assert.deepEqual(findKisApis("zzzz없는말zzzz"), []);
	});
});

describe("파라미터", () => {
	const NOW = Date.UTC(2026, 0, 31, 16, 0); // 한국 시간 2026-02-01 01:00

	it("날짜 토큰은 한국 시간 기준 (UTC 로는 아직 1월 31일)", () => {
		assert.equal(resolveDateToken("today", NOW), "20260201");
		assert.equal(resolveDateToken("today-1", NOW), "20260131");
		assert.equal(resolveDateToken("today-30", NOW), "20260102");
		assert.equal(resolveDateToken("TODAY+1", NOW), "20260202");
		assert.equal(resolveDateToken("20250101", NOW), "20250101", "날짜 토큰이 아니면 그대로");
	});

	it("안내에 값이 하나만 적혀 있으면 그 값을 기본값으로", () => {
		assert.equal(fixedValue("J"), "J");
		assert.equal(fixedValue("00"), "00");
		assert.equal(fixedValue("03 입력"), "03");
		assert.equal(fixedValue('"1" 입력'), "1");
		assert.equal(fixedValue("시장구분코드 (주식 J)"), "J");
		assert.equal(fixedValue("시장구분코드 (W)"), "W");
		assert.equal(fixedValue("W(Unique key)"), "W");
		assert.equal(fixedValue("Unique key(11173)"), "11173");
	});

	it("조건·예시·선택지면 채우지 않는다 — 모델이 고른다", () => {
		assert.equal(fixedValue('전종목일 경우 "%" 입력'), undefined);
		assert.equal(fixedValue("입력 시간(ex 13시 130000)"), undefined);
		assert.equal(fixedValue("J:KRX, NX:NXT, UN:통합"), undefined);
		assert.equal(fixedValue("Y/N"), undefined);
		assert.equal(fixedValue("조회시작일자(YYYYMMDD)"), undefined);
		assert.equal(fixedValue(""), undefined);
	});

	it("빠뜨린 고정값 파라미터는 서버가 채운다 (FID_ETC_CLS_CODE \"1\" 입력)", () => {
		const { query, errors } = buildKisQuery(api(INVESTOR), { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922" }, null);
		assert.deepEqual(errors, []);
		assert.equal(query.FID_ETC_CLS_CODE, "1");
	});

	it("기본값 성격이면 모델 값이 우선 (시장 코드 NX 등)", () => {
		const a: CatalogApi = { ...api(INVESTOR), params: { ...api(INVESTOR).params, FID_COND_MRKT_DIV_CODE: ["시장", 1, "시장구분코드 (주식 J)"] } };
		const { query } = buildKisQuery(a, { FID_COND_MRKT_DIV_CODE: "NX", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922" }, null);
		assert.equal(query.FID_COND_MRKT_DIV_CODE, "NX");
	});

	it("반드시 그 값이어야 하면 모델이 다른 값을 줘도 규격 값 ('\"1\" 입력' 에 0, '공란 입력' 에 0 — 실측)", () => {
		const { query } = buildKisQuery(api(INVESTOR), { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922", FID_ETC_CLS_CODE: 0, FID_ORG_ADJ_PRC: 0 }, null);
		assert.equal(query.FID_ETC_CLS_CODE, "1");
		assert.equal(query.FID_ORG_ADJ_PRC, "");
	});

	it("강제값 판정은 좁게 — 조건이 붙은 공란·선택지는 강제하지 않는다", () => {
		assert.equal(strictValue('"1" 입력'), "1");
		assert.equal(strictValue("공란 입력"), "");
		assert.equal(strictValue("Unique key(20171)"), "20171");
		assert.equal(strictValue("공란 입력 시 전체 조회"), undefined);
		assert.equal(strictValue("시장구분코드 (주식 J)"), undefined);
		assert.equal(strictValue("0: 전체, 1:보통주"), undefined);
		assert.equal(strictValue(""), undefined);
	});

	it("코드는 대소문자 무관, 한글명으로도 받는다", () => {
		const a = api(INVESTOR);
		const { query, errors } = buildKisQuery(
			a,
			{ fid_cond_mrkt_div_code: "J", 입력종목코드: "005930", FID_INPUT_DATE_1: "today", FID_ETC_CLS_CODE: "1" },
			null,
			NOW,
		);
		assert.deepEqual(errors, []);
		assert.equal(query.FID_COND_MRKT_DIV_CODE, "J");
		assert.equal(query.FID_INPUT_ISCD, "005930");
		assert.equal(query.FID_INPUT_DATE_1, "20260201");
		assert.equal(query.FID_ORG_ADJ_PRC, "", "'공란 입력' 필수 파라미터는 서버가 빈 값으로");
	});

	it("모르는 파라미터는 거절한다 (오타가 조용히 무시되지 않게)", () => {
		const { errors } = buildKisQuery(api(INVESTOR), { FID_INPUT_ISCD: "005930", FID_INPUT_ISCDD: "000660" }, null);
		assert.ok(errors.some((e) => e.includes("FID_INPUT_ISCDD")), errors.join(" / "));
	});

	it("빠진 필수 파라미터는 한글명·안내와 함께 알린다", () => {
		const { errors } = buildKisQuery(api(INVESTOR), { FID_COND_MRKT_DIV_CODE: "J" }, null);
		assert.ok(errors.some((e) => e.includes("FID_INPUT_ISCD") && e.includes("종목")), errors.join(" / "));
	});

	it("계좌번호는 서버 값만 — 모델이 넣은 값은 무시한다", () => {
		const acct = Object.entries(kisCatalog().apis).find(([, a]) => !isWriteApi(a) && "CANO" in a.params)!;
		const { query } = buildKisQuery(acct[1], { CANO: "99999999", ACNT_PRDT_CD: "99" }, { CANO: "12345678", ACNT_PRDT_CD: "01" });
		assert.equal(query.CANO, "12345678");
		assert.equal(query.ACNT_PRDT_CD, "01");
	});

	it("계좌 파라미터가 소문자로 적힌 규격이어도 서버 값만 쓴다", () => {
		const fake: CatalogApi = {
			name: "가짜", category: "[국내주식] 주문/계좌", method: "GET", path: "/uapi/x", trIds: ["X"], desc: "", fields: {},
			params: { cano: ["종합계좌번호", 1, ""], acnt_prdt_cd: ["계좌상품코드", 1, ""] },
		};
		const { query, errors } = buildKisQuery(fake, { cano: "99999999", acnt_prdt_cd: "99" }, { CANO: "12345678", ACNT_PRDT_CD: "01" });
		assert.deepEqual(errors, []);
		assert.equal(query.cano, "12345678");
		assert.equal(query.acnt_prdt_cd, "01");
	});

	it("계좌가 필요한데 계좌번호가 없으면 설정 안내", () => {
		const acct = Object.values(kisCatalog().apis).find((a) => !isWriteApi(a) && "CANO" in a.params)!;
		const { errors } = buildKisQuery(acct, {}, null);
		assert.ok(errors.some((e) => e.includes("계좌번호")));
	});

	it("연속조회 키는 모델 값을 무시하고 빈 값으로 시작한다", () => {
		const cont = Object.values(kisCatalog().apis).find((a) => !isWriteApi(a) && Object.keys(a.params).some((c) => /^CTX_AREA_/.test(c)))!;
		const code = Object.keys(cont.params).find((c) => /^CTX_AREA_/.test(c))!;
		const { query } = buildKisQuery(cont, { [code]: "조작된값" }, { CANO: "12345678", ACNT_PRDT_CD: "01" });
		assert.equal(query[code], "");
	});
});

describe("호출", () => {
	it("쓰기 API 는 네트워크에 닿기 전에 거절한다", async () => {
		noNetwork();
		const write = Object.entries(kisCatalog().apis).filter(([, a]) => isWriteApi(a));
		for (const [key] of write) {
			await assert.rejects(callKisApi(ctx("12345678"), key, {}), /쓰기 API/, key);
		}
	});

	it("TR ID 가 여러 개면 고르라고 한다", async () => {
		noNetwork();
		const multi = Object.entries(kisCatalog().apis).find(([, a]) => !isWriteApi(a) && a.trIds.length > 1)!;
		await assert.rejects(callKisApi(ctx("12345678"), multi[0], {}), /tr_id 로 고르세요/);
	});

	it("정상 호출 — 경로·TR ID·파라미터가 그대로 간다", async () => {
		const seen = fakeKis([{ body: { output1: { stck_prpr: "70000" }, output2: [{ stck_bsop_date: "20260922", frgn_ntby_qty: "-1200" }] } }]);
		const r = await callKisApi(ctx(), INVESTOR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922", FID_ETC_CLS_CODE: "1" });
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.url.pathname, api(INVESTOR).path);
		assert.equal(seen[0]!.headers.tr_id, INVESTOR);
		assert.equal(seen[0]!.url.searchParams.get("FID_INPUT_ISCD"), "005930");
		assert.equal(r.pages.length, 1);
		assert.equal(r.truncated, false);
	});

	it("연속조회 — 다음 페이지는 tr_cont N + 응답의 CTX 키로", async () => {
		const [key, a] = Object.entries(kisCatalog().apis).find(
			([, x]) => !isWriteApi(x) && !("CANO" in x.params) && Object.keys(x.params).some((c) => /^CTX_AREA_/.test(c)),
		) ?? Object.entries(kisCatalog().apis).find(([, x]) => !isWriteApi(x) && Object.keys(x.params).some((c) => /^CTX_AREA_/.test(c)))!;
		const code = Object.keys(a.params).find((c) => /^CTX_AREA_/.test(c))!;
		const input = Object.fromEntries(Object.entries(a.params).filter(([c, p]) => p[1] && !/^CTX_AREA_/.test(c) && c !== "CANO" && c !== "ACNT_PRDT_CD").map(([c]) => [c, "X"]));
		const seen = fakeKis([
			{ body: { output: [{ a: "1" }], [code.toLowerCase()]: "NEXTKEY   " }, trCont: "M" },
			{ body: { output: [{ a: "2" }] }, trCont: "D" },
		]);
		const r = await callKisApi(ctx("12345678"), key, input, { pages: 3, ...(a.trIds.length > 1 ? { trId: a.trIds[0] } : {}) });
		assert.equal(r.pages.length, 2);
		assert.equal(seen[0]!.headers.tr_cont, undefined, "첫 페이지는 tr_cont 없이");
		assert.equal(seen[1]!.headers.tr_cont, "N");
		assert.equal(seen[1]!.url.searchParams.get(code), "NEXTKEY", "공백은 잘라서 넘긴다");
		assert.equal(r.truncated, false);
	});

	it("페이지 한도에서 멈추면 truncated", async () => {
		fakeKis([{ body: { output2: [{ stck_bsop_date: "1" }] }, trCont: "M" }]);
		const r = await callKisApi(ctx(), INVESTOR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922", FID_ETC_CLS_CODE: "1" }, { pages: 2 });
		assert.equal(r.pages.length, 2);
		assert.equal(r.truncated, true);
	});

	it("KIS 실패(rt_cd≠0)는 메시지와 함께 예외", async () => {
		globalThis.fetch = (async (input: string | URL) => {
			if (new URL(String(input)).pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "t", expires_in: 86400 }));
			return new Response(JSON.stringify({ rt_cd: "1", msg_cd: "OPSQ", msg1: "조회할 자료가 없습니다" }));
		}) as typeof fetch;
		await assert.rejects(
			callKisApi(ctx(), INVESTOR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930", FID_INPUT_DATE_1: "20260922", FID_ETC_CLS_CODE: "1" }),
			/조회할 자료가 없습니다/,
		);
	});
});

describe("출력", () => {
	const result = (pages: Array<Record<string, unknown>>) => ({ key: "k", api: api(INVESTOR), trId: INVESTOR, pages, truncated: false });

	it("필드를 한글 이름으로, 빈 열은 뺀다", () => {
		const out = renderKisResult(
			result([{ output2: [{ stck_bsop_date: "20260922", frgn_ntby_qty: "-1200", prsn_ntby_qty: "", orgn_ntby_qty: "300" }] }]),
		);
		assert.match(out.text, /외국인 순매수 수량/);
		assert.match(out.text, /기관계 순매수 수량|기관 순매수 수량/);
		assert.doesNotMatch(out.text, /frgn_ntby_qty/);
		assert.doesNotMatch(out.text, /개인 순매수 수량/, "전부 빈 열은 뺀다");
		assert.match(out.text, /-1200/);
	});

	it("목록은 limit 만큼, 전체 행 수는 알린다", () => {
		const rows = Array.from({ length: 50 }, (_, i) => ({ stck_bsop_date: String(20260101 + i), frgn_ntby_qty: String(i) }));
		const out = renderKisResult(result([{ output2: rows }]), { limit: 5 });
		assert.equal(out.rowCount, 50);
		assert.match(out.text, /50행 \(앞 5행만\)/);
		assert.equal(out.text.split("\n").filter((l) => /^2026/.test(l)).length, 5);
	});

	it("fields 에 표 머리 이름을 단위째 넘겨도 고른다 ('외국인 순매수 수량 [주]' — 실측에서 세 번 재시도한 원인)", () => {
		const out = renderKisResult(result([{ output2: [{ stck_bsop_date: "20260922", frgn_ntby_qty: "-1", orgn_ntby_qty: "3" }] }]), {
			fields: ["주식 영업 일자", "외국인 순매수 수량 [주]"],
		});
		assert.match(out.text, /외국인 순매수 수량/);
		assert.match(out.text, /20260922/);
		assert.doesNotMatch(out.text, /기관/);
	});

	it("순매수 열은 표시된 행의 합계를 붙인다 (모델이 직접 더하지 않게), 가격은 더하지 않는다", () => {
		const out = renderKisResult(
			result([{ output2: [
				{ stck_bsop_date: "20260923", stck_clpr: "100", frgn_ntby_qty: "4513767" },
				{ stck_bsop_date: "20260922", stck_clpr: "200", frgn_ntby_qty: "-1000000" },
				{ stck_bsop_date: "20260921", stck_clpr: "300", frgn_ntby_qty: "10" },
			] }]),
			{ limit: 2 },
		);
		const sum = out.text.split("\n").find((l) => l.startsWith("합계"));
		assert.ok(sum, out.text);
		const cells = sum!.split("\t");
		assert.equal(cells[0], "합계(표시된 2행)");
		assert.ok(cells.includes("3513767"), `표시된 2행만 더한다: ${sum}`);
		assert.ok(!cells.includes("300") && !cells.includes("600"), "가격은 더하지 않는다");
	});

	it("fields 로 열을 고른다 (한글명 일부)", () => {
		const out = renderKisResult(result([{ output2: [{ stck_bsop_date: "20260922", frgn_ntby_qty: "-1", orgn_ntby_qty: "3" }] }]), {
			fields: ["외국인"],
		});
		assert.match(out.text, /외국인/);
		assert.doesNotMatch(out.text, /기관/);
	});

	it("한 건짜리 응답은 '한글명: 값' 줄", () => {
		const out = renderKisResult(result([{ output1: { stck_prpr: "70000", prdy_vrss: "" } }]));
		assert.match(out.text, /주식 현재가: 70000/);
		assert.doesNotMatch(out.text, /전일 대비:/);
	});

	it("여러 페이지의 목록은 이어 붙인다", () => {
		const out = renderKisResult(result([{ output2: [{ stck_bsop_date: "1" }] }, { output2: [{ stck_bsop_date: "2" }] }]));
		assert.equal(out.rowCount, 2);
	});

	it("데이터가 없으면 비었다고 말한다", () => {
		const out = renderKisResult(result([{ output2: [] }]));
		assert.equal(out.empty, true);
		assert.match(out.text, /데이터가 없습니다/);
	});
});
