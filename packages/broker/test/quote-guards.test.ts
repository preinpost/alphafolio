/**
 * "없는 종목" 방어 테스트.
 *
 * KIS 는 존재하지 않는 종목코드에 오류 대신 0으로 채운 정상 응답(rt_cd=0)을 주고,
 * 종목정보 API 는 엉뚱한 이름이 든 빈 껍데기 레코드를 준다 (실측: 999999 → "(주)피에스엠").
 * 그대로 받으면 시세 0원이 뜨고, 주문 준비의 자릿수 오타 방어가 꺼진다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isListedRecord } from "../src/names.ts";
import { validateOrder } from "../src/orders.ts";
import { isTradablePrice } from "../src/quote.ts";

describe("시세 유효성", () => {
	it("0·음수·NaN 은 시세가 아니다", () => {
		for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(isTradablePrice(p), false, String(p));
	});
	it("양수는 시세다 (1원짜리 동전주, 소수점 해외가 포함)", () => {
		for (const p of [1, 0.01, 276_500]) assert.equal(isTradablePrice(p), true, String(p));
	});
});

describe("종목정보 레코드", () => {
	it("표준코드·시장코드가 전부 비면 상장 종목으로 보지 않는다 (실측 999999)", () => {
		assert.equal(
			isListedRecord({ pdno: "00000A999999", std_pdno: "", mket_id_cd: "", prdt_abrv_name: "(주)피에스엠" }),
			false,
		);
	});
	it("실제 종목은 통과한다 (실측 005930)", () => {
		assert.equal(isListedRecord({ std_pdno: "KR7005930003", mket_id_cd: "STK", prdt_abrv_name: "삼성전자" }), true);
	});
	it("둘 중 하나만 있어도 통과한다", () => {
		assert.equal(isListedRecord({ std_pdno: "", mket_id_cd: "KSQ" }), true);
	});
	it("레코드가 없으면 false", () => {
		assert.equal(isListedRecord(undefined), false);
	});
});

describe("현재가를 모르면 주문을 준비하지 않는다", () => {
	it("현재가 0 이면 지정가도 거절한다 — 괴리율 검사가 꺼진 채 카드가 뜨면 안 된다", () => {
		// 현재가 0 이면 괴리율이 0% 로 계산돼 2,775,000 같은 자릿수 오타가 통과해버린다
		const r = validateOrder(
			{ symbol: "999999", side: "BUY", orderType: "LIMIT", quantity: 1, price: 2_775_000 },
			{ market: "KR", currency: "KRW", lastPrice: 0 },
		);
		assert.equal(r.ok, false);
		assert.match(r.errors.join(), /현재가/);
	});
	it("시장가도 거절한다", () => {
		const r = validateOrder(
			{ symbol: "999999", side: "SELL", orderType: "MARKET", quantity: 1 },
			{ market: "KR", currency: "KRW", lastPrice: Number.NaN },
		);
		assert.equal(r.ok, false);
	});
});
