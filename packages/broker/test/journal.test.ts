/** 매매일지 (PLAN §42) — 입력 검증 · ref · 체결 내역 파서 · 가져오기 계획 · 요약 · 도구. 네트워크 없음. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderAction } from "../src/actions.ts";
import type { EquityOrder } from "../src/binance/stocks.ts";
import type { TossOrder } from "../src/toss/orders.ts";
import {
	atOfDate,
	binanceFill,
	binanceMarketOf,
	binanceStockFill,
	defaultCurrency,
	execCurrency,
	execRefs,
	fillSources,
	journalStats,
	JournalValidationError,
	kisDomesticFill,
	kisOverseasFill,
	kisRef,
	normalizeTags,
	orderJournal,
	parseJournalNotes,
	parseJournalTrade,
	planSync,
	replacedRefs,
	tossFill,
	type BrokerFill,
	type JournalEntry,
	type KnownEntry,
} from "../src/journal/index.ts";
import { createJournalTools, entryLine, periodRange } from "../src/journal/tool.ts";

// 2026-10-08 10:00 KST (= 01:00 UTC) — 뉴욕은 10-07 21:00
const NOW = Date.parse("2026-10-08T10:00:00+09:00");

const invalid = (run: () => unknown, re?: RegExp): void => {
	assert.throws(run, (err: unknown) => {
		assert.ok(err instanceof JournalValidationError, String(err));
		if (re) assert.match(err.message, re);
		return true;
	});
};

describe("입력 검증", () => {
	it("날짜 — 오늘이면 지금, 지난 날이면 그날 KST 정오. 미래·없는 날은 거절", () => {
		assert.equal(atOfDate("2026-10-08", NOW), NOW);
		assert.equal(atOfDate("2026-10-01", NOW), Date.parse("2026-10-01T12:00:00+09:00"));
		invalid(() => atOfDate("2026-10-09", NOW), /미래/);
		invalid(() => atOfDate("2026-02-30", NOW), /실제로/);
		invalid(() => atOfDate("10/01", NOW), /YYYY-MM-DD/);
	});

	it("통화 기본값 — 국내 코드는 원, 코인 마켓은 호가 자산, 나머지는 달러", () => {
		assert.equal(defaultCurrency("005930"), "KRW");
		assert.equal(defaultCurrency("0101N0"), "KRW");
		assert.equal(defaultCurrency("BTCUSDT"), "USDT");
		assert.equal(defaultCurrency("ethusdc"), "USDC");
		assert.equal(defaultCurrency("AAPL"), "USD");
		assert.equal(defaultCurrency("USDT"), "USD", "호가 자산 이름만이면 마켓이 아니다");
	});

	it("태그 — 문자열·배열 모두, # 와 중복을 뺀다. 너무 길거나 많으면 거절", () => {
		assert.deepEqual(normalizeTags("#돌파, 실적  #돌파"), ["돌파", "실적"]);
		assert.deepEqual(normalizeTags(["#눌림", " ", "눌림"]), ["눌림"]);
		assert.deepEqual(normalizeTags(undefined), []);
		invalid(() => normalizeTags(["x".repeat(21)]), /20자/);
		invalid(() => normalizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`)), /10개/);
		invalid(() => normalizeTags([3]));
	});

	it("직접 기록 — 심볼을 대문자로, 통화를 심볼로 정하고, 잘못된 값은 거절", () => {
		const t = parseJournalTrade({ symbol: "aapl", side: "BUY", quantity: 1.5, price: 230.1, date: "2026-10-07" }, false, NOW);
		assert.equal(t.symbol, "AAPL");
		assert.equal(t.currency, "USD");
		assert.equal(t.broker, "other");
		assert.equal(t.at, Date.parse("2026-10-07T12:00:00+09:00"));
		assert.equal(t.price, 230.1);
		assert.equal(t.fee, null);
		invalid(() => parseJournalTrade({ symbol: "AAPL", side: "buy", quantity: 1 }, false, NOW), /side/);
		invalid(() => parseJournalTrade({ symbol: "AAPL", side: "BUY", quantity: 0 }, false, NOW), /quantity/);
		invalid(() => parseJournalTrade({ symbol: "삼성전자", side: "BUY", quantity: 1 }, false, NOW), /symbol/);
		invalid(() => parseJournalTrade({ symbol: "AAPL", side: "BUY", quantity: 1, broker: "nh" }, false, NOW), /broker/);
		invalid(() => parseJournalTrade({ symbol: "AAPL", side: "BUY", quantity: 1, currency: "달러" }, false, NOW), /currency/);
		// 고치기 — 온 칸만
		assert.deepEqual(parseJournalTrade({ price: 231 }, true, NOW), { price: 231 });
	});

	it("메모 — 빈 글은 null, 감정은 정해 둔 것만, 가격은 양수", () => {
		const n = parseJournalNotes({ thesis: "  ", targetPrice: 80000, emotion: "조급", tags: "a" }, false);
		assert.deepEqual(n, { thesis: null, targetPrice: 80000, stopPrice: null, tags: ["a"], emotion: "조급", review: null });
		assert.deepEqual(parseJournalNotes({ review: "다음엔 분할" }, true), { review: "다음엔 분할" });
		invalid(() => parseJournalNotes({ emotion: "행복" }, true), /emotion/);
		invalid(() => parseJournalNotes({ stopPrice: -1 }, true), /stopPrice/);
		invalid(() => parseJournalNotes({ thesis: "x".repeat(1001) }, true), /1000자/);
	});
});

describe("ref — 주문 접수 · 자동 매매 · 가져오기가 같은 주문을 같은 문자열로", () => {
	const place = (over: Partial<Extract<OrderAction, { kind: "place" }>>): OrderAction => ({
		kind: "place",
		broker: "toss",
		symbol: "005930",
		market: "KR",
		currency: "KRW",
		side: "BUY",
		orderType: "LIMIT",
		quantity: 10,
		price: 71000,
		estimatedAmount: 710000,
		...over,
	});

	it("한국투자 — 국장은 KST 날짜, 미장은 뉴욕 날짜. 주문번호 앞 0 은 뗀다", () => {
		const kr = orderJournal(place({ broker: "kis" }), "0000012345", NOW)!;
		assert.equal(kr.ref, "kis:20261008:12345");
		const us = orderJournal(place({ broker: "kis", symbol: "AAPL", market: "US", currency: "USD", price: 230 }), "777", NOW)!;
		assert.equal(us.ref, "kis:20261007:777", "뉴욕은 아직 10월 7일");
		// 체결 내역 쪽도 같은 ref
		assert.equal(kisDomesticFill({ ord_dt: "20261008", odno: "12345", pdno: "005930", ord_qty: "10", tot_ccld_qty: "10", avg_prvs: "71000", rmn_qty: "0" })!.ref, kr.ref);
	});

	it("토스·Binance — 접수 때 pending 한 줄, 지정가·주문 수량을 맥락에", () => {
		const t = orderJournal(place({}), "T-1", NOW)!;
		assert.equal(t.ref, "toss:T-1");
		assert.equal(t.input.status, "pending");
		assert.equal(t.input.source, "order");
		assert.deepEqual(t.input.context, { orderType: "LIMIT", ordered: 10, limitPrice: 71000 });
		const b = orderJournal(
			{ kind: "binance-place", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", side: "BUY", type: "MARKET", quoteOrderQty: "100", estimatedQuote: "100" },
			"991",
			NOW,
		)!;
		assert.equal(b.ref, "binance:BTCUSDT:991");
		assert.equal(b.input.quantity, 0, "금액 주문은 수량을 모른다");
		assert.equal(b.input.currency, "USDT");
		assert.equal(b.input.context?.orderAmount, 100);
		const s = orderJournal({ kind: "binance-stock-place", broker: "binance_stock", symbol: "AAPL", quote: "USDC", side: "SELL", type: "LIMIT", quantity: "0.5", price: "231.10", estimatedQuote: "115.55" }, "uuid-1", NOW)!;
		assert.equal(s.ref, "binance_stock:uuid-1");
		assert.equal(s.input.currency, "USD");
		assert.equal(s.input.price, 231.1);
	});

	it("매매 한 건이 아닌 동작·주문번호 없는 응답은 남기지 않는다", () => {
		assert.equal(orderJournal(place({}), undefined, NOW), null);
		assert.equal(orderJournal({ kind: "conditional-cancel", broker: "toss", conditionalOrderId: "C-1" } as unknown as OrderAction, "C-1", NOW), null);
	});

	it("정정 — 주문번호가 바뀌면 원주문 ref 에 새 ref 를 잇는다", () => {
		const original = { orderId: "00100", side: "BUY" as const, orderType: "LIMIT" as const, openQuantity: 5, price: 70000, orderedAt: null };
		const modify: OrderAction = { kind: "modify", broker: "kis", symbol: "005930", market: "KR", currency: "KRW", original, orderType: "LIMIT", quantity: 5, price: 69000 };
		assert.deepEqual(replacedRefs(modify, "101", NOW), { parent: "kis:20261008:100", child: "kis:20261008:101" });
		assert.equal(replacedRefs(modify, "100", NOW), null, "같은 번호면 이을 게 없다");
		assert.deepEqual(replacedRefs({ ...modify, broker: "toss" } as OrderAction, "T-2", NOW), { parent: "toss:00100", child: "toss:T-2" });
	});

	it("자동 매매 자식 주문 — KIS 는 ref 의 주문일, 주문번호 없는 것은 뺀다", () => {
		assert.deepEqual(execRefs("kis", "005930", [{ orderId: "0012", ref: "91234|20261008" }, { orderId: null, ref: null }, { orderId: "13", ref: "91234|20261008" }]), [
			"kis:20261008:12",
			"kis:20261008:13",
		]);
		assert.deepEqual(execRefs("binance", "ETHUSDT", [{ orderId: "5", ref: null }]), ["binance:ETHUSDT:5"]);
		assert.equal(execCurrency("binance", "ETHUSDT", "USDT"), "USDT");
		assert.equal(execCurrency("binance_stock", "AAPL", "USD"), "USD");
		assert.equal(execCurrency("kis", "005930", "KRW"), "KRW");
	});
});

describe("체결 내역 파서", () => {
	const tossOrder = (over: Partial<TossOrder> & { execution?: Partial<TossOrder["execution"]> }): TossOrder =>
		({
			orderId: "T-1",
			symbol: "AAPL",
			side: "BUY",
			orderType: "LIMIT",
			timeInForce: "DAY",
			status: "FILLED",
			price: "230",
			quantity: "3",
			orderAmount: null,
			currency: "USD",
			orderedAt: "2026-10-07T22:31:00+09:00",
			canceledAt: null,
			...over,
			execution: { filledQuantity: "3", averageFilledPrice: "229.5", filledAmount: "688.5", commission: "0.17", tax: "0.01", filledAt: "2026-10-07T22:31:05+09:00", ...over.execution },
		}) as TossOrder;

	it("토스 — 수수료 + 세금, 체결 시각. 취소는 체결 0 으로 (앱 주문의 '체결 없이 끝남')", () => {
		const f = tossFill(tossOrder({}))!;
		assert.equal(f.ref, "toss:T-1");
		assert.equal(f.filled, 3);
		assert.equal(f.price, 229.5);
		assert.equal(f.fee, 0.18);
		assert.equal(f.at, Date.parse("2026-10-07T22:31:05+09:00"));
		assert.equal(f.open, false);
		// 오프셋 없는 시각도 KST 로
		assert.equal(tossFill(tossOrder({ execution: { filledAt: "2026-10-07T22:31:05" } }))!.at, f.at);
		const c = tossFill(tossOrder({ status: "CANCELED", execution: { filledQuantity: "0", averageFilledPrice: null, filledAt: null } }))!;
		assert.equal(c.filled, 0);
		assert.equal(c.price, null);
		assert.equal(c.fee, null);
	});

	it("한국투자 국장 — 매도 코드 01, 잔량이 있으면 open, 정정 주문은 원주문에 잇는다", () => {
		const f = kisDomesticFill({ ord_dt: "20261008", ord_tmd: "091512", odno: "0000000202", orgn_odno: "0000000201", sll_buy_dvsn_cd: "01", pdno: "005930", prdt_name: "삼성전자", ord_qty: "10", tot_ccld_qty: "4", avg_prvs: "71200", rmn_qty: "6" })!;
		assert.equal(f.ref, "kis:20261008:202");
		assert.equal(f.parentRef, "kis:20261008:201");
		assert.equal(f.side, "SELL");
		assert.equal(f.name, "삼성전자");
		assert.equal(f.open, true);
		assert.equal(f.at, Date.parse("2026-10-08T09:15:12+09:00"));
		assert.equal(kisDomesticFill({ ord_dt: "", odno: "1", pdno: "005930" }), null);
	});

	it("한국투자 미장 — 현지 날짜로 ref, 국내 시각으로 at, 취소 주문 줄과 거부는 체결로 보지 않는다", () => {
		const row = { ord_dt: "20261007", dmst_ord_dt: "20261008", thco_ord_tmd: "002000", odno: "0000777", pdno: "aapl", prdt_name: "애플", sll_buy_dvsn_cd: "02", ft_ord_qty: "2", ft_ccld_qty: "2", ft_ccld_unpr3: "229.10", nccs_qty: "0", prcs_stat_name: "완료", tr_crcy_cd: "USD" };
		const f = kisOverseasFill(row)!;
		assert.equal(f.ref, "kis:20261007:777");
		assert.equal(f.symbol, "AAPL");
		assert.equal(f.at, Date.parse("2026-10-08T00:20:00+09:00"));
		assert.equal(f.price, 229.1);
		assert.equal(kisOverseasFill({ ...row, rvse_cncl_dvsn: "02" }), null);
		assert.equal(kisOverseasFill({ ...row, ft_ccld_qty: "0", nccs_qty: "2", prcs_stat_name: "거부" })!.open, false);
	});

	it("Binance — 평단 = 누적 체결금액 / 수량, 미국 주식은 수수료까지", () => {
		const f = binanceFill({ symbol: "ETHUSDT", orderId: 42, side: "BUY", status: "FILLED", origQty: "0.5", executedQty: "0.5", cummulativeQuoteQty: "1350.5", time: 1, updateTime: 2 }, "USDT")!;
		assert.equal(f.ref, "binance:ETHUSDT:42");
		assert.equal(f.price, 2701);
		assert.equal(f.at, 2);
		assert.equal(binanceFill({ symbol: "ETHUSDT", orderId: 43, status: "NEW", executedQty: "0" }, "USDT")!.open, true);
		const o: EquityOrder = { orderId: "u-1", clientOrderId: null, symbol: "aapl", side: "SELL", orderType: "MARKET", limitPrice: null, qty: "0.5", notional: null, filledQty: "0.5", avgFilledPrice: "231", status: "FILLED", session: null, fee: "0.02", createdAt: 5 };
		const s = binanceStockFill(o, NOW)!;
		assert.deepEqual([s.ref, s.symbol, s.price, s.fee, s.at, s.open], ["binance_stock:u-1", "AAPL", 231, 0.02, 5, false]);
		assert.deepEqual(binanceMarketOf("btcfdusd"), { symbol: "BTCFDUSD", quote: "FDUSD" });
		assert.equal(binanceMarketOf("ETHBTC"), null);
	});
});

describe("체결 출처", () => {
	it("연결된 계좌만 — 계좌번호 없는 KIS·모의투자·Binance 테스트넷·키 없는 곳은 뺀다 (만들 때 부르지 않는다)", () => {
		const kis = (cano: string | undefined, env: "real" | "paper" = "real") => () => ({ creds: { appKey: "k", appSecret: "s", cano, prdtCd: "01", env }, store: {} as never, owner: "ms" });
		const none = () => {
			throw new Error("키 없음");
		};
		const labels = (access: Parameters<typeof fillSources>[0]) => fillSources(access, { binanceSymbols: async () => [] }).map((s) => s.label);
		assert.deepEqual(labels({ kis: kis("12345678"), toss: none, binance: () => ({ key: "k", secret: "s" }) }), ["한국투자 국장", "한국투자 미장", "Binance 현물", "Binance 미국 주식"]);
		assert.deepEqual(labels({ kis: kis(undefined) }), []);
		assert.deepEqual(labels({ kis: kis("12345678", "paper") }), []);
		assert.deepEqual(labels({ binance: () => ({ key: "k", secret: "s", testnet: true }) }), []);
		assert.deepEqual(labels({ toss: () => ({ creds: { clientId: "c", clientSecret: "s" }, store: {} as never, owner: "ms" }) }), ["토스"]);
	});
});

const fill = (over: Partial<BrokerFill>): BrokerFill => ({
	ref: "toss:T-1",
	parentRef: null,
	broker: "toss",
	symbol: "005930",
	name: null,
	side: "BUY",
	ordered: 10,
	filled: 10,
	price: 71000,
	currency: "KRW",
	fee: 70,
	at: NOW,
	open: false,
	...over,
});
const known = (over: Partial<KnownEntry>): KnownEntry => ({ id: "j1", source: "order", status: "pending", quantity: 10, price: 71000, fee: null, name: "삼성전자", refs: ["toss:T-1"], ...over });

describe("가져오기 계획", () => {
	it("앱에서 낸 주문(pending) — 체결로 채우고, 체결 0 으로 끝났으면 canceled (주문 수량은 남긴다)", () => {
		const p = planSync([fill({ filled: 7, price: 70900 })], [known({})]);
		assert.deepEqual(p.updates, [{ id: "j1", addRefs: [], patch: { status: "filled", quantity: 7, price: 70900, fee: 70 } }]);
		assert.deepEqual(p.inserts, []);
		const c = planSync([fill({ filled: 0, price: null, fee: null })], [known({})]);
		assert.deepEqual(c.updates[0]!.patch, { status: "canceled", quantity: 10, price: 71000, fee: null });
	});

	it("바뀐 게 없으면 쓰지 않는다 — 두 번 가져와도 그대로", () => {
		const p = planSync([fill({})], [known({ status: "filled", fee: 70 })]);
		assert.deepEqual(p, { updates: [], inserts: [] });
	});

	it("정정 사슬 — 원주문과 새 주문의 체결을 합쳐 한 줄로, 새 번호를 잇는다", () => {
		const fills = [
			fill({ ref: "kis:20261008:201", broker: "kis", filled: 4, price: 71000 }),
			fill({ ref: "kis:20261008:202", parentRef: "kis:20261008:201", broker: "kis", filled: 6, price: 70500 }),
		];
		const p = planSync(fills, [known({ refs: ["kis:20261008:201"] })]);
		assert.equal(p.updates.length, 1);
		assert.deepEqual(p.updates[0]!.addRefs, ["kis:20261008:202"]);
		assert.equal(p.updates[0]!.patch.quantity, 10);
		assert.equal(p.updates[0]!.patch.price, 70700, "수량 가중 평균");
		assert.equal(p.updates[0]!.patch.fee, 140);
		// 원주문을 모르면 한 줄로 새로 들어온다
		const fresh = planSync(fills, []);
		assert.equal(fresh.inserts.length, 1);
		assert.deepEqual(fresh.inserts[0]!.refs.sort(), ["kis:20261008:201", "kis:20261008:202"]);
		assert.equal(fresh.inserts[0]!.input.quantity, 10);
	});

	it("앱 밖 매매는 새 줄 (import) — 미체결·체결 0·지운 기록은 넣지 않는다", () => {
		const p = planSync(
			[
				fill({ ref: "toss:A", at: NOW - 2 }),
				fill({ ref: "toss:B", open: true, filled: 3 }),
				fill({ ref: "toss:C", filled: 0, price: null }),
				fill({ ref: "toss:D", at: NOW - 5, name: "카카오", symbol: "035720" }),
				fill({ ref: "toss:E" }),
			],
			[],
			new Set(["toss:E"]),
		);
		assert.deepEqual(
			p.inserts.map((i) => [i.refs[0], i.input.source, i.input.status, i.input.name]),
			[
				["toss:D", "import", "filled", "카카오"],
				["toss:A", "import", "filled", null],
			],
			"오래된 것부터",
		);
	});

	it("자동 매매·직접 기록은 숫자를 건드리지 않고, 새 주문번호만 잇는다", () => {
		const auto = known({ source: "auto", status: "filled", refs: ["kis:20261008:1"] });
		const p = planSync([fill({ ref: "kis:20261008:2", parentRef: "kis:20261008:1", filled: 999 })], [auto]);
		assert.deepEqual(p.updates, [{ id: "j1", addRefs: ["kis:20261008:2"], patch: { status: "filled", quantity: 10, price: 71000, fee: null } }]);
		assert.deepEqual(planSync([fill({ ref: "kis:20261008:1" })], [auto]), { updates: [], inserts: [] });
	});

	it("코인 소수 수량 — 덧셈 오차를 지운다", () => {
		const p = planSync(
			[fill({ ref: "binance:ETHUSDT:1", broker: "binance", filled: 0.1, price: 2700 }), fill({ ref: "binance:ETHUSDT:2", parentRef: "binance:ETHUSDT:1", broker: "binance", filled: 0.2, price: 2700 })],
			[],
		);
		assert.equal(p.inserts[0]!.input.quantity, 0.3);
	});
});

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
	id: "j1",
	at: NOW,
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

describe("요약 · 도구", () => {
	it("요약 — 체결 없이 끝난 주문은 세지 않고, 근거·회고·손절가 비율과 태그·감정을 센다", () => {
		const s = journalStats([
			entry({ thesis: "돌파", stopPrice: 68000, tags: ["돌파"], emotion: "확신" }),
			entry({ id: "j2", side: "SELL", review: "익절", tags: ["돌파", "실적"], source: "import" }),
			entry({ id: "j3", status: "canceled", thesis: "x", tags: ["취소"] }),
			entry({ id: "j4", status: "pending", source: "auto" }),
		]);
		assert.deepEqual([s.total, s.buys, s.sells, s.pending, s.canceled, s.withThesis, s.withReview, s.buysWithStop], [3, 2, 1, 1, 1, 1, 1, 1]);
		assert.deepEqual(s.tags, [{ tag: "돌파", count: 2 }, { tag: "실적", count: 1 }]);
		assert.deepEqual(s.bySource, { manual: 0, order: 1, auto: 1, import: 1 });
	});

	it("목록 한 줄 — id · 날짜 · 매수 · 수량 @ 가격 · 계좌 · 경로 · 메모", () => {
		const line = entryLine(entry({ thesis: "20일선 지지", stopPrice: 68000, tags: ["눌림"], status: "pending" }));
		assert.equal(line, "- [j1] 2026-10-08 삼성전자(005930) 매수 10주 @ 71,000원 (체결 확인 전) · 토스 · 챗 주문 | 근거: 20일선 지지 · 손절 68,000원 · #눌림");
		assert.match(entryLine(entry({ broker: "binance", symbol: "ETHUSDT", name: null, quantity: 0.5, price: 2700, currency: "USDT" })), /ETHUSDT 매수 0\.5 @ 2,700 USDT/);
	});

	it("기간 — KST 날짜 경계", () => {
		assert.deepEqual(periodRange("today", NOW), { from: Date.parse("2026-10-08T00:00:00+09:00") });
		assert.deepEqual(periodRange("last_7d", NOW), { from: Date.parse("2026-10-02T00:00:00+09:00") });
		assert.deepEqual(periodRange("this_month", NOW), { from: Date.parse("2026-10-01T00:00:00+09:00") });
		assert.deepEqual(periodRange("all", NOW), {});
	});

	it("도구 — 직접 기록은 daysAgo 를 날짜로, 고치기는 0·'' 을 지우기로, 목록은 가져오기 결과와 요약을 싣는다", async () => {
		const calls: unknown[] = [];
		const tools = createJournalTools({
			now: () => NOW,
			list: async (f) => {
				calls.push(["list", f]);
				return [entry({ thesis: "돌파" }), entry({ id: "j2" })];
			},
			add: async (trade, notes) => {
				calls.push(["add", trade, notes]);
				return entry({ ...trade, ...notes, source: "manual" });
			},
			update: async (id, notes) => {
				calls.push(["update", id, notes]);
				return entry({ id, ...notes });
			},
			sync: async () => ({ added: 2, updated: 1, sources: [{ broker: "toss", label: "토스", fills: 3, error: null }, { broker: "kis", label: "한국투자 미장", fills: 0, error: "해외 서비스 미신청" }], warnings: [] }),
		});
		const by = new Map(tools.map((t) => [t.name, t]));
		const run = (name: string, args: unknown) => by.get(name)!.execute("t", args as never, undefined, undefined, undefined as never);

		await run("journal_add", { symbol: "005930", side: "BUY", quantity: 10, daysAgo: 1, emotion: "차분" });
		const [, trade, notes] = calls.pop() as [string, { at: number; currency: string }, { emotion: string }];
		assert.equal(trade.at, Date.parse("2026-10-07T12:00:00+09:00"));
		assert.equal(trade.currency, "KRW");
		assert.equal(notes.emotion, "차분");

		await run("journal_update", { id: "j1", stopPrice: 0, emotion: "", review: "지켰다" });
		assert.deepEqual(calls.pop(), ["update", "j1", { stopPrice: null, emotion: null, review: "지켰다" }]);
		await assert.rejects(run("journal_update", { id: "j1" }), /바꿀 칸/);

		const out = await run("journal_list", { period: "this_month", refresh: true });
		const text = (out.content[0] as { text: string }).text;
		assert.match(text, /가져오기: 새 기록 2건 · 체결 반영 1건 · 실패 한국투자 미장\(해외 서비스 미신청\)/);
		assert.match(text, /체결 2건: 매수 2 · 매도 0/);
		assert.match(text, /근거 기록 1\/2/);
		assert.deepEqual(calls.pop(), ["list", { from: Date.parse("2026-10-01T00:00:00+09:00"), limit: 500 }]);
	});

	it("잘못된 직접 기록은 저장소까지 가지 않는다", async () => {
		let added = 0;
		const [add] = createJournalTools({ now: () => NOW, list: async () => [], add: async () => (added++, entry({})), update: async () => entry({}), sync: async () => ({ added: 0, updated: 0, sources: [], warnings: [] }) });
		await assert.rejects(add!.execute("t", { symbol: "005930", side: "BUY", quantity: 1, date: "2026-12-01" } as never, undefined, undefined, undefined as never), /미래/);
		assert.equal(added, 0);
		assert.equal(kisRef("2026-10-08", "007"), "kis:20261008:7");
	});
});
