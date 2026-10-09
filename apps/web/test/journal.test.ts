/**
 * 매매일지 화면 계산 — 기간 · 금액 표시 · 걸러 보기 · 요약 (서버 도구와 같은 규칙).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JournalEntryDto } from "@alphafolio/protocol";
import { filterEntries, kstToday, money, parseNumber, parseTags, periodFrom, summarize, tradeText } from "../src/lib/journal.ts";

const e = (over: Partial<JournalEntryDto>): JournalEntryDto => ({
	id: "j1",
	at: 0,
	date: "2026-10-08",
	broker: "toss",
	symbol: "005930",
	name: "삼성전자",
	side: "BUY",
	quantity: 10,
	price: 71000,
	currency: "KRW",
	fee: null,
	status: "filled",
	source: "order",
	thesis: null,
	targetPrice: null,
	stopPrice: null,
	tags: [],
	emotion: null,
	review: null,
	context: null,
	conversationId: null,
	createdAt: "",
	updatedAt: "",
	...over,
});

describe("매매일지 화면", () => {
	it("기간 — KST 오늘 포함 30일·90일, 올해 1월 1일, 전체는 없음", () => {
		assert.equal(kstToday(Date.parse("2026-10-07T16:30:00Z")), "2026-10-08", "UTC 16:30 = KST 다음 날");
		assert.equal(periodFrom("30d", "2026-10-08"), "2026-09-09");
		assert.equal(periodFrom("90d", "2026-03-01"), "2025-12-02");
		assert.equal(periodFrom("year", "2026-10-08"), "2026-01-01");
		assert.equal(periodFrom("all", "2026-10-08"), undefined);
	});

	it("금액 · 수량 표시 — 원 · 달러 · 코인, 금액 주문", () => {
		assert.equal(money(71000.4, "KRW"), "71,000원");
		assert.equal(money(229.5, "USD"), "$229.50");
		assert.equal(money(0.0123, "USD"), "$0.0123");
		assert.equal(money(2700.5, "USDT"), "2,700.5 USDT");
		assert.equal(tradeText(e({})), "10주 @ 71,000원");
		assert.equal(tradeText(e({ broker: "binance", quantity: 0.25, price: 2700, currency: "USDT" })), "0.25 @ 2,700 USDT");
		assert.equal(tradeText(e({ broker: "binance", quantity: 0, price: null, currency: "USDT", context: { orderAmount: 100 } })), "100 USDT어치");
	});

	it("걸러 보기 — 근거 없음(취소 제외) · 매수 · 확인 전 · 태그 · 검색어(종목명·근거)", () => {
		const list = [
			e({ id: "a", thesis: "돌파", tags: ["돌파"] }),
			e({ id: "b", side: "SELL", name: "카카오", symbol: "035720" }),
			e({ id: "c", status: "canceled" }),
			e({ id: "d", status: "pending" }),
		];
		const ids = (f: Parameters<typeof filterEntries>[1]) => filterEntries(list, f).map((x) => x.id);
		assert.deepEqual(ids({ chip: "missing", tag: null, q: "" }), ["b", "d"]);
		assert.deepEqual(ids({ chip: "SELL", tag: null, q: "" }), ["b"]);
		assert.deepEqual(ids({ chip: "pending", tag: null, q: "" }), ["d"]);
		assert.deepEqual(ids({ chip: "all", tag: "돌파", q: "" }), ["a"]);
		assert.deepEqual(ids({ chip: "all", tag: null, q: "카카" }), ["b"]);
		assert.deepEqual(ids({ chip: "all", tag: null, q: "돌파" }), ["a"]);
	});

	it("요약 — 체결 없이 끝난 주문은 세지 않는다", () => {
		const s = summarize([
			e({ thesis: "x", stopPrice: 68000, tags: ["돌파", "실적"], emotion: "확신" }),
			e({ id: "b", side: "SELL", review: "익절", tags: ["돌파"], emotion: "확신" }),
			e({ id: "c", status: "canceled", tags: ["취소"] }),
		]);
		assert.deepEqual([s.total, s.buys, s.sells, s.withThesis, s.withReview, s.buysWithStop], [2, 1, 1, 1, 1, 1]);
		assert.deepEqual(s.tags, [{ tag: "돌파", count: 2 }, { tag: "실적", count: 1 }]);
		assert.deepEqual(s.emotions, [{ emotion: "확신", count: 2 }]);
	});

	it("입력 — 태그는 서버와 같은 규칙, 숫자는 쉼표를 뗀다", () => {
		assert.deepEqual(parseTags("#돌파, 실적  #돌파"), ["돌파", "실적"]);
		assert.equal(parseNumber("71,000"), 71000);
		assert.equal(parseNumber(" "), null);
		assert.equal(parseNumber("abc"), null);
	});
});
