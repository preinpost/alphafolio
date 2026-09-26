/**
 * 감시 조건 평가 테스트 (PLAN §40).
 *
 * 핵심: ① 봉 마감가로만 본다 — 꼬리(저가)가 기준선을 찔러도 마감이 위면 울리지 않는다 (피뢰침)
 * ② on_enter — 조건이 유지되는 동안 매 봉 울리지 않고, 거짓 → 참일 때만 ③ N봉 연속 ④ 진행 중인 봉은 평가하지 않는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate, fetchBinanceBars } from "../src/triggers/bars.ts";
import { barCloseAt, cryptoBarStart, lastClosedStart, localDate, nextCloseAt, zoned } from "../src/triggers/market-time.ts";
import { dailyToWatch, fetchStockBars, fetchStockDaily, weeklyFromDaily } from "../src/triggers/stock-bars.ts";
import { evaluate, fireIndices, holdsNow, seriesOf, validateCondition, valuesAt, warmupFor } from "../src/triggers/condition.ts";
import { conditionText, subject } from "../src/triggers/describe.ts";
import type { Condition, TriggerSpec, WatchBar } from "../src/triggers/types.ts";
import { chooseFeed, createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-09-26T00:00:00Z");

/** 종가 배열 → 1시간봉. low 를 따로 주면 꼬리 */
function bars(closes: number[], lows?: number[]): WatchBar[] {
	return closes.map((c, i) => ({ t: T0 + i * H, open: c, high: c + 1, low: lows?.[i] ?? c - 1, close: c, volume: 100 }));
}

function cond(over: Partial<Condition> = {}): Condition {
	return {
		market: { venue: "binance", symbol: "ETHUSDT" },
		interval: "1h",
		when: "bar_close",
		all: [{ left: "close", op: "<", right: 2600 }],
		confirmBars: 1,
		fire: "on_enter",
		...over,
	};
}

describe("조건 평가", () => {
	it("피뢰침: 저가가 2,600 을 뚫어도 종가가 위면 울리지 않는다", () => {
		const b = bars([2700, 2680, 2650, 2640], [2690, 2550, 2500, 2630]);
		assert.deepEqual(fireIndices(cond(), b), []);
		// 저가 기준으로 걸었다면 울렸을 것 — 사용자가 명시적으로 low 를 고를 때만
		assert.deepEqual(fireIndices(cond({ all: [{ left: "low", op: "<", right: 2600 }] }), b), [1]);
	});

	it("on_enter: 참이 유지되는 동안은 한 번, 거짓이 됐다가 다시 참이면 또", () => {
		const b = bars([2700, 2590, 2580, 2570, 2650, 2590]);
		assert.deepEqual(fireIndices(cond(), b), [1, 5]);
	});

	it("N봉 연속: 두 봉 연속 마감해야 발동, 한 봉만 찍고 돌아오면 무시", () => {
		const b = bars([2700, 2590, 2650, 2590, 2580, 2570]);
		assert.deepEqual(fireIndices(cond({ confirmBars: 2 }), b), [4]);
	});

	it("AND: 모두 충족할 때만. 데이터가 모자란 구간은 판정하지 않는다 (null)", () => {
		const closes = [...Array.from({ length: 30 }, (_, i) => 3000 - i * 10)]; // 계속 하락 → RSI 낮음
		const b = bars(closes);
		const c = cond({ all: [{ left: "close", op: "<", right: 2800 }, { left: "rsi14", op: "<", right: 30 }] });
		const hits = evaluate(c, b);
		assert.equal(hits[5], false); // 종가 조건이 확실히 거짓 — RSI 를 몰라도 AND 는 거짓
		assert.equal(evaluate(cond({ all: [{ left: "rsi14", op: "<", right: 30 }] }), b)[5], null); // RSI 가 아직 없다
		assert.equal(fireIndices(c, b)[0], 21); // 2,790 이 되는 첫 봉 (RSI 는 이미 0)
		assert.equal(holdsNow(c, b), true);
	});

	it("교차: 직전 봉과 비교해 넘어선 봉에서만", () => {
		const b = bars([10, 10, 10, 10, 10, 20, 20, 20]);
		const c = cond({ all: [{ left: "close", op: "crosses_above", right: "ma5" }] });
		assert.deepEqual(fireIndices(c, b), [5]);
		assert.deepEqual(fireIndices(cond({ all: [{ left: "close", op: "crosses_below", right: 15 }] }), bars([20, 16, 14, 13, 16, 14])), [2, 5]);
	});

	it("거래량 배수는 직전 20봉 평균과 비교한다 (자기 자신을 평균에 넣지 않는다)", () => {
		const b = bars(Array(22).fill(100));
		b[21]!.volume = 300;
		const v = seriesOf(b, "vol_ratio20");
		assert.equal(v[19], null);
		assert.equal(v[20], 1);
		assert.equal(v[21], 3);
	});

	it("평가 값 기록 — 조건에 쓴 값 + 종가", () => {
		const b = bars([2700, 2590]);
		assert.deepEqual(valuesAt(cond(), b, 1), { close: 2590 });
	});
});

describe("검증 · 표시", () => {
	it("형식 오류를 사람이 고칠 수 있는 문장으로", () => {
		assert.deepEqual(validateCondition(cond()), []);
		const errs = validateCondition(
			cond({ market: { venue: "binance", symbol: "eth" }, interval: "3h" as never, confirmBars: 0, all: [{ left: "price" as never, op: "==" as never, right: "close" }] }),
		);
		assert.ok(errs.some((e) => /종목 형식/.test(e)));
		assert.ok(errs.some((e) => /봉 간격/.test(e)));
		assert.ok(errs.some((e) => /연속 봉 수/.test(e)));
		assert.ok(errs.some((e) => /모르는 값 price/.test(e)));
		assert.ok(errs.some((e) => /모르는 비교 ==/.test(e)));
		assert.ok(validateCondition(cond({ all: [] })).some((e) => /하나 이상/.test(e)));
		assert.ok(validateCondition(cond({ all: [{ left: "close", op: "<", right: "close" }] })).some((e) => /같은 값끼리/.test(e)));
	});

	it("조사: 받침에 맞춘 이/가", () => {
		assert.equal(subject("종가"), "종가가");
		assert.equal(subject("20봉 이평"), "20봉 이평이");
		assert.equal(subject("RSI(14)"), "RSI(14)이(가)");
	});

	it("한 줄 설명", () => {
		const c = cond({ all: [{ left: "close", op: "<", right: 2600 }, { left: "rsi14", op: "<", right: 30 }], confirmBars: 2 });
		assert.equal(conditionText(c), "ETHUSDT · 1시간봉 마감 · 종가 < 2,600 그리고 RSI(14) < 30 · 2봉 연속");
		assert.equal(conditionText(cond({ all: [{ left: "close", op: "crosses_above", right: "ma20" }] })), "ETHUSDT · 1시간봉 마감 · 종가가 20봉 이평 상향 돌파");
	});
});

describe("Binance 봉", () => {
	it("진행 중인 마지막 봉은 뺀다, 문자열 가격을 숫자로", async () => {
		const now = T0 + 3 * H + 10 * 60_000; // 3번째 봉 진행 중
		const raw = [0, 1, 2, 3].map((i) => [T0 + i * H, "1.5", "2", "1", `${10 + i}`, "5", T0 + (i + 1) * H - 1]);
		let url = "";
		const b = await fetchBinanceBars("ETHUSDT", "1h", 100, { now, fetch: async (u) => ((url = u), new Response(JSON.stringify(raw))) });
		assert.match(url, /\/api\/v3\/klines\?symbol=ETHUSDT&interval=1h&limit=101$/); // 진행 중 봉을 빼므로 하나 더
		assert.deepEqual(b.map((x) => x.close), [10, 11, 12]);
		assert.equal(lastClosedStart({ market: { venue: "binance", symbol: "X" }, interval: "1h" }, now), T0 + 2 * H);
	});

	it("없는 종목은 알아볼 수 있는 오류", async () => {
		const f = async () => new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
		await assert.rejects(fetchBinanceBars("NOPEUSDT", "1h", 10, { fetch: f }), /없는 종목입니다: NOPEUSDT/);
	});
});

describe("watch_alert 툴", () => {
	const now = T0 + 200 * H + 60_000;
	/** 200봉 — 100·150번째 봉에서 2,600 아래로 */
	const series = Array.from({ length: 200 }, (_, i) => (i === 120 || i === 170 ? 2590 : 2700));
	const fakeFetch = async (_c: Condition, limit: number) => bars(series).slice(-limit);
	const setup = (channels: string[] = ["telegram"]) => {
		const prepared: TriggerSpec[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "tok", expiresAt: 99 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("no");
			},
			channels: () => channels,
			fetchBars: fakeFetch,
			now: () => now,
		});
		const ctx = { sessionManager: { getSessionId: () => "conv-9" } };
		const run = async (p: Record<string, unknown>) =>
			(await tool!.execute("id", p as never, undefined, undefined, ctx as never)) as { content: Array<{ text: string }>; details: WatchConfirmCard };
		return { run, prepared };
	};

	it("준비: 조건·미리보기·대화 id 를 서명 대상으로, 아직 켜지 않았다고 말한다", async () => {
		const { run, prepared } = setup();
		const r = await run({ action: "prepare", name: "ETH 이탈", symbol: "eth/usdt", interval: "1h", all: [{ left: "close", op: "<", right: 2600 }] });
		assert.equal(prepared[0]?.condition.market.symbol, "ETHUSDT");
		assert.equal(prepared[0]?.conversationId, "conv-9");
		assert.equal(prepared[0]?.limits.expiresAt, new Date(now + 30 * 86_400_000).toISOString());
		assert.equal(r.details.kind, "watch-confirm-card");
		assert.equal(r.details.preview.count, 2); // 120·170 (예열 80봉 뒤)
		assert.equal(r.details.preview.recent[0]?.at, T0 + 121 * H); // 봉 마감 시각
		assert.equal(r.details.holdsNow, false);
		assert.deepEqual(r.details.warnings, []);
		assert.match(r.content[0]!.text, /아직 켜지지 않았다/);
	});

	it("지금 이미 참이면·채널이 없으면 경고", async () => {
		const { run } = setup([]);
		const r = await run({ action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [{ left: "close", op: ">", right: 2000 }] });
		assert.equal(r.details.holdsNow, true);
		assert.ok(r.details.warnings.some((w) => /이미 조건이 참/.test(w)));
		assert.ok(r.details.warnings.some((w) => /앱 화면에서만/.test(w)));
	});

	it("봉 간격이 없거나 형식이 틀리면 카드를 만들지 않는다", async () => {
		const { run, prepared } = setup();
		await assert.rejects(run({ action: "prepare", symbol: "ETHUSDT", all: [{ left: "close", op: "<", right: 1 }] }), /봉 간격/);
		await assert.rejects(run({ action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [] }), /하나 이상/);
		await assert.rejects(run({ action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [{ left: "close", op: "<", right: 1 }], expiresDays: 365 }), /만료는 1~90일/);
		assert.equal(prepared.length, 0);
	});
});

describe("시장 시계", () => {
	const krx = { market: { venue: "krx" as const, symbol: "005930" }, interval: "1d" as const };
	const usd = { market: { venue: "us" as const, symbol: "AAPL" }, interval: "1d" as const };
	const kst = (s: string) => Date.parse(`${s}+09:00`);

	it("국장 일봉: 15:30 마감 전에는 어제 봉, 주말에는 금요일 봉", () => {
		// 2026-09-25 (금)
		assert.equal(lastClosedStart(krx, kst("2026-09-25T15:29:00")), kst("2026-09-24T09:00:00"));
		assert.equal(lastClosedStart(krx, kst("2026-09-25T15:31:00")), kst("2026-09-25T09:00:00"));
		assert.equal(lastClosedStart(krx, kst("2026-09-27T12:00:00")), kst("2026-09-25T09:00:00")); // 일요일
		assert.equal(barCloseAt(krx, kst("2026-09-25T09:00:00")), kst("2026-09-25T15:30:00"));
		assert.equal(nextCloseAt(krx, kst("2026-09-25T16:00:00")), kst("2026-09-28T15:30:00")); // 금 장 뒤 → 월
	});

	it("미장 일봉: 뉴욕 16:00 — 서머타임이면 KST 05:00, 끝나면 06:00", () => {
		assert.equal(barCloseAt(usd, zoned("2026-09-25", "09:30", "America/New_York")), kst("2026-09-26T05:00:00")); // EDT
		assert.equal(barCloseAt(usd, zoned("2026-12-04", "09:30", "America/New_York")), kst("2026-12-05T06:00:00")); // EST
		// 한국 토요일 오전 5시 반 = 뉴욕 금요일 장 끝난 뒤 → 금요일 봉이 닫혔다
		assert.equal(lastClosedStart(usd, kst("2026-09-26T05:30:00")), zoned("2026-09-25", "09:30", "America/New_York"));
		assert.equal(localDate(kst("2026-09-26T05:30:00"), "America/New_York").ymd, "2026-09-25");
		// 서머타임 시작일(3/8) 새벽 3:30 은 이미 EDT(−4) — 전환 전 오프셋으로 한 번만 계산하면 1시간 어긋난다
		assert.equal(zoned("2026-03-08", "03:30", "America/New_York"), Date.parse("2026-03-08T07:30:00Z"));
		assert.equal(zoned("2026-03-07", "03:30", "America/New_York"), Date.parse("2026-03-07T08:30:00Z"));
	});

	it("주봉: 금요일 마감에 닫힌다. 코인 주봉은 월요일 00:00 UTC 시작", () => {
		const wk = { ...krx, interval: "1w" as const };
		assert.equal(lastClosedStart(wk, kst("2026-09-25T15:00:00")), kst("2026-09-14T09:00:00")); // 이번 주 아직
		assert.equal(lastClosedStart(wk, kst("2026-09-25T15:31:00")), kst("2026-09-21T09:00:00"));
		const monday = Date.parse("2026-09-21T00:00:00Z");
		assert.equal(cryptoBarStart(Date.parse("2026-09-24T13:00:00Z"), "1w"), monday);
		assert.equal(new Date(cryptoBarStart(Date.parse("2026-09-24T13:00:00Z"), "1w")).getUTCDay(), 1);
	});
});

describe("주식 봉", () => {
	const d = (date: string, close: number, volume: number) => ({ date, open: close, high: close + 1, low: close - 1, close, volume });

	it("일봉 → 주봉 (월~금, 월요일이 휴장이어도 같은 주)", () => {
		const daily = [d("20260915", 10, 1), d("20260918", 12, 2), d("20260922", 20, 3), d("20260925", 22, 4)];
		const w = weeklyFromDaily("krx", daily);
		assert.equal(w.length, 2);
		assert.deepEqual([w[0]!.open, w[0]!.close, w[0]!.volume], [10, 12, 3]);
		assert.equal(w[1]!.t, zoned("2026-09-21", "09:00", "Asia/Seoul")); // 21일(월) 휴장이어도 월요일 기준
		assert.equal(dailyToWatch("krx", [d("20260923", 1, 1)])[0]!.t, zoned("2026-09-23", "09:00", "Asia/Seoul"));
	});

	it("진행 중 봉은 뺀다 — 장중 오늘 일봉, 이번 주 주봉. KIS 가 없으면 토스로", async () => {
		const candles = ["2026-09-23", "2026-09-24", "2026-09-25"].map((day, i) => ({
			timestamp: `${day}T00:00:00.000+09:00`, openPrice: "1", highPrice: "2", lowPrice: "1", closePrice: String(100 + i), volume: String(10 + i), currency: "KRW",
		}));
		const toss = { creds: { clientId: "a", clientSecret: "b" }, store: { get: async () => ({ token: "t", expiresAt: Date.now() + 1e9 }), set: async () => {}, delete: async () => {} }, owner: "ms" };
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ result: { candles: [...candles].reverse(), nextBefore: null } }))) as typeof fetch;
		try {
			const c: Condition = { market: { venue: "krx", symbol: "005930" }, interval: "1d", when: "bar_close", all: [{ left: "close", op: ">", right: 1 }], confirmBars: 1, fire: "on_enter" };
			const during = await fetchStockBars({ toss: () => toss as never }, c, 10, Date.parse("2026-09-25T14:00:00+09:00"));
			assert.deepEqual(during.map((b) => b.close), [100, 101]);
			const after = await fetchStockBars({ toss: () => toss as never }, c, 10, Date.parse("2026-09-25T15:45:00+09:00"));
			assert.deepEqual(after.map((b) => b.close), [100, 101, 102]);
			const weekly = await fetchStockBars({ toss: () => toss as never }, { ...c, interval: "1w" }, 10, Date.parse("2026-09-25T14:00:00+09:00"));
			assert.equal(weekly.length, 0); // 이번 주는 금요일 마감 전
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("거래량 증가율 · 예열 · 10분봉", () => {
	it("vol_chg_pct = 직전 봉 대비 %, 직전 봉 거래량이 0 이면 판정 안 함", () => {
		const b = bars([1, 1, 1, 1]);
		[100, 150, 0, 50].forEach((v, i) => (b[i]!.volume = v));
		assert.deepEqual(seriesOf(b, "vol_chg_pct"), [null, 50, -100, null]);
		const c = cond({ all: [{ left: "vol_chg_pct", op: ">=", right: 40 }] });
		assert.deepEqual(fireIndices(c, b), [1]);
	});

	it("예열 봉 수는 조건에 쓰인 값에 맞춘다 (주식 조회량)", () => {
		assert.equal(warmupFor(cond({ all: [{ left: "vol_chg_pct", op: ">=", right: 40 }] })), 2);
		assert.equal(warmupFor(cond({ all: [{ left: "rsi14", op: ">", right: 60 }] })), 45);
		assert.equal(warmupFor(cond({ all: [{ left: "close", op: "crosses_above", right: "ma60" }], confirmBars: 2 })), 62);
	});

	it("10분봉은 5분봉 두 개를 묶는다 — 앞쪽 잘린 묶음은 버린다", async () => {
		const M5 = 5 * 60_000;
		const start = T0 + 5 * 60_000; // 00:05 부터 — 00:00 묶음은 반쪽
		const raw = Array.from({ length: 5 }, (_, i) => [start + i * M5, "1", String(10 + i), "0.5", String(i), "1", 0]);
		const now = start + 5 * M5 + 1000;
		const b = await fetchBinanceBars("ETHUSDT", "10m", 10, { now, fetch: async (u) => (assert.match(u, /interval=5m/), new Response(JSON.stringify(raw))) });
		assert.deepEqual(b.map((x) => [x.t - T0, x.high, x.close, x.volume]), [[10 * 60_000, 12, 2, 2], [20 * 60_000, 14, 4, 2]]);
		assert.equal(aggregate([], "10m").length, 0);
	});

	it("시장별 검증 — 주식 분봉은 아직, 일봉 세션 확장은 안 됨", () => {
		assert.ok(validateCondition(cond({ market: { venue: "krx", symbol: "005930" }, interval: "1h" })).some((e) => /일봉\(1d\)·주봉\(1w\)만/.test(e)));
		assert.deepEqual(validateCondition(cond({ market: { venue: "us", symbol: "BRK.B" }, interval: "1w" })), []);
		assert.ok(validateCondition(cond({ market: { venue: "us", symbol: "AAPL" }, interval: "1d", session: "extended" })).some((e) => /정규장 기준/.test(e)));
		assert.ok(validateCondition(cond({ market: { venue: "krx", symbol: "AAPL" }, interval: "1d" })).some((e) => /종목 형식/.test(e)));
	});
});

describe("주식 시세 출처 고정", () => {
	const kst = (s: string) => Date.parse(`${s}+09:00`);
	const base = (feed?: Condition["market"]["feed"]): Condition => ({
		market: { venue: "krx", symbol: "005930", ...(feed ? { feed } : {}) },
		interval: "1d",
		when: "bar_close",
		all: [{ left: "vol_chg_pct", op: ">=", right: 40 }],
		confirmBars: 1,
		fire: "on_enter",
	});

	it("기본값: 국장은 KIS 가 있으면 KRX 정규장, 없으면 토스 통합. 미장은 KIS 우선", () => {
		assert.deepEqual(chooseFeed("krx", { kis: true, toss: true }), { provider: "kis", basis: "krx" });
		assert.deepEqual(chooseFeed("krx", { kis: false, toss: true }), { provider: "toss", basis: "integrated" });
		assert.deepEqual(chooseFeed("krx", { kis: true, toss: true }, "integrated"), { provider: "kis", basis: "integrated" });
		assert.throws(() => chooseFeed("krx", { kis: false, toss: true }, "krx"), /한국투자 키가 필요/);
		assert.deepEqual(chooseFeed("us", { kis: false, toss: true }), { provider: "toss" });
		assert.throws(() => chooseFeed("us", { kis: false, toss: false }), /증권 키가 필요/);
		assert.ok(validateCondition(base({ provider: "toss", basis: "krx" })).some((e) => /토스 시세는 KRX\+NXT 통합뿐/.test(e)));
		assert.ok(validateCondition({ ...base(), market: { venue: "binance", symbol: "ETHUSDT", feed: { provider: "kis" } } }).some((e) => /코인은 시세 출처/.test(e)));
	});

	it("통합 기준 일봉은 20:00 에 닫힌다 (종가 = NXT 20시 체결가)", () => {
		const regular = base({ provider: "kis", basis: "krx" });
		const integrated = base({ provider: "kis", basis: "integrated" });
		const at = kst("2026-09-23T16:00:00");
		assert.equal(lastClosedStart(regular, at), kst("2026-09-23T09:00:00"));
		assert.equal(lastClosedStart(integrated, at), kst("2026-09-22T09:00:00")); // 아직 NXT 애프터 중
		assert.equal(barCloseAt(integrated, kst("2026-09-23T09:00:00")), kst("2026-09-23T20:00:00"));
		assert.equal(nextCloseAt(integrated, at), kst("2026-09-23T20:00:00"));
		assert.match(conditionText(integrated), /국장 005930 \(KRX\+NXT 통합\)/);
	});

	it("고정된 출처로만 — 키가 없으면 다른 출처로 넘어가지 않고 오류. KIS 통합은 UN 코드", async () => {
		const tossCtx = { creds: { clientId: "a", clientSecret: "b" }, store: { get: async () => ({ token: "t", expiresAt: Date.now() + 1e9 }), set: async () => {}, delete: async () => {} }, owner: "ms" };
		await assert.rejects(fetchStockDaily({ toss: () => tossCtx as never }, "krx", "005930", 10, { provider: "kis", basis: "krx" }), /한국투자 시세로 만들었는데 그 키가 없습니다/);

		const kisCtx = {
			creds: { appKey: "k", appSecret: "s", cano: "", prdtCd: "", env: "real" },
			store: { get: async () => ({ token: "t", expiresAt: Date.now() + 1e9 }), set: async () => {}, delete: async () => {} },
			owner: "ms",
		};
		const urls: string[] = [];
		const realFetch = globalThis.fetch;
		let n = 0;
		globalThis.fetch = (async (u: string | URL) => {
			urls.push(String(u));
			// 첫 호출에만 봉 — 이어 받기는 빈 응답으로 끝
			const rows = n++ === 0 ? [{ stck_bsop_date: "20260923", stck_oprc: "1", stck_hgpr: "2", stck_lwpr: "1", stck_clpr: "286500", acml_vol: "32046681" }] : [];
			return new Response(JSON.stringify({ rt_cd: "0", msg1: "ok", output1: {}, output2: rows }));
		}) as typeof fetch;
		try {
			const r = await fetchStockDaily({ kis: () => kisCtx as never, toss: () => tossCtx as never }, "krx", "005930", 10, { provider: "kis", basis: "integrated" });
			assert.equal(r.source, "kis");
			assert.equal(r.bars[0]?.volume, 32046681);
			assert.match(urls[0] ?? "", /FID_COND_MRKT_DIV_CODE=UN/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
