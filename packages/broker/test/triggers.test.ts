/**
 * 감시 조건 평가 테스트 (PLAN §40).
 *
 * 핵심: ① 봉 마감가로만 본다 — 꼬리(저가)가 기준선을 찔러도 마감이 위면 울리지 않는다 (피뢰침)
 * ② on_enter — 조건이 유지되는 동안 매 봉 울리지 않고, 거짓 → 참일 때만 ③ N봉 연속 ④ 진행 중인 봉은 평가하지 않는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchBinanceBars, lastClosedBarStart } from "../src/triggers/bars.ts";
import { evaluate, fireIndices, holdsNow, seriesOf, validateCondition, valuesAt } from "../src/triggers/condition.ts";
import { conditionText, subject } from "../src/triggers/describe.ts";
import type { Condition, TriggerSpec, WatchBar } from "../src/triggers/types.ts";
import { createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";

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
		assert.equal(hits[5], null); // RSI 가 아직 없다
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
			cond({ market: { venue: "binance", symbol: "eth" }, interval: "2h" as never, confirmBars: 0, all: [{ left: "price" as never, op: "==" as never, right: "close" }] }),
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
		assert.match(url, /\/api\/v3\/klines\?symbol=ETHUSDT&interval=1h&limit=100$/);
		assert.deepEqual(b.map((x) => x.close), [10, 11, 12]);
		assert.equal(lastClosedBarStart(now, "1h"), T0 + 2 * H);
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
	const fakeFetch = (async (_s: string, _i: string, limit: number) => bars(series).slice(-limit)) as never;
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
