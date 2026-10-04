/**
 * 스냅샷 시점 판단 테스트.
 *
 * 컨테이너는 UTC 로 돈다. KST 16시 = UTC 07시이고, KST 자정 전후로 UTC 날짜가
 * 하루 어긋난다 — 이 경계가 틀리면 "오늘 찍었는데 또 찍거나", "평일인데 주말로 보고
 * 건너뛰는" 일이 조용히 생긴다. 과거 스냅샷은 되살릴 수 없으니 빠진 날은 영구 결손이다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PortfolioSummary } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { inWindow, kstParts, shouldSnapshot, snapshotProblem, SnapshotStore, toSnapshot } from "../src/snapshots.ts";

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

/** 토스 삼성전자 10주 + Binance BTC — 스냅샷 변환·저장 공용 */
function summary(over: Partial<PortfolioSummary> = {}): PortfolioSummary {
	return {
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
		cashUsd: 0,
		profitKrw: 275_000,
		usdKrw: 1_380,
		fxSource: "토스",
		warnings: [],
		crypto: [
			{
				source: "binance",
				asset: "BTC",
				quantity: 0.01,
				wallets: [{ wallet: "SPOT", quantity: 0.01 }],
				priceUsd: 100_000,
				valueUsd: 1000,
				valueKrw: 1_380_000,
				stable: false,
				avgPriceUsd: null,
				costCoverage: null,
				profitUsd: null,
				profitPct: null,
			},
		],
		manual: [],
		cryptoValueKrw: 1_380_000,
		netWorthKrw: 4_255_000,
		allocation: { domesticStock: 2_775_000, overseasStock: 0, crypto: 1_380_000, cash: 100_000, other: 0 },
		sources: [
			{ id: "toss", label: "토스", status: "ok", valueKrw: 2_875_000, stockKrw: 2_775_000, cashKrw: 100_000, cryptoKrw: 0, otherKrw: 0, warnings: [] },
			{ id: "binance", label: "Binance", status: "partial", valueKrw: 1_380_000, stockKrw: 0, cashKrw: 0, cryptoKrw: 1_380_000, otherKrw: 0, warnings: ["x"] },
		],
		...over,
	};
}

describe("스냅샷 변환", () => {
	it("총액 = 주식 평가 + 예수금 (뜻 그대로), 총자산·계좌별 합계는 따로", () => {
		const s = toSnapshot("ms", "2026-09-23", summary());
		assert.equal(s.totalKrw, 2_875_000);
		assert.equal(s.netKrw, 4_255_000);
		assert.equal(s.cryptoKrw, 1_380_000);
		assert.deepEqual(s.sources, [
			{ id: "toss", status: "ok", valueKrw: 2_875_000 },
			{ id: "binance", status: "partial", valueKrw: 1_380_000 },
		]);
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

	it("환율이 없는데 달러·코인 자산이 있으면 저장하지 않는다 (그날 총자산이 꺼져 보인다)", () => {
		assert.equal(snapshotProblem(summary()), null);
		assert.match(snapshotProblem(summary({ usdKrw: 0 })) ?? "", /환율/);
		assert.equal(snapshotProblem(summary({ usdKrw: 0, crypto: [] })), null, "원화 자산뿐이면 환율이 없어도 된다");
		const usdManual = { id: "m1", name: "미국 계좌", kind: "investment" as const, currency: "USD" as const, amount: 10, memo: null, updatedAt: "x", valueKrw: 0 };
		assert.match(snapshotProblem(summary({ usdKrw: 0, crypto: [], manual: [usdManual] })) ?? "", /환율/, "달러 직접 입력도 환율이 필요하다");
	});
});

describe("스냅샷 저장소 (0011 총자산 열)", () => {
	let d1: FakeD1;
	beforeEach(() => {
		d1 = installFakeD1();
	});
	afterEach(() => d1.restore());

	it("총자산·계좌별 합계를 저장하고 summary 조회는 보유 종목을 읽지 않는다", async () => {
		const store = new SnapshotStore(() => d1.cfg);
		await store.save(toSnapshot("ms", "2026-10-05", summary()));
		const [full] = await store.range("ms", "2026-10-01", "2026-10-31");
		assert.equal(full?.netKrw, 4_255_000);
		assert.equal(full?.sources?.length, 2);
		assert.equal(full?.holdings.length, 1);
		const [slim] = await store.range("ms", "2026-10-01", "2026-10-31", { summary: true });
		assert.equal(slim?.netKrw, 4_255_000);
		assert.deepEqual(slim?.holdings, []);
	});

	it("0011 이전 행은 총자산이 null — 차트가 구분한다", async () => {
		const store = new SnapshotStore(() => d1.cfg);
		await store.lastDate("ms"); // 마이그레이션
		d1.db.exec(
			"INSERT INTO portfolio_snapshots (member, date, total_krw, stock_krw, cash_krw, profit_krw, usd_krw, brokers, holdings_json, created_at) " +
				"VALUES ('ms', '2026-09-24', 100, 90, 10, 0, 1380, 'toss', '[]', 'x')",
		);
		const [old] = await store.range("ms", "2026-09-01", "2026-09-30", { summary: true });
		assert.equal(old?.netKrw, null);
		assert.equal(old?.sources, null);
		assert.equal(old?.totalKrw, 100);
	});
});
