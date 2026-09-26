/**
 * 감시 조건 조합 테스트 (PLAN §40) — 매개변수 값·배수·N봉 최고/최저·변동률·rvol, any·within, 프리셋, Binance 이어 받기.
 *
 * 핵심: ① 돌파 판정은 \"직전 N봉\" (지금 봉을 최고가에 넣으면 영원히 못 넘는다) ② OR·within 의 모름(null) 처리
 * ③ rvol 은 TradingView 정의 그대로 (같은 오프셋, 누적/일반, 없으면 직전 봉) ④ 프리셋은 펼쳐서 검증을 통과한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchBinanceBars } from "../src/triggers/bars.ts";
import { evaluate, fireIndices, maxBarsFor, seriesOf, validateCondition, valuesAt, warmupFor } from "../src/triggers/condition.ts";
import { conditionText, nodeText, refText, valuesText } from "../src/triggers/describe.ts";
import { PRESETS, resolvePreset } from "../src/triggers/presets.ts";
import { createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";
import type { CondNode, Condition, TriggerSpec, WatchBar } from "../src/triggers/types.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

function bars(closes: number[], step = H, vols?: number[]): WatchBar[] {
	return closes.map((c, i) => ({ t: T0 + i * step, open: c, high: c + 1, low: c - 1, close: c, volume: vols?.[i] ?? 100 }));
}
const cond = (all: CondNode[], over: Partial<Condition> = {}): Condition => ({
	market: { venue: "binance", symbol: "ETHUSDT" },
	interval: "1h",
	when: "bar_close",
	all,
	confirmBars: 1,
	fire: "on_enter",
	...over,
});

describe("매개변수 값", () => {
	const b = bars([10, 11, 12, 13, 14, 15]);

	it("sma·배수·N봉 전 값·변동률", () => {
		assert.deepEqual(seriesOf(b, { ind: "sma", period: 3 }), [null, null, 11, 12, 13, 14]);
		assert.deepEqual(seriesOf(b, { ind: "sma", period: 3, mul: 2 }), [null, null, 22, 24, 26, 28]);
		assert.deepEqual(seriesOf(b, { ind: "value", of: "close", offset: 1 }), [null, 10, 11, 12, 13, 14]);
		assert.equal((seriesOf(b, { ind: "change_pct", period: 5 })[5] as number).toFixed(2), "50.00");
		assert.deepEqual(seriesOf(b, "ma5"), seriesOf(b, { ind: "sma", period: 5 })); // 이름 값은 매개변수 값과 같다
	});

	it("N봉 최고가는 기본으로 지금 봉을 뺀다 — 그래야 돌파가 된다", () => {
		const hi = seriesOf(b, { ind: "highest", period: 3, of: "high" });
		assert.deepEqual(hi, [null, null, null, 13, 14, 15]); // 직전 3봉 고가(close+1)
		assert.deepEqual(fireIndices(cond([{ left: "close", op: ">", right: { ind: "highest", period: 3, of: "high" } }]), bars([10, 10, 10, 20, 21, 5])), [3]);
		// offset 0 이면 지금 봉 포함 — 종가가 자기 고가를 넘을 수 없어 영원히 안 울린다
		assert.deepEqual(fireIndices(cond([{ left: "close", op: ">", right: { ind: "highest", period: 3, of: "high", offset: 0 } }]), bars([10, 10, 10, 20, 21, 5])), []);
		assert.deepEqual(seriesOf(b, { ind: "lowest", period: 2 }), [null, null, 9, 10, 11, 12]);
	});

	it("거래량 배수(N봉)·EMA·RSI(N)", () => {
		const v = bars([1, 1, 1, 1], H, [100, 100, 100, 300]);
		assert.deepEqual(seriesOf(v, { ind: "vol_ratio", period: 3 }), [null, null, null, 3]);
		assert.equal(seriesOf(b, { ind: "ema", period: 3 }).filter((x) => x !== null).length > 0, true);
		assert.deepEqual(seriesOf(b, { ind: "rsi", period: 14 }), seriesOf(b, "rsi14").map(() => null)); // 봉이 모자라면 null
	});
});

describe("rvol (같은 시각 대비 거래량)", () => {
	/** 1시간봉 3일치 — 하루 24봉. 셋째 날 01:00 봉만 거래량이 크다 */
	const day = 24;
	const vols = Array.from({ length: 3 * day }, (_, i) => (i === 2 * day + 1 ? 400 : 100));
	const b = bars(Array(3 * day).fill(1), H, vols);

	it("regular: 지난 N일 같은 시각 봉 평균 대비", () => {
		const r = seriesOf(b, { ind: "rvol", length: 2, mode: "regular" });
		assert.equal(r[day + 1], null); // 둘째 날은 지난 2일이 없다
		assert.equal(r[2 * day], 1);
		assert.equal(r[2 * day + 1], 4); // 400 ÷ 평균 100
	});

	it("cumulative: 그날 시작부터 누적 ÷ 지난 N일 같은 시각까지 누적 평균 (기본값)", () => {
		const r = seriesOf(b, { ind: "rvol", length: 2 });
		assert.equal(r[2 * day], 1); // 00:00 봉 100 ÷ 100
		assert.equal(r[2 * day + 1], 2.5); // (100+400) ÷ (100+100)
		assert.equal((r[2 * day + 23] as number).toFixed(4), (2700 / 2400).toFixed(4)); // 하루 끝: 2,700 ÷ 2,400
	});

	it("지난 날에 같은 오프셋 봉이 없으면 그 직전 봉 (TradingView 와 같다)", () => {
		// 첫째 날 01:00 봉이 빠졌다 → 00:00 봉의 누적값을 쓴다
		const gap = b.filter((_, i) => i !== 1);
		const r = seriesOf(gap, { ind: "rvol", length: 2, mode: "regular" });
		const idx = gap.findIndex((x) => x.t === T0 + (2 * day + 1) * H);
		assert.equal(r[idx], 4); // (100 + 100) / 2 = 100 → 400 ÷ 100
	});

	it("일봉 이상은 직전 N봉 평균 대비 · 예열은 (N+1)일치 봉", () => {
		const d = bars([1, 1, 1, 1], 86_400_000, [100, 100, 100, 250]);
		const c1d = { market: { venue: "binance" as const, symbol: "X" }, interval: "1d" as const };
		assert.equal(seriesOf(d, { ind: "rvol", length: 3 }, c1d)[3], 2.5);
		assert.equal(warmupFor(cond([{ left: { ind: "rvol", length: 10 }, op: ">=", right: 2 }], { interval: "5m" })), 11 * 288);
		assert.equal(warmupFor(cond([{ left: { ind: "rvol", length: 10 }, op: ">=", right: 2 }], { market: { venue: "krx", symbol: "005930" }, interval: "1d" })), 11);
	});
});

describe("묶음 (any · within)", () => {
	const b = bars([10, 20, 30, 40]);

	it("any: 하나라도 참이면 참, 다 거짓이면 거짓, 모름이 섞여 있고 참이 없으면 모름", () => {
		const c = cond([{ any: [{ left: "close", op: ">", right: 35 }, { left: "close", op: "<", right: 15 }] }]);
		assert.deepEqual(evaluate(c, b), [true, false, false, true]);
		const withNull = cond([{ any: [{ left: "close", op: ">", right: 100 }, { left: { ind: "sma", period: 3 }, op: ">", right: 0 }] }]);
		assert.deepEqual(evaluate(withNull, b), [null, null, true, true]);
	});

	it("within: 최근 N봉(지금 포함) 안에 한 번이라도 — 과매도 찍고 반등", () => {
		const c = cond([{ within: 2, cond: { left: "close", op: "<", right: 15 } }]);
		assert.deepEqual(evaluate(c, b), [null, true, false, false]);
		const seq = bars([30, 10, 12, 25, 26]); // 10 을 찍고 → 25 로 올라옴
		const rebound = cond([{ within: 3, cond: { left: "close", op: "<", right: 11 } }, { left: "close", op: ">", right: 20 }]);
		assert.deepEqual(fireIndices(rebound, seq), [3]);
	});

	it("검증: 깊이·절 수·기간·예열 한도", () => {
		const deep: CondNode = { any: [{ any: [{ any: [{ left: "close", op: ">", right: 1 }] }] }] };
		assert.ok(validateCondition(cond([deep])).some((e) => /3단계까지/.test(e)));
		const many = Array.from({ length: 11 }, () => ({ left: "close" as const, op: ">" as const, right: 1 }));
		assert.ok(validateCondition(cond(many)).some((e) => /10개까지/.test(e)));
		assert.ok(validateCondition(cond([{ left: { ind: "sma", period: 0 }, op: ">", right: 1 }])).some((e) => /period 는 1~500/.test(e)));
		assert.ok(validateCondition(cond([{ left: { ind: "nope" } as never, op: ">", right: 1 }])).some((e) => /모르는 지표 nope/.test(e)));
		assert.ok(validateCondition(cond([{ within: 99, cond: { left: "close", op: ">", right: 1 } }])).some((e) => /within 은 1~50/.test(e)));
		// 국장 일봉은 550봉까지 — 이평 500 은 되고 RSI 200(예열 601) 은 안 된다
		const krx = { market: { venue: "krx" as const, symbol: "005930" }, interval: "1d" as const };
		assert.equal(maxBarsFor(krx), 550);
		assert.deepEqual(validateCondition(cond([{ left: { ind: "sma", period: 500 }, op: ">", right: 1 }], krx)), []);
		assert.ok(validateCondition(cond([{ left: { ind: "rsi", period: 200 }, op: ">", right: 1 }], krx)).some((e) => /예열 601봉/.test(e)));
	});
});

describe("설명문", () => {
	it("매개변수 값·배수·묶음을 한국어로", () => {
		assert.equal(refText({ ind: "sma", period: 20, mul: 1.02 }), "20봉 이평 × 1.02");
		assert.equal(refText({ ind: "highest", period: 20, of: "high" }), "직전 20봉 최고가");
		assert.equal(refText({ ind: "lowest", period: 10, offset: 0 }), "최근 10봉 최저가");
		assert.equal(refText({ ind: "rvol" }), "상대 거래량(같은 시각·10일 평균 대비·누적)");
		assert.equal(refText({ ind: "value", of: "close", offset: 1 }), "직전 봉 종가");
		assert.equal(refText({ ind: "change_pct", period: 4 }), "4봉 변동률(%)");
		assert.equal(
			nodeText({ any: [{ left: "rsi14", op: "<", right: 30 }, { left: "close", op: "<", right: "bb_lower" }] }, true),
			"(RSI(14) < 30 또는 종가 < 볼린저 하단)",
		);
		assert.equal(nodeText({ within: 5, cond: { left: "rsi14", op: "<", right: 30 } }), "최근 5봉 안에 한 번이라도 [RSI(14) < 30]");
	});

	it("알림 값에도 같은 이름", () => {
		const c = cond([{ left: "close", op: ">", right: { ind: "sma", period: 2, mul: 1.5 } }]);
		const b = bars([10, 10, 20]);
		assert.equal(valuesText(c, valuesAt(c, b, 2)), "종가 20 · 2봉 이평 × 1.5 22.5");
	});
});

describe("프리셋", () => {
	it("모든 프리셋이 기본값으로 펼쳐지고 검증을 통과한다 (필수 값은 채워서)", () => {
		for (const p of PRESETS) {
			const input = Object.fromEntries(Object.entries(p.params).filter(([, s]) => s.required).map(([k]) => [k, 100]));
			const r = resolvePreset(p.id, input);
			assert.deepEqual(r.errors, [], p.id);
			const built = p.build(r.params);
			assert.deepEqual(validateCondition(cond(built.all, { confirmBars: built.confirmBars })), [], p.id);
		}
	});

	it("필수 값·범위·모르는 매개변수·단기 < 장기", () => {
		assert.match(resolvePreset("close_stop").errors[0] ?? "", /기준가\(level\) 를 정해 주세요/);
		assert.match(resolvePreset("volume_jump", { pct: 1 }).errors[0] ?? "", /5~5000/);
		assert.match(resolvePreset("golden_cross", { speed: 1 }).errors[0] ?? "", /모르는 매개변수 speed/);
		assert.match(resolvePreset("golden_cross", { fast: 60, slow: 20 }).errors[0] ?? "", /단기 이평은 장기 이평보다/);
		assert.match(resolvePreset("nope").errors[0] ?? "", /모르는 프리셋/);
	});

	it("급등·급락: 방향 0 이면 OR 로 둘 다", () => {
		const r = resolvePreset("big_move", { pct: 5 });
		const c = cond(PRESETS.find((p) => p.id === "big_move")!.build(r.params).all);
		assert.deepEqual(fireIndices(c, bars([100, 106, 106, 100])), [1, 3]);
	});

	it("툴: 프리셋을 펼쳐 서명 대상에 넣고, 카드에 프리셋 이름", async () => {
		const prepared: TriggerSpec[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "t", expiresAt: 1 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("x");
			},
			channels: () => ["telegram"],
			fetchBars: async (_c, limit) => bars(Array.from({ length: 300 }, (_, i) => 100 + (i % 7)), H).slice(-limit),
			now: () => T0 + 400 * H,
		});
		const r = (await tool!.execute("id", { action: "prepare", symbol: "ETHUSDT", interval: "1h", preset: "golden_cross", presetParams: { fast: 5 } } as never, undefined, undefined, undefined as never)) as {
			details: WatchConfirmCard;
		};
		assert.equal(r.details.preset, "골든크로스");
		assert.equal(r.details.name, "ETHUSDT 골든크로스");
		assert.deepEqual(prepared[0]?.condition.preset, { id: "golden_cross", params: { fast: 5, slow: 60 } });
		assert.deepEqual(prepared[0]?.condition.all, [{ left: { ind: "sma", period: 5 }, op: "crosses_above", right: { ind: "sma", period: 60 } }]);
		assert.match(conditionText(prepared[0]!.condition), /5봉 이평이 60봉 이평 상향 돌파/);
		await assert.rejects(
			tool!.execute("id", { action: "prepare", symbol: "ETHUSDT", interval: "1h", preset: "close_stop" } as never, undefined, undefined, undefined as never),
			/기준가\(level\) 를 정해 주세요/,
		);
	});
});

describe("Binance 이어 받기", () => {
	it("1,000개 넘게 필요하면 endTime 으로 과거로 이어 받는다", async () => {
		const M5 = 5 * 60_000;
		const total = 2500;
		const now = T0 + total * M5 + 1000;
		const urls: string[] = [];
		const all = Array.from({ length: total }, (_, i) => [T0 + i * M5, "1", "1", "1", "1", "1", 0]);
		const fetch = async (u: string) => {
			urls.push(u);
			const q = new URL(u).searchParams;
			const end = q.get("endTime") ? Number(q.get("endTime")) : Infinity;
			const rows = all.filter((k) => (k[0] as number) <= end);
			return new Response(JSON.stringify(rows.slice(-Number(q.get("limit")))));
		};
		const b = await fetchBinanceBars("ETHUSDT", "5m", 2000, { now, fetch });
		assert.equal(b.length, 2000);
		assert.equal(urls.length, 3); // 1000 + 1000 + 1
		assert.ok(b.every((x, i) => i === 0 || x.t - (b[i - 1] as WatchBar).t === M5)); // 빈틈·중복 없음
		assert.equal((b.at(-1) as WatchBar).t, T0 + (total - 1) * M5);
	});
});

describe("툴 — 주식 출처 고정", () => {
	const setup = (feeds: { kis: boolean; toss: boolean }) => {
		const prepared: TriggerSpec[] = [];
		const seen: Condition[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "t", expiresAt: 1 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("x");
			},
			channels: () => ["telegram"],
			feeds: () => feeds,
			fetchBars: async (c, limit) => (seen.push(c), bars(Array.from({ length: 150 }, (_, i) => 100 + (i % 5)), 86_400_000).slice(-limit)),
			now: () => T0 + 200 * 86_400_000,
		});
		const run = (p: Record<string, unknown>) => tool!.execute("id", { action: "prepare", symbol: "005930", interval: "1d", all: [{ left: "vol_chg_pct", op: ">=", right: 40 }], ...p } as never, undefined, undefined, undefined as never) as Promise<{ details: WatchConfirmCard }>;
		return { run, prepared, seen };
	};

	it("KIS 가 있으면 KRX 정규장으로 고정 — 미리보기도 같은 출처, 카드에 표시", async () => {
		const { run, prepared, seen } = setup({ kis: true, toss: true });
		const r = await run({});
		assert.deepEqual(prepared[0]?.condition.market.feed, { provider: "kis", basis: "krx" });
		assert.deepEqual(seen[0]?.market.feed, { provider: "kis", basis: "krx" });
		assert.equal(r.details.feed, "KRX 정규장 · 한국투자 (15:30 마감)");
	});

	it("토스만 있으면 통합, KRX 기준을 고르면 거절", async () => {
		const { run, prepared } = setup({ kis: false, toss: true });
		const r = await run({});
		assert.equal(r.details.feed, "KRX+NXT 통합 · 토스 (20:00 마감)");
		assert.deepEqual(prepared[0]?.condition.market.feed, { provider: "toss", basis: "integrated" });
		await assert.rejects(run({ basis: "krx" }), /한국투자 키가 필요/);
		await assert.rejects(run({ symbol: "AAPL", market: "us", basis: "integrated" }), /basis 는 국장만/);
	});
});
