/**
 * 토스 범용 조회 (PLAN §32) — KIS 범용 조회와 같은 원칙 + 토스 고유(계좌번호 가리기·중첩 응답).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	buildTossRequest,
	callTossApi,
	isTossWrite,
	renderTossResult,
	resolveTossApi,
	tossCatalog,
	tossDateToken,
	type TossApi,
} from "../src/toss/gateway.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const api = (id: string): TossApi => {
	const hit = resolveTossApi(id);
	assert.ok(hit, id);
	return hit.api;
};

let seq = 0;
function ctx(): TossContext {
	seq++;
	return { creds: { clientId: `c${seq}-${Math.random()}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `u${seq}` };
}

interface Seen {
	url: URL;
	headers: Record<string, string>;
}
function fakeToss(result: unknown): Seen[] {
	const seen: Seen[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const json = (b: unknown) => new Response(JSON.stringify(b));
		if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json({ result: [{ accountSeq: 42, accountNo: "12345678901" }] });
		seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		return json({ result });
	}) as typeof fetch;
	return seen;
}
function noNetwork(): void {
	globalThis.fetch = (async () => {
		throw new Error("네트워크에 닿으면 안 된다");
	}) as typeof fetch;
}

describe("카탈로그", () => {
	it("조회 29 · 쓰기 6, 조회는 전부 레이트 리밋 그룹이 있다", () => {
		const all = Object.values(tossCatalog().apis);
		assert.equal(all.filter((a) => !isTossWrite(a)).length, 29);
		assert.equal(all.filter(isTossWrite).length, 6);
		for (const a of all.filter((x) => !isTossWrite(x))) assert.ok(a.group, a.summary);
	});

	it("쓰기로 분류된 것은 전부 주문·조건주문의 생성·정정·취소다", () => {
		for (const a of Object.values(tossCatalog().apis).filter(isTossWrite)) assert.match(a.summary, /주문 (생성|정정|취소)|조건주문 (생성|수정|취소)/, a.summary);
	});
});

describe("파라미터", () => {
	const NOW = Date.UTC(2026, 0, 31, 16, 0); // KST 2026-02-01 01:00

	it("날짜 토큰은 KST, 토스 형식(YYYY-MM-DD)", () => {
		assert.equal(tossDateToken("today", NOW), "2026-02-01");
		assert.equal(tossDateToken("today-1", NOW), "2026-01-31");
		assert.equal(tossDateToken("2025-01-01", NOW), "2025-01-01");
	});

	it("date 형식 파라미터에만 토큰을 푼다", () => {
		const { req, errors } = buildTossRequest(api("getStockInvestorTrading"), { symbol: "005930", until: "today-1", count: 5 }, NOW);
		assert.deepEqual(errors, []);
		assert.equal(req.query.until, "2026-01-31");
		assert.equal(req.query.count, "5");
		assert.equal(req.path, "/api/v1/stocks/005930/investor-trading");
	});

	it("경로 파라미터는 인코딩한다 (경로 조작 방지)", () => {
		const { req } = buildTossRequest(api("getStockWarnings"), { symbol: "../orders" });
		assert.equal(req.path, "/api/v1/stocks/..%2Forders/warnings");
	});

	it("모르는 파라미터·빠진 필수·선택지 밖 값을 거절한다", () => {
		assert.ok(buildTossRequest(api("getOrderbook"), { symbol: "005930", symbl: "x" }).errors.some((e) => e.includes("symbl")));
		assert.ok(buildTossRequest(api("getOrderbook"), {}).errors.some((e) => e.includes("symbol")));
		const bad = buildTossRequest(api("getRankings"), { type: "HOT", marketCountry: "KR", duration: "1d" }).errors;
		assert.ok(bad.some((e) => e.includes("선택지 밖") && e.includes("MARKET_TRADING_AMOUNT")), bad.join(" / "));
	});

	it("필수 파라미터가 빠지면 선택지를 함께 알린다", () => {
		const errs = buildTossRequest(api("getRankings"), { type: "TOP_GAINERS" }).errors;
		assert.ok(errs.some((e) => e.includes("duration") && e.includes("1mo")), errs.join(" / "));
	});
});

describe("호출", () => {
	it("쓰기 API 는 네트워크에 닿기 전에 거절한다", async () => {
		noNetwork();
		for (const [id, a] of Object.entries(tossCatalog().apis)) {
			if (isTossWrite(a)) await assert.rejects(callTossApi(ctx(), id, {}), /쓰기 API/, id);
		}
	});

	it("계좌 API 는 서버가 계좌를 넣는다 — 모델이 준 계좌 값은 무시", async () => {
		const seen = fakeToss({ items: [] });
		await callTossApi(ctx(), "getCommissions", { "X-Tossinvest-Account": "999" });
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.headers["X-Tossinvest-Account"], "42");
	});

	it("계좌와 무관한 API 에는 계좌 헤더를 싣지 않는다", async () => {
		const seen = fakeToss({ bids: [] });
		await callTossApi(ctx(), "getOrderbook", { symbol: "005930" });
		assert.equal(seen[0]!.headers["X-Tossinvest-Account"], undefined);
		assert.equal(seen[0]!.url.searchParams.get("symbol"), "005930");
	});

	it("id 는 대소문자 무관, 없는 id 는 안내", async () => {
		fakeToss([]);
		await callTossApi(ctx(), "getorderbook", { symbol: "005930" });
		await assert.rejects(callTossApi(ctx(), "getNothing", {}), /없는 토스 API/);
	});
});

describe("출력", () => {
	it("중첩 응답을 경로로 펴고, 한글 설명 범례를 붙인다", () => {
		const out = renderTossResult(api("getStockInvestorTrading"), {
			nextUntil: "2026-09-10",
			records: [
				{ date: "2026-09-23", individual: null, foreigner: { buyVolume: "10", sellVolume: "4", netBuyVolume: "6" } },
				{ date: "2026-09-22", individual: null, foreigner: { buyVolume: "1", sellVolume: "2", netBuyVolume: "-1" } },
			],
		});
		assert.match(out.text, /nextUntil: 2026-09-10/);
		assert.match(out.text, /date\tforeigner\.buyVolume\tforeigner\.sellVolume\tforeigner\.netBuyVolume/);
		assert.match(out.text, /2026-09-23\t10\t4\t6/);
		assert.match(out.text, /foreigner\.netBuyVolume: 순매수 거래량/);
		assert.doesNotMatch(out.text, /individual/, "전부 빈 열은 뺀다");
		assert.equal(out.rowCount, 3);
	});

	it("계좌번호는 끝 4자리만", () => {
		const out = renderTossResult(api("getAccounts"), [{ accountSeq: 42, accountNo: "12345678901", accountType: "X" }]);
		assert.doesNotMatch(out.text, /12345678901/);
		assert.match(out.text, /\*\*\*\*8901/);
	});

	it("limit·fields 로 줄인다", () => {
		const records = Array.from({ length: 40 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, foreigner: { netBuyVolume: String(i) }, institution: { netBuyVolume: "1" } }));
		const out = renderTossResult(api("getStockInvestorTrading"), { records }, { limit: 3, fields: ["date", "foreigner"] });
		assert.match(out.text, /40행 \(앞 3행만\)/);
		assert.doesNotMatch(out.text, /institution/);
		assert.equal(out.text.split("\n").filter((l) => /^2026-/.test(l)).length, 3);
	});

	it("빈 응답이면 비었다고 말한다", () => {
		assert.equal(renderTossResult(api("getStockInvestorTrading"), { records: [] }).empty, true);
	});
});
