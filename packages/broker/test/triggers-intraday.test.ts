/**
 * 주식 분·시간봉 감시 테스트 (PLAN §40 ②③).
 *
 * 핵심: ① 봉은 장 시작부터 자른다 (국장 09:00, 미장 09:30 — 마지막 봉은 마감에서 잘린다)
 * ② 국장 종가 단일가(15:30 봉)는 정규장 마지막 봉에 넣고, 랜덤 엔드를 기다린다 (마감 1분 뒤에 확정)
 * ③ 장 캘린더 — 수능일·미장 조기 폐장 ④ 원본 분봉은 캐시하고 새 부분만 받는다
 * ⑤ 증권사별 이어 받기 커서 (실데이터로 확인한 모양 — KIS 봉 시각 = 봉 시작, 토스 = 봉 끝)
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { validateCondition, maxBarsFor } from "../src/triggers/condition.ts";
import { barCloseAt, lastClosedStart, nextCloseAt, sessionOf, settledAt, stockBucket, zoned } from "../src/triggers/market-time.ts";
import { bucketStock, clearIntradayCache, collectMinutes, fetchStockIntraday, type MinuteSource } from "../src/triggers/stock-intraday.ts";
import { chooseFeed, createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";
import type { Condition, TriggerSpec, WatchBar } from "../src/triggers/types.ts";

const MIN = 60_000;
const kst = (s: string) => Date.parse(`${s}+09:00`);
const ny = (ymd: string, hm: string) => zoned(ymd, hm, "America/New_York");
const krx = (interval: Condition["interval"], over: Partial<Condition> = {}) =>
	({ market: { venue: "krx" as const, symbol: "005930", feed: { provider: "kis" as const, basis: "krx" as const } }, interval, ...over }) as Condition;
const us = (interval: Condition["interval"], session?: "extended") => ({ market: { venue: "us" as const, symbol: "AAPL" }, interval, ...(session ? { session } : {}) }) as Condition;
const cond = (c: Partial<Condition>): Condition => ({
	market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "krx" } },
	interval: "5m",
	when: "bar_close",
	all: [{ left: "close", op: ">", right: 0 }],
	confirmBars: 1,
	fire: "on_enter",
	...c,
});

describe("장 기준 분·시간봉 시계", () => {
	it("국장 5분봉: 09:00 부터 자르고, 장 전에는 전 거래일 마지막 봉", () => {
		assert.equal(lastClosedStart(krx("5m"), kst("2026-09-23T10:07:30")), kst("2026-09-23T10:00:00"));
		assert.equal(barCloseAt(krx("5m"), kst("2026-09-23T10:00:00")), kst("2026-09-23T10:05:00"));
		assert.equal(lastClosedStart(krx("5m"), kst("2026-09-23T08:30:00")), kst("2026-09-22T15:25:00"));
		assert.equal(lastClosedStart(krx("5m"), kst("2026-09-28T08:59:00")), kst("2026-09-25T15:25:00")); // 월요일 장 전 → 금요일
		assert.equal(nextCloseAt(krx("5m"), kst("2026-09-23T10:07:00")), kst("2026-09-23T10:10:00"));
		assert.equal(nextCloseAt(krx("5m"), kst("2026-09-25T16:00:00")), kst("2026-09-28T09:05:00"));
	});

	it("국장 마지막 봉은 종가 단일가를 기다린다 — 마감 1분 뒤에 확정", () => {
		// 5분봉 15:25–15:30 (15:20 부터 동시호가라 체결은 15:30 단일가뿐)
		assert.equal(lastClosedStart(krx("5m"), kst("2026-09-23T15:30:30")), kst("2026-09-23T15:20:00"));
		assert.equal(lastClosedStart(krx("5m"), kst("2026-09-23T15:31:00")), kst("2026-09-23T15:25:00"));
		// 1시간봉 15:00–15:30 (마감에서 잘린 봉)
		const h = krx("1h");
		assert.equal(barCloseAt(h, kst("2026-09-23T15:00:00")), kst("2026-09-23T15:30:00"));
		assert.equal(settledAt(h, kst("2026-09-23T15:00:00")), kst("2026-09-23T15:31:00"));
		assert.equal(settledAt(h, kst("2026-09-23T14:00:00")), kst("2026-09-23T15:00:00"));
		assert.equal(lastClosedStart(h, kst("2026-09-23T15:30:59")), kst("2026-09-23T14:00:00"));
		assert.equal(lastClosedStart(h, kst("2026-09-23T15:31:00")), kst("2026-09-23T15:00:00"));
	});

	it("미장 1시간봉: 정규장은 09:30 기준(마지막 15:30–16:00), 확장은 04:00 기준", () => {
		assert.equal(lastClosedStart(us("1h"), ny("2026-09-25", "15:59")), ny("2026-09-25", "14:30"));
		assert.equal(lastClosedStart(us("1h"), ny("2026-09-25", "16:00")), ny("2026-09-25", "15:30"));
		assert.equal(barCloseAt(us("1h"), ny("2026-09-25", "15:30")), ny("2026-09-25", "16:00"));
		assert.equal(lastClosedStart(us("1h", "extended"), ny("2026-09-25", "09:45")), ny("2026-09-25", "08:00"));
		assert.equal(lastClosedStart(us("1h", "extended"), ny("2026-09-25", "20:00")), ny("2026-09-25", "19:00"));
		assert.equal(settledAt(us("1h"), ny("2026-09-25", "15:30")), ny("2026-09-25", "16:00")); // 미장은 기다리지 않는다
	});

	it("장 캘린더 — 수능일 국장 10:00–16:30, 미장 조기 폐장 13:00 (일봉·주봉도)", () => {
		const h = krx("1h");
		assert.deepEqual(sessionOf(h, "2026-11-19"), { open: kst("2026-11-19T10:00:00"), close: kst("2026-11-19T16:30:00") });
		assert.equal(lastClosedStart(h, kst("2026-11-19T15:31:00")), kst("2026-11-19T14:00:00")); // 15:00–16:00 은 아직
		assert.equal(lastClosedStart(h, kst("2026-11-19T16:31:00")), kst("2026-11-19T16:00:00"));
		assert.equal(barCloseAt(krx("1d"), kst("2026-11-19T09:00:00")), kst("2026-11-19T16:30:00"));
		assert.equal(barCloseAt(us("1d"), ny("2026-11-27", "09:30")), ny("2026-11-27", "13:00"));
		assert.equal(barCloseAt(us("1w"), ny("2026-11-23", "09:30")), ny("2026-11-27", "13:00"));
		assert.equal(lastClosedStart(us("5m"), ny("2026-11-27", "13:05")), ny("2026-11-27", "12:55"));
		assert.equal(sessionOf(us("5m", "extended"), "2026-11-27").close, ny("2026-11-27", "17:00"));
	});

	it("원본 봉 → 들어갈 봉: 종가 단일가는 마지막 봉으로, 세션 밖은 버린다", () => {
		assert.equal(stockBucket(krx("5m"), kst("2026-09-23T15:30:00")), kst("2026-09-23T15:25:00"));
		assert.equal(stockBucket(krx("1h"), kst("2026-09-23T15:30:00")), kst("2026-09-23T15:00:00"));
		assert.equal(stockBucket(krx("5m"), kst("2026-09-23T18:00:00")), null); // KIS J 가 전날로 이어 줄 때 섞이는 장 뒤 봉
		assert.equal(stockBucket(krx("5m"), kst("2026-09-23T08:59:00")), null);
		const nxt = krx("5m", { market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "integrated" } }, session: "extended" });
		assert.equal(stockBucket(nxt, kst("2026-09-23T15:30:00")), kst("2026-09-23T15:30:00")); // 확장 세션에서는 세션 안
		assert.equal(stockBucket(nxt, kst("2026-09-23T08:00:00")), kst("2026-09-23T08:00:00"));
		assert.equal(stockBucket(us("5m"), ny("2026-09-25", "16:00")), null); // 미장 16:00 봉은 종가 경매 + 애프터가 섞여 있다
		assert.equal(stockBucket(us("5m"), ny("2026-09-25", "09:29")), null);
		assert.equal(stockBucket(us("3m"), ny("2026-09-25", "09:34")), ny("2026-09-25", "09:33"));
	});

	it("묶기: 1분봉 → 1시간봉, 종가는 단일가 체결가", () => {
		const b = (t: number, close: number, volume: number): WatchBar => ({ t, open: close, high: close + 5, low: close - 5, close, volume });
		const out = bucketStock(krx("1h"), [b(kst("2026-09-23T14:59:00"), 100, 1), b(kst("2026-09-23T15:18:00"), 110, 2), b(kst("2026-09-23T15:19:00"), 108, 3), b(kst("2026-09-23T15:30:00"), 112, 50)]);
		assert.deepEqual(
			out.map((x) => [x.t, x.open, x.high, x.low, x.close, x.volume]),
			[
				[kst("2026-09-23T14:00:00"), 100, 105, 95, 100, 1],
				[kst("2026-09-23T15:00:00"), 110, 117, 103, 112, 55],
			],
		);
	});
});

describe("원본 분봉 캐시", () => {
	beforeEach(() => clearIntradayCache());
	const T = kst("2026-09-23T10:00:00");
	/** 1분마다 봉이 있는 가짜 출처 — 한 쪽 10개, head 가 최신 봉 */
	const fake = () => {
		const s = { head: T, calls: [] as Array<string | null> };
		const src: MinuteSource = {
			key: "fake",
			gap: MIN,
			async page(cursor) {
				s.calls.push(cursor);
				const end = cursor ? Number(cursor) : s.head;
				const bars = Array.from({ length: 10 }, (_, i) => end - i * MIN).map((t) => ({ t, open: 1, high: 1, low: 1, close: t, volume: 1 }));
				return { bars, next: String(end - 10 * MIN) };
			},
		};
		return { s, src };
	};

	it("처음엔 충분할 때까지, 다음엔 새 부분 한 쪽만, 더 필요하면 캐시 앞으로 이어 받는다", async () => {
		const { s, src } = fake();
		const a = await collectMinutes(src, (b) => b.length >= 25, T + 30_000);
		assert.equal(s.calls.length, 3);
		assert.equal(a.length, 30);
		s.head = T + 5 * MIN;
		const b = await collectMinutes(src, (x) => x.length >= 25, T + 5 * MIN + 30_000);
		assert.equal(s.calls.length, 4); // 겹치는 첫 쪽 하나
		assert.equal(b.length, 35);
		assert.deepEqual(b.map((x) => x.t), Array.from({ length: 35 }, (_, i) => T - 29 * MIN + i * MIN)); // 빈틈 없이
		const c = await collectMinutes(src, (x) => x.length >= 50, T + 5 * MIN + 30_000);
		assert.equal(c.length, 55);
		assert.equal(s.calls.at(-1), String(T - 40 * MIN)); // 캐시 맨 앞의 커서부터
	});

	it("진행 중인 봉은 돌려주되 캐시하지 않는다 — 다음에 다시 받는다", async () => {
		const { s, src } = fake();
		const now = T + 20_000; // head(10:00) 봉은 아직 진행 중
		const a = await collectMinutes(src, (b) => b.length >= 5, now);
		assert.equal(a.at(-1)?.t, T);
		s.head = T + MIN;
		await collectMinutes(src, (b) => b.length >= 5, T + MIN + 20_000);
		assert.equal(s.calls.length, 2);
	});
});

// ── 증권사 이어 받기 (가짜 fetch) ────────────────────────────────────────

const store = { get: async () => ({ token: "t", expiresAt: Date.now() + 1e9 }), set: async () => {}, delete: async () => {} };
const kisCtx = (env: "real" | "paper" = "real", appKey = "k-intraday") => ({ creds: { appKey, appSecret: "s", cano: "", prdtCd: "", env }, store, owner: "ms" });
const tossCtx = { creds: { clientId: "a", clientSecret: "b" }, store, owner: "ms" };

async function withFetch<T>(handler: (url: URL) => unknown, run: () => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = (async (u: string | URL) => new Response(JSON.stringify(handler(new URL(String(u)))))) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = real;
	}
}

describe("KIS 국장 분봉", () => {
	beforeEach(() => clearIntradayCache());
	/** 거래일의 KRX 1분봉 시각 — 09:00–15:19 + 15:30 단일가 */
	const minutes = (() => {
		const out: string[] = [];
		for (let m = 9 * 60; m < 15 * 60 + 20; m++) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`);
		return [...out, "153000"];
	})();
	const days = ["20260922", "20260923"];
	const calls: Array<{ market: string; date: string; hour: string }> = [];
	const handler = (u: URL) => {
		const q = (k: string) => u.searchParams.get(k) ?? "";
		calls.push({ market: q("FID_COND_MRKT_DIV_CODE"), date: q("FID_INPUT_DATE_1"), hour: q("FID_INPUT_HOUR_1") });
		// 그날 hour 이하 봉을 최신순으로 120개 (그날이 없으면 그 전 거래일 — KIS 의 과거 포함 Y)
		const date = [...days].reverse().find((d) => d <= q("FID_INPUT_DATE_1")) ?? "";
		const hour = date === q("FID_INPUT_DATE_1") ? q("FID_INPUT_HOUR_1") : "235959";
		const rows = minutes
			.filter((h) => h <= hour)
			.reverse()
			.slice(0, 120)
			.map((h) => ({ stck_bsop_date: date, stck_cntg_hour: h, stck_oprc: "100", stck_hgpr: "101", stck_lwpr: "99", stck_prpr: h === "153000" ? "105" : "100", cntg_vol: h === "153000" ? "5000" : "10" }));
		return { rt_cd: "0", msg1: "ok", output1: {}, output2: rows };
	};

	it("당일 마감 시각부터 → 그날 09:00 까지 받았으면 전 평일 15:30 부터. 종가 단일가는 마지막 봉에", async () => {
		calls.length = 0;
		const c = cond({ interval: "1h" });
		const bars = await withFetch(handler, () => fetchStockIntraday({ kis: () => kisCtx() as never }, c, 8, kst("2026-09-23T15:40:00")));
		assert.equal(bars.length, 8);
		assert.deepEqual(calls[0], { market: "J", date: "20260923", hour: "153000" });
		assert.ok(calls.some((x) => x.date === "20260922" && x.hour === "153000"));
		const last = bars.at(-1) as WatchBar;
		assert.equal(last.t, kst("2026-09-23T15:00:00"));
		assert.deepEqual([last.close, last.volume], [105, 20 * 10 + 5000]);
		assert.equal(bars[0]?.t, kst("2026-09-22T15:00:00")); // 9/22 13:00 봉은 13:21 부터만 받아 덜 찼다 — 잘라 냈다
	});

	it("장중에는 확정된 봉까지만. 통합 기준은 UN 코드 · 20:00 부터", async () => {
		calls.length = 0;
		const c = cond({ interval: "5m" });
		const mid = await withFetch(handler, () => fetchStockIntraday({ kis: () => kisCtx() as never }, c, 3, kst("2026-09-23T15:30:30")));
		assert.equal(mid.at(-1)?.t, kst("2026-09-23T15:15:00")); // 15:20 봉은 비었고 15:25 봉은 단일가를 기다린다
		calls.length = 0;
		clearIntradayCache();
		const un = cond({ interval: "5m", market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "integrated" } } });
		await withFetch(handler, () => fetchStockIntraday({ kis: () => kisCtx() as never }, un, 3, kst("2026-09-23T15:40:00")));
		assert.deepEqual(calls[0], { market: "UN", date: "20260923", hour: "200000" });
	});

	it("모의투자 키·없는 키는 다른 출처로 넘어가지 않고 오류", async () => {
		const c = cond({ interval: "5m" });
		await assert.rejects(fetchStockIntraday({ kis: () => kisCtx("paper") as never }, c, 3, kst("2026-09-23T15:40:00")), /실전 키가 필요/);
		await assert.rejects(fetchStockIntraday({ toss: () => tossCtx as never }, c, 3, kst("2026-09-23T15:40:00")), /한국투자 시세로 만들었는데 그 키가 없습니다/);
	});
});

describe("KIS 미장 · 토스 분봉", () => {
	beforeEach(() => clearIntradayCache());

	it("KIS 미장: 거래소 코드는 한 번만 찾고, KEYB = 가장 오래된 봉 1분 전 (현지 시각). 1시간봉은 30분봉을 묶는다", async () => {
		const seen: URL[] = [];
		const c: Condition = { ...cond({}), market: { venue: "us", symbol: "AAPL", feed: { provider: "kis" } }, interval: "1h" };
		// 30분봉 — 09:00 ~ 16:30 (현지), 최신순. KEYB 가 있으면 그 이하
		const all = Array.from({ length: 16 }, (_, i) => 9 * 60 + i * 30).map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`);
		const handler = (u: URL) => {
			seen.push(u);
			if (u.pathname.endsWith("/quotations/price")) return { rt_cd: "0", output: { last: u.searchParams.get("EXCD") === "NAS" ? "250" : "" } };
			const keyb = u.searchParams.get("KEYB") ?? "";
			const rows = all
				.filter((h) => !keyb || `20260925${h}` <= keyb)
				.reverse()
				.slice(0, 5)
				.map((h) => ({ xymd: "20260925", xhms: h, open: "1", high: "2", low: "1", last: h.slice(0, 4), evol: "10" }));
			return { rt_cd: "0", output1: {}, output2: rows };
		};
		const bars = await withFetch(handler, () => fetchStockIntraday({ kis: () => kisCtx("real", "k-us") as never }, c, 7, ny("2026-09-25", "16:10")));
		const charts = seen.filter((u) => u.pathname.endsWith("inquire-time-itemchartprice"));
		assert.equal(charts[0]?.searchParams.get("NMIN"), "30");
		assert.equal(charts[1]?.searchParams.get("KEYB"), "20260925142900"); // 첫 쪽 16:30~14:30 → 14:29 부터
		// 09:00 봉(프리)·16:00 이후(애프터)는 빼고, 09:30 부터 1시간씩 — 마지막 15:30 봉은 30분짜리
		assert.deepEqual(
			bars.map((b) => [b.t, b.close, b.volume]),
			[
				[ny("2026-09-25", "09:30"), 1000, 20],
				[ny("2026-09-25", "10:30"), 1100, 20],
				[ny("2026-09-25", "11:30"), 1200, 20],
				[ny("2026-09-25", "12:30"), 1300, 20],
				[ny("2026-09-25", "13:30"), 1400, 20],
				[ny("2026-09-25", "14:30"), 1500, 20],
				[ny("2026-09-25", "15:30"), 1530, 10],
			],
		);
		await withFetch(handler, () => fetchStockIntraday({ kis: () => kisCtx("real", "k-us") as never }, c, 3, ny("2026-09-25", "16:20")));
		assert.equal(seen.filter((u) => u.pathname.endsWith("/quotations/price")).length, 1); // NAS 에서 찾았다 — 다시 찾지 않는다
	});

	it("토스: 1분봉 timestamp 는 봉 끝 — 1분 당겨 봉 시작으로", async () => {
		const c: Condition = { ...cond({}), market: { venue: "krx", symbol: "005930", feed: { provider: "toss", basis: "integrated" } }, interval: "5m" };
		const candles = Array.from({ length: 10 }, (_, i) => kst("2026-09-23T10:10:00") - i * MIN).map((t) => ({
			timestamp: new Date(t).toISOString(), openPrice: "1", highPrice: "1", lowPrice: "1", closePrice: String(t % 1e7), volume: "1", currency: "KRW",
		}));
		const bars = await withFetch(() => ({ result: { candles, nextBefore: null } }), () => fetchStockIntraday({ toss: () => tossCtx as never }, c, 5, kst("2026-09-23T10:11:00")));
		// 봉 끝 10:01~10:10 → 봉 시작 10:00~10:09 → 5분봉 10:00, 10:05 (둘 다 닫힘)
		assert.deepEqual(bars.map((b) => [b.t, b.volume]), [[kst("2026-09-23T10:00:00"), 5], [kst("2026-09-23T10:05:00"), 5]]);
	});
});

describe("검증 · 툴", () => {
	it("주식 3분봉~4시간봉, 국장 확장 세션은 통합 기준만, 예열 상한은 최근 15거래일", () => {
		assert.deepEqual(validateCondition(cond({ interval: "3m" })), []);
		assert.deepEqual(validateCondition(cond({ interval: "4h", market: { venue: "us", symbol: "AAPL", feed: { provider: "kis" } }, session: "extended" })), []);
		assert.deepEqual(validateCondition(cond({ interval: "3m", market: { venue: "binance", symbol: "ETHUSDT" } })), []);
		assert.ok(validateCondition(cond({ session: "extended" })).some((e) => /통합 기준\(basis: integrated\)에서만/.test(e)));
		assert.deepEqual(validateCondition(cond({ session: "extended", market: { venue: "krx", symbol: "005930", feed: { provider: "toss", basis: "integrated" } } })), []);
		assert.equal(maxBarsFor(cond({ interval: "5m" })), 78 * 15);
		assert.equal(maxBarsFor(cond({ interval: "5m", market: { venue: "us", symbol: "AAPL" }, session: "extended" })), 192 * 15);
		const rvol = (length: number) => cond({ interval: "5m", all: [{ left: { ind: "rvol", length }, op: ">=", right: 2 }] });
		assert.deepEqual(validateCondition(rvol(10)), []);
		assert.ok(validateCondition(rvol(20)).some((e) => /예열/.test(e)));
	});

	it("국장 확장 세션을 준비하면 통합 기준으로 — 미리보기는 5거래일", async () => {
		const prepared: TriggerSpec[] = [];
		const asked: number[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "tok", expiresAt: 99 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("no");
			},
			channels: () => ["telegram"],
			fetchBars: async (_c, limit) => (asked.push(limit), []),
			feeds: () => ({ kis: true, toss: false }),
			now: () => kst("2026-09-23T12:00:00"),
		});
		const r = (await tool!.execute("id", { action: "prepare", symbol: "005930", interval: "5m", session: "extended", all: [{ left: "close", op: ">", right: 1 }] } as never, undefined, undefined, {} as never)) as {
			details: WatchConfirmCard;
		};
		assert.deepEqual(prepared[0]?.condition.market.feed, { provider: "kis", basis: "integrated" });
		assert.match(r.details.feed ?? "", /통합/);
		assert.equal(asked[0], 144 * 5 + 1); // 08:00–20:00 5분봉 144개 × 5일 + 예열 1
		assert.deepEqual(chooseFeed("krx", { kis: true, toss: true }), { provider: "kis", basis: "krx" }); // 정규장 기본은 그대로
	});
});
