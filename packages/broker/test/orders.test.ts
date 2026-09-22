/**
 * 주문 검증 단위 테스트.
 *
 * 실제 주문은 돈이 나가서 반복 검증이 불가능하다 — 그래서 "거래소가 거절할 주문"과
 * "사람이 실수한 주문"을 잡는 순수 로직을 여기서 촘촘히 덮는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isOnTick,
	marketOf,
	priceDeviationPct,
	roundToTick,
	tickSize,
	validateOrder,
	type OrderContext,
} from "../src/orders.ts";

const KR: OrderContext = { market: "KR", currency: "KRW", lastPrice: 277_500 };
const US: OrderContext = { market: "US", currency: "USD", lastPrice: 342.8 };

describe("호가단위 (KRX 2023 개정)", () => {
	it("구간별 틱을 정확히 고른다", () => {
		assert.equal(tickSize("KR", 1_999), 1);
		assert.equal(tickSize("KR", 2_000), 5);
		assert.equal(tickSize("KR", 4_999), 5);
		assert.equal(tickSize("KR", 5_000), 10);
		assert.equal(tickSize("KR", 19_999), 10);
		assert.equal(tickSize("KR", 20_000), 50);
		assert.equal(tickSize("KR", 49_999), 50);
		assert.equal(tickSize("KR", 50_000), 100);
		assert.equal(tickSize("KR", 199_999), 100);
		assert.equal(tickSize("KR", 200_000), 500);
		assert.equal(tickSize("KR", 499_999), 500);
		assert.equal(tickSize("KR", 500_000), 1_000);
	});

	it("미국은 0.01 단위", () => {
		assert.equal(tickSize("US", 342.8), 0.01);
	});

	it("틱에 맞춰 내림한다 (올림하면 의도보다 비싸게 산다)", () => {
		assert.equal(roundToTick("KR", 277_530), 277_500);
		assert.equal(roundToTick("KR", 1_234), 1_234); // 1원 단위 구간
		assert.equal(roundToTick("KR", 4_998), 4_995);
		assert.equal(roundToTick("US", 342.789), 342.78);
	});

	it("부동소수점 오차 없이 판정한다", () => {
		assert.equal(isOnTick("US", 342.8), true);
		assert.equal(isOnTick("US", 342.789), false);
		assert.equal(isOnTick("KR", 277_500), true);
		assert.equal(isOnTick("KR", 277_530), false);
	});
});

describe("시장 판별", () => {
	it("6자리 숫자는 국내, 그 외는 해외", () => {
		assert.equal(marketOf("005930"), "KR");
		assert.equal(marketOf("000660"), "KR");
		assert.equal(marketOf("AAPL"), "US");
		assert.equal(marketOf("soxl"), "US");
	});
});

describe("수량", () => {
	it("0·음수를 막는다", () => {
		for (const q of [0, -1, -100]) {
			const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "MARKET", quantity: q }, KR);
			assert.equal(r.ok, false, `${q}주가 통과되면 안 된다`);
		}
	});

	it("국내 소수점 수량을 막는다", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "MARKET", quantity: 1.5 }, KR);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /소수점/);
	});

	it("미국 시장가 매도만 소수점 수량을 허용한다", () => {
		const sell = validateOrder({ symbol: "AAPL", side: "SELL", orderType: "MARKET", quantity: 0.5 }, {
			...US,
			sellable: 1,
		});
		assert.equal(sell.ok, true);

		// 매수는 불가
		const buy = validateOrder({ symbol: "AAPL", side: "BUY", orderType: "MARKET", quantity: 0.5 }, US);
		assert.equal(buy.ok, false);

		// 지정가도 불가
		const limit = validateOrder(
			{ symbol: "AAPL", side: "SELL", orderType: "LIMIT", quantity: 0.5, price: 342.8 },
			{ ...US, sellable: 1 },
		);
		assert.equal(limit.ok, false);
	});
});

describe("지정가", () => {
	it("가격 없으면 거절한다", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1 }, KR);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /가격/);
	});

	it("호가단위를 벗어나면 보정하고 경고한다", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 277_530 }, KR);
		assert.equal(r.ok, true);
		assert.equal(r.normalizedPrice, 277_500);
		assert.match(r.warnings.join(), /호가단위/);
	});

	it("자릿수 오타를 막는다 — 0을 하나 뺀 경우", () => {
		// 277,500 을 27,750 으로 입력 (−90%)
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 27_750 }, KR);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /자릿수/);
	});

	it("자릿수 오타를 막는다 — 0을 하나 더 붙인 경우", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 2_775_000 }, KR);
		assert.equal(r.ok, false);
	});

	it("10~50% 괴리는 경고만 한다 (지정가 걸어두기는 정상 행위)", () => {
		// −20% 지정가 매수 (하락 시 매수 대기)
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 222_000 }, KR);
		assert.equal(r.ok, true);
		assert.match(r.warnings.join(), /차이/);
	});

	it("괴리율을 정확히 계산한다", () => {
		assert.equal(priceDeviationPct(110, 100), 10);
		assert.equal(priceDeviationPct(90, 100), -10);
		assert.equal(priceDeviationPct(100, 0), 0);
	});
});

describe("잔고", () => {
	it("매수 가능 금액을 넘으면 막는다", () => {
		const r = validateOrder(
			{ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 10, price: 277_500 },
			{ ...KR, buyingPower: 1_000_000 },
		);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /매수 가능 금액/);
	});

	it("시장가가 가용 금액에 근접하면 경고한다", () => {
		const r = validateOrder(
			{ symbol: "005930", side: "BUY", orderType: "MARKET", quantity: 1 },
			{ ...KR, buyingPower: 280_000 },
		);
		assert.equal(r.ok, true);
		assert.match(r.warnings.join(), /높게 체결/);
	});

	it("매도 가능 수량을 넘으면 막는다", () => {
		const r = validateOrder(
			{ symbol: "005930", side: "SELL", orderType: "MARKET", quantity: 100 },
			{ ...KR, sellable: 32 },
		);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /매도 가능 수량/);
	});

	it("잔고 정보를 모르면 그것 때문에 막지는 않는다", () => {
		const r = validateOrder({ symbol: "005930", side: "SELL", orderType: "MARKET", quantity: 100 }, KR);
		assert.equal(r.ok, true);
	});
});

describe("예상 금액", () => {
	it("지정가는 보정된 가격으로 계산한다", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 3, price: 277_530 }, KR);
		assert.equal(r.estimatedAmount, 277_500 * 3);
	});

	it("시장가는 현재가로 계산한다", () => {
		const r = validateOrder({ symbol: "005930", side: "BUY", orderType: "MARKET", quantity: 2 }, KR);
		assert.equal(r.estimatedAmount, 277_500 * 2);
	});

	it("시장가는 항상 체결가 변동을 경고한다", () => {
		const r = validateOrder({ symbol: "005930", side: "SELL", orderType: "MARKET", quantity: 1 }, KR);
		assert.match(r.warnings.join(), /체결 가격/);
	});
});
