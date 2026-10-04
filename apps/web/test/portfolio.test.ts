/**
 * 투자 화면 계산 — 계좌를 새로 붙인 날을 "올랐다"로 보이지 않게, 같은 종목은 계좌가 달라도 한 줄로.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerHolding, PortfolioSnapshotDto } from "@alphafolio/protocol";
import { changeSince, compositionBreaks, daysBefore, groupHoldings, historySeries } from "../src/lib/portfolio.ts";

const snap = (date: string, over: Partial<PortfolioSnapshotDto> = {}): PortfolioSnapshotDto => ({
	date,
	totalKrw: 1000,
	stockKrw: 900,
	cashKrw: 100,
	usdKrw: 1400,
	brokers: ["toss"],
	netKrw: 1000,
	cryptoKrw: 0,
	sources: [{ id: "toss", status: "ok", valueKrw: 1000 }],
	...over,
});

describe("추이", () => {
	it("0011 이전 행은 증권 합계로 그리고, 구성이 바뀐 점을 표시한다", () => {
		const points = historySeries([
			snap("2026-09-24", { netKrw: null, sources: null }),
			snap("2026-10-05", { netKrw: 1500, sources: [{ id: "toss", status: "ok", valueKrw: 1000 }, { id: "binance", status: "partial", valueKrw: 500 }] }),
			snap("2026-10-06", { netKrw: 1600, sources: [{ id: "binance", status: "ok", valueKrw: 600 }, { id: "toss", status: "ok", valueKrw: 1000 }] }),
		]);
		assert.deepEqual(points.map((p) => p.value), [1000, 1500, 1600]);
		assert.equal(points[1]!.composition, "binance,toss");
		assert.deepEqual(compositionBreaks(points), [1], "partial 은 구성에 들어간다 (경고만 있는 계좌)");
	});

	it("계좌가 통째로 빠진 날은 partial", () => {
		const [p] = historySeries([snap("2026-10-05", { sources: [{ id: "toss", status: "failed", valueKrw: 0 }] })]);
		assert.equal(p!.partial, true);
	});
});

describe("변동", () => {
	const points = historySeries([
		snap("2026-09-30", { netKrw: 1000 }),
		snap("2026-10-02", { netKrw: 1100 }),
		snap("2026-10-05", { netKrw: 1200 }),
	]);

	it("기준일 이전 마지막 스냅샷과 비교한다", () => {
		assert.deepEqual(changeSince(points, 1320, "toss", "2026-10-05"), { base: 1100, baseDate: "2026-10-02", diff: 220, pct: 20 });
		assert.equal(changeSince(points, 1320, "toss", "2026-10-01")?.baseDate, "2026-09-30", "이번 달 = 전월 마지막 스냅샷");
	});

	it("계좌 구성이 다르면 비교하지 않는다 (계좌를 붙인 걸 상승으로 보이면 안 된다)", () => {
		assert.equal(changeSince(points, 5000, "binance,toss", "2026-10-06"), null);
	});

	it("기준 스냅샷이 없거나 일부 계좌가 빠진 날이면 null", () => {
		assert.equal(changeSince(points, 1000, "toss", "2026-09-01"), null);
		const broken = historySeries([snap("2026-10-02", { sources: [{ id: "toss", status: "failed", valueKrw: 0 }] })]);
		assert.equal(changeSince(broken, 1000, "", "2026-10-05"), null);
	});
});

const h = (over: Partial<BrokerHolding>): BrokerHolding => ({
	broker: "toss",
	symbol: "AAPL",
	name: "애플",
	market: "overseas",
	currency: "USD",
	quantity: 1,
	avgPrice: 100,
	price: 150,
	value: 150,
	profit: 50,
	profitPct: 50,
	valueKrw: 210_000,
	...over,
});

describe("같은 종목 합치기", () => {
	it("계좌가 달라도 시장·통화·심볼이 같으면 한 줄 — 손익률은 평단을 아는 잔고로만", () => {
		const g = groupHoldings([
			h({}),
			h({ broker: "kis", quantity: 2, avgPrice: 200, value: 300, valueKrw: 420_000 }),
			h({ broker: "binance", name: "AAPL", quantity: 1, avgPrice: 0, value: 151, valueKrw: 211_400, note: "bStock 토큰 AAPLB" }),
			h({ symbol: "005930", name: "삼성전자", market: "domestic", currency: "KRW", valueKrw: 80_000 }),
		]);
		assert.equal(g.length, 2);
		const aapl = g[0]!;
		assert.equal(aapl.name, "애플", "증권사 이름을 쓴다");
		assert.equal(aapl.quantity, 4);
		assert.equal(aapl.valueKrw, 841_400);
		assert.deepEqual(aapl.brokers, ["toss", "kis", "binance"]);
		// 원가 100 + 400 = 500, 평가 150 + 300 = 450 → -10%
		assert.equal(aapl.profitPct, -10);
	});

	it("평단을 하나도 모르면 손익률 null", () => {
		const [g] = groupHoldings([h({ broker: "binance", avgPrice: 0 })]);
		assert.equal(g!.profitPct, null);
	});
});

describe("날짜", () => {
	it("월 경계를 넘는다", () => {
		assert.equal(daysBefore("2026-10-01", 1), "2026-09-30");
		assert.equal(daysBefore("2026-03-01", 365), "2025-03-01");
	});
});
