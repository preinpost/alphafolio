/**
 * 스냅샷 시점 판단 테스트.
 *
 * 컨테이너는 UTC 로 돈다. KST 16시 = UTC 07시이고, KST 자정 전후로 UTC 날짜가
 * 하루 어긋난다 — 이 경계가 틀리면 "오늘 찍었는데 또 찍거나", "평일인데 주말로 보고
 * 건너뛰는" 일이 조용히 생긴다. 과거 스냅샷은 되살릴 수 없으니 빠진 날은 영구 결손이다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PortfolioSummary } from "@alphafolio/broker";
import { inWindow, kstParts, shouldSnapshot, toSnapshot } from "../src/snapshots.ts";

/** KST 벽시계 시각으로 Date 를 만든다 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

describe("KST 환산", () => {
	it("UTC 날짜와 KST 날짜가 갈리는 구간을 KST 로 본다", () => {
		// KST 2026-09-23 08:00 = UTC 2026-09-22 23:00
		const p = kstParts(kst("2026-09-23T08:00:00"));
		assert.equal(p.date, "2026-09-23");
		assert.equal(p.hour, 8);
	});

	it("요일도 KST 기준이다", () => {
		// 2026-09-26 은 토요일. KST 토 01:00 = UTC 금 16:00
		assert.equal(kstParts(kst("2026-09-26T01:00:00")).weekday, 6);
		assert.equal(kstParts(kst("2026-09-25T23:00:00")).weekday, 5); // 금
	});
});

describe("촬영 시점", () => {
	it("평일 16시 이후, 오늘 아직 안 찍었으면 찍는다", () => {
		assert.equal(shouldSnapshot(kst("2026-09-23T16:00:00"), "2026-09-22"), true);
		assert.equal(shouldSnapshot(kst("2026-09-23T23:59:00"), null), true);
	});

	it("16시 전에는 안 찍는다 (종가가 아니다)", () => {
		assert.equal(shouldSnapshot(kst("2026-09-23T15:59:00"), "2026-09-22"), false);
		assert.equal(shouldSnapshot(kst("2026-09-23T09:00:00"), null), false);
	});

	it("오늘 이미 찍었으면 다시 안 찍는다", () => {
		assert.equal(shouldSnapshot(kst("2026-09-23T20:00:00"), "2026-09-23"), false);
	});

	it("주말에는 안 찍는다", () => {
		assert.equal(shouldSnapshot(kst("2026-09-26T17:00:00"), "2026-09-25"), false); // 토
		assert.equal(shouldSnapshot(kst("2026-09-27T17:00:00"), "2026-09-25"), false); // 일
	});

	it("UTC 로는 전날이어도 KST 로 오늘이면 오늘자로 판단한다", () => {
		// KST 수 00:30 은 16시 전이므로 안 찍는다. UTC 로 보면 화 15:30 이라
		// 날짜만 UTC 로 잘못 보면 "화요일자 미촬영 → 찍기"가 되는데 그러면 안 된다.
		assert.equal(shouldSnapshot(kst("2026-09-23T00:30:00"), "2026-09-21"), false);
	});

	it("서버가 16시에 꺼져 있었어도 켜진 뒤 그날 안에 찍는다", () => {
		assert.equal(shouldSnapshot(kst("2026-09-23T22:10:00"), "2026-09-21"), true);
	});
});

describe("저장 가능 시간대 (수동 촬영에도 적용)", () => {
	it("새벽 수동 촬영은 저장하지 않는다 — 16시 스케줄러의 종가 스냅샷을 가리면 안 된다", () => {
		assert.equal(inWindow(kst("2026-09-23T01:00:00")), false);
		assert.equal(inWindow(kst("2026-09-23T16:00:00")), true);
		assert.equal(inWindow(kst("2026-09-26T18:00:00")), false); // 토
	});
});

describe("스냅샷 변환", () => {
	it("총액 = 주식 평가 + 예수금, 보유 종목을 필요한 필드만 남긴다", () => {
		const p: PortfolioSummary = {
			holdings: [
				{
					broker: "toss",
					symbol: "005930",
					name: "삼성전자",
					market: "domestic",
					currency: "KRW",
					quantity: 10,
					avgPrice: 250_000,
					price: 277_500,
					value: 2_775_000,
					profit: 275_000,
					profitPct: 11,
					valueKrw: 2_775_000,
				},
			],
			brokers: ["toss"],
			stockValueKrw: 2_775_000,
			cashKrw: 100_000,
			profitKrw: 275_000,
			usdKrw: 1_380,
			warnings: [],
		};
		const s = toSnapshot("ms", "2026-09-23", p);
		assert.equal(s.totalKrw, 2_875_000);
		assert.equal(s.holdings.length, 1);
		assert.deepEqual(Object.keys(s.holdings[0] ?? {}).sort(), [
			"avgPrice",
			"broker",
			"currency",
			"name",
			"price",
			"quantity",
			"symbol",
			"valueKrw",
		]);
	});
});
