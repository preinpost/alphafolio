/**
 * 타점 판정 테스트.
 *
 * 개별 사례 몇 개만 고정하면 규칙이 조금만 바뀌어도 "그럴듯하게 틀린" 판정이 샌다.
 * 그래서 합성 시계열 수백 개를 돌려 **어떤 경우에도 깨지면 안 되는 불변식**을 먼저 검사하고,
 * 그다음 대표 사례를 고정한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "../src/indicators.ts";
import { isOnTick, tickSize, type Market } from "../src/orders.ts";
import { evaluateTiming, SHORT_TIME_STOP_DAYS, type Horizon, type TimingResult } from "../src/timing.ts";

function barsOf(closes: number[]): Bar[] {
	return closes.map((c, i) => ({
		date: String(20260101 + i),
		open: c,
		high: c * 1.01,
		low: c * 0.99,
		close: c,
	}));
}

/** 하락 → 반등 → (선택) 횡보 조합으로 다양한 국면을 만든다 */
function* scenarios(): Generator<{ label: string; closes: number[] }> {
	for (const downLen of [20, 40, 60]) {
		for (const rally of [3, 5, 8, 12, 18, 25]) {
			for (const slope of [0.3, 0.8, 1.5, 3]) {
				const down = Array.from({ length: downLen }, (_, i) => 20_000 - i * 50);
				const bottom = down[down.length - 1] as number;
				const up = Array.from({ length: rally }, (_, i) => bottom + (i + 1) * slope * 50);
				// 약간의 흔들림 — 완전 직선이면 RSI 가 0/100 에 붙는다
				const closes = [...down, ...up].map((c, i) => Math.round(c + ((i * 37) % 7) * 10));
				yield { label: `down${downLen}/rally${rally}/slope${slope}`, closes };
			}
		}
	}
}

function all(market: Market = "KR", horizon?: Horizon): Array<{ label: string; r: TimingResult; held: boolean }> {
	const out: Array<{ label: string; r: TimingResult; held: boolean }> = [];
	for (const s of scenarios()) {
		for (const held of [false, true]) {
			const r = evaluateTiming({
				bars: barsOf(s.closes),
				market,
				holding: held ? { quantity: 10, avgPrice: s.closes[0] as number } : null,
				totalAssetsKrw: 100_000_000,
				...(horizon ? { horizon } : {}),
			});
			if (r) out.push({ label: `${s.label}/${held ? "보유" : "미보유"}`, r, held });
		}
	}
	return out;
}

describe("불변식 (합성 시계열 전수)", () => {
	const results = all();

	it("충분히 많은 국면을 돌렸고, 세 판정이 모두 나온다", () => {
		assert.ok(results.length >= 100);
		const verdicts = new Set(results.map((x) => x.r.verdict));
		assert.ok(verdicts.has("매수"), "매수 판정이 한 번도 안 나오면 규칙이 너무 빡빡하다");
		assert.ok(verdicts.has("관망"));
		assert.ok(verdicts.has("매도"), "보유 + 과열 국면에서 매도가 나와야 한다");
	});

	it("매수 판정이면 추세 우호 · 하락 신호 없음 · 밸류 비우호 아님", () => {
		for (const { label, r } of results.filter((x) => x.r.verdict === "매수")) {
			const layer = (n: string) => r.layers.find((l) => l.name === n);
			assert.equal(layer("추세")?.state, "우호", label);
			assert.ok(!layer("모멘텀")?.reasons.some((x) => x.startsWith("▼")), `${label}: 하락 신호가 있는데 매수`);
			assert.notEqual(layer("밸류")?.state, "비우호", label);
			// 손익비 1 미만이면 "지금 진입"은 나쁜 진입이다 (실측에서 발견)
			if (r.riskReward !== null) assert.ok(r.riskReward >= 1, `${label}: 손익비 1:${r.riskReward} 인데 매수`);
		}
	});

	it("보유 중 관망이면 '진입 신호' 가 아니라 보유 관점으로 말한다", () => {
		for (const { label, r, held } of results) {
			if (held && r.verdict === "관망") {
				assert.doesNotMatch(r.summary, /진입 신호\(|신규 진입/, `${label}: 보유자에게 진입 기준 — ${r.summary}`);
			}
		}
	});

	it("매도 판정은 보유 중일 때만 나온다", () => {
		for (const { label, r, held } of results) {
			if (r.verdict === "매도") assert.ok(held, `${label}: 미보유인데 매도`);
		}
	});

	it("손절가는 현재가보다 낮고 호가단위에 맞는다", () => {
		for (const { label, r } of results) {
			if (r.stopLoss === null) continue;
			assert.ok(r.stopLoss < r.price, `${label}: 손절 ${r.stopLoss} ≥ 현재가 ${r.price}`);
			assert.ok(isOnTick("KR", r.stopLoss), `${label}: 손절가 ${r.stopLoss} 가 호가단위 밖`);
		}
	});

	it("1차 목표가는 현재가보다 높다", () => {
		for (const { label, r } of results) {
			if (r.target1 !== null) assert.ok(r.target1 > r.price, `${label}: 목표 ${r.target1} ≤ 현재가 ${r.price}`);
		}
	});

	it("시나리오 트리거 가격은 전부 호가단위에 맞는다 (그대로 주문 준비에 쓸 수 있어야 한다)", () => {
		for (const { label, r } of results) {
			for (const s of r.scenarios) {
				if (s.triggerPrice === null) continue;
				assert.ok(isOnTick("KR", s.triggerPrice), `${label} ${s.id}: ${s.triggerPrice}`);
			}
		}
	});

	it("시나리오는 항상 S1·S2·S3 세 개", () => {
		for (const { r } of results) assert.deepEqual(r.scenarios.map((s) => s.id), ["S1", "S2", "S3"]);
	});

	it("포지션 크기는 매수 판정에서만, 손절 시 손실이 총자산 1% 이내", () => {
		for (const { label, r } of results) {
			if (r.verdict !== "매수") {
				assert.equal(r.sizing, null, `${label}: 매수가 아닌데 수량 제안`);
				continue;
			}
			if (!r.sizing || r.stopLoss === null) continue;
			const loss = r.sizing.quantity * (r.price - r.stopLoss);
			assert.ok(loss <= r.sizing.riskBudgetKrw, `${label}: 손실 ${loss} > 한도 ${r.sizing.riskBudgetKrw}`);
			assert.equal(r.sizing.riskBudgetKrw, 1_000_000);
		}
	});
});

describe("대표 사례", () => {
	const rising = barsOf(Array.from({ length: 90 }, (_, i) => 10_000 + i * 60));

	it("과열된 상승 — 보유 중이면 매도", () => {
		const r = evaluateTiming({ bars: rising, market: "KR", holding: { quantity: 5, avgPrice: 10_000 } });
		assert.equal(r?.verdict, "매도");
		assert.match(r?.summary ?? "", /과매수/);
		assert.equal(r?.scenarios[0]?.title, "이익 실현");
	});

	it("과열된 상승 — 미보유면 관망 (신규 진입 부적합)", () => {
		const r = evaluateTiming({ bars: rising, market: "KR" });
		assert.equal(r?.verdict, "관망");
		assert.match(r?.summary ?? "", /신규 진입 부적합/);
	});

	it("꾸준한 하락 — 관망", () => {
		const r = evaluateTiming({ bars: barsOf(Array.from({ length: 90 }, (_, i) => 30_000 - i * 100)), market: "KR" });
		assert.equal(r?.verdict, "관망");
		assert.equal(r?.layers.find((l) => l.name === "추세")?.state, "비우호");
	});

	it("평탄 — 관망, 신호 없음", () => {
		const r = evaluateTiming({ bars: barsOf(new Array(90).fill(50_000)), market: "KR" });
		assert.equal(r?.verdict, "관망");
	});

	it("매수 국면이라도 영업 적자면 관망으로 내린다", () => {
		const buy = all().find((x) => x.r.verdict === "매수" && !x.held);
		assert.ok(buy, "매수 사례가 필요하다");
		// 같은 시계열을 다시 만든다
		const s = [...scenarios()].find((x) => buy.label.startsWith(x.label));
		assert.ok(s);
		const r = evaluateTiming({
			bars: barsOf(s.closes),
			market: "KR",
			fundamentals: { operatingYoy: null, operatingProfit: -21, rating: null },
		});
		assert.equal(r?.verdict, "관망");
		assert.equal(r?.layers.find((l) => l.name === "밸류")?.state, "비우호");
		assert.match(r?.summary ?? "", /펀더멘털/);
	});

	it("손익분기는 보유 중이면 평단 기준, 아니면 현재가 기준", () => {
		const held = evaluateTiming({ bars: rising, market: "KR", holding: { quantity: 1, avgPrice: 10_000 } });
		assert.equal(held?.breakeven, 10_020); // 10,000 × 1.002
		const fresh = evaluateTiming({ bars: rising, market: "KR" });
		assert.equal(fresh?.breakeven, Math.ceil((fresh?.price ?? 0) * 1.002));
	});

	it("보유 손익률을 계산한다", () => {
		const r = evaluateTiming({ bars: rising, market: "KR", holding: { quantity: 1, avgPrice: 10_000 } });
		// 마지막 종가 10,000 + 89×60 = 15,340
		assert.equal(r?.holding?.pnlPct, 53.4);
	});

	it("증권사 수익률이 있으면 그걸 쓴다 (다시 계산하면 보유 현황과 어긋난다)", () => {
		const r = evaluateTiming({ bars: rising, market: "KR", holding: { quantity: 1, avgPrice: 10_000, pnlPct: 51.9 } });
		assert.equal(r?.holding?.pnlPct, 51.9);
	});

	it("해외 종목은 0.01 단위로 손절·트리거를 낸다", () => {
		const us = barsOf(Array.from({ length: 90 }, (_, i) => 300 + Math.sin(i / 6) * 12 + i * 0.1));
		const r = evaluateTiming({ bars: us, market: "US" });
		assert.ok(r);
		if (r.stopLoss !== null) assert.ok(isOnTick("US", r.stopLoss), `US 손절 ${r.stopLoss}`);
		for (const s of r.scenarios) if (s.triggerPrice !== null) assert.ok(isOnTick("US", s.triggerPrice));
	});

	it("빈 데이터면 null", () => {
		assert.equal(evaluateTiming({ bars: [], market: "KR" }), null);
	});
});

/**
 * 단기(1주) 모드 — 스윙보다 느슨하지만 지켜야 할 선은 같다:
 * 손익비 1 미만은 진입하지 않고, 극단 과열(RSI 80)·하락 신호에서는 사지 않으며, 손실은 한도 안.
 * 새로 생긴 위험: 돌파 진입가는 현재가보다 높다 → 지정가로 미리 넣으면 즉시 체결된다. 그래서 진입가를 따로 둔다.
 */
describe("단기 모드 (horizon=short)", () => {
	const swing = all("KR");
	const short = all("KR", "short");
	const layer = (r: TimingResult, n: string) => r.layers.find((l) => l.name === n);

	it("기본값은 스윙이다 — horizon 을 안 주면 결과가 swing 과 같다", () => {
		for (const { r } of swing) assert.equal(r.horizon, "swing");
		assert.ok(swing.every((x) => x.r.entry.type === "now" && x.r.entry.price === x.r.price), "스윙은 늘 현재가 진입");
	});

	it("스윙보다 매수가 많다 — 강세 종목을 전부 관망으로 돌리지 않는다", () => {
		const n = (xs: typeof swing) => xs.filter((x) => x.r.verdict === "매수").length;
		assert.ok(n(short) > n(swing) * 3, `단기 ${n(short)} / 스윙 ${n(swing)}`);
	});

	it("스윙에서 과열로 막힌 상승 추세(RSI 70~80)가 단기에서는 비중 절반 매수로 열린다", () => {
		// 하락→반등 시계열에는 "정배열 + RSI 70~80" 국면이 거의 없어 꾸준한 상승 + 흔들림으로 따로 만든다
		const opened: Array<{ label: string; r: TimingResult }> = [];
		for (const slope of [20, 30, 40, 60]) {
			for (const amp of [40, 80, 120]) {
				for (const period of [5, 7, 9]) {
					const closes = Array.from({ length: 90 }, (_, i) => Math.round(10_000 + i * slope + (((i * 37) % period) - (period >> 1)) * amp));
					const input = { bars: barsOf(closes), market: "KR" as const, totalAssetsKrw: 100_000_000 };
					const sw = evaluateTiming(input);
					const sh = evaluateTiming({ ...input, horizon: "short" });
					if (sw?.verdict === "관망" && /과매수/.test(sw.summary) && sh?.verdict === "매수") {
						opened.push({ label: `slope${slope}/amp${amp}/p${period}`, r: sh });
					}
				}
			}
		}
		assert.ok(opened.length >= 3, `과열 완화가 거의 작동하지 않는다 (${opened.length}건)`);
		for (const { label, r } of opened) {
			assert.ok((r.snapshot.rsi ?? 0) >= 70 && (r.snapshot.rsi ?? 100) < 80, `${label}: RSI ${r.snapshot.rsi}`);
			assert.ok(layer(r, "모멘텀")?.reasons.some((x) => x.startsWith("⚠")), `${label}: 과열 경고가 없다`);
			assert.equal(r.sizing?.riskPct, 0.5, `${label}: 과열 주의인데 비중이 절반이 아니다`);
		}
	});

	it("매수면 추세 우호 · 하락 신호 없음 · 손익비 1 이상 (진입가 기준)", () => {
		for (const { label, r } of short.filter((x) => x.r.verdict === "매수")) {
			assert.equal(layer(r, "추세")?.state, "우호", label);
			assert.ok(!layer(r, "모멘텀")?.reasons.some((x) => x.startsWith("▼")), `${label}: 하락 신호가 있는데 매수`);
			assert.ok(r.riskReward !== null && r.riskReward >= 1, `${label}: 손익비 1:${r.riskReward}`);
			assert.ok(r.stopLoss !== null && r.target1 !== null);
			const rr = ((r.target1 as number) - r.entry.price) / (r.entry.price - (r.stopLoss as number));
			assert.ok(Math.abs(rr - (r.riskReward as number)) < 0.01, `${label}: 손익비가 진입가 기준이 아니다`);
		}
	});

	it("RSI 80 이상 극단 과열에서는 사지 않는다", () => {
		for (const { label, r } of short) {
			if (r.snapshot.rsi !== null && r.snapshot.rsi >= 80) assert.notEqual(r.verdict, "매수", `${label}: RSI ${r.snapshot.rsi}`);
		}
	});

	it("돌파 진입이면 진입가 > 현재가, 요약에 '돌파 확인 후' 와 '선매수 금지' 가 있다", () => {
		const bo = short.filter((x) => x.r.verdict === "매수" && x.r.entry.type === "breakout");
		assert.ok(bo.length > 0);
		for (const { label, r } of bo) {
			assert.ok(r.entry.price > r.price, `${label}: 돌파 진입가 ${r.entry.price} ≤ 현재가 ${r.price}`);
			assert.match(r.summary, /돌파 확인 후 진입/, label);
			assert.match(r.summary, /선매수 금지/, label);
			assert.equal(r.scenarios[0]?.triggerPrice, r.entry.price, `${label}: S1 트리거가 진입가가 아니다`);
		}
	});

	it("손절 < 진입가 < 목표1, 가격은 전부 호가단위", () => {
		for (const { label, r } of short) {
			// "지금 진입" 의 진입가는 현재가 그 자체라 주문 가격이 아니다 — 주문에 쓰는 건 돌파 진입가와 S1 트리거
			if (r.entry.type === "breakout") assert.ok(isOnTick("KR", r.entry.price), `${label}: 진입가 ${r.entry.price}`);
			if (r.stopLoss !== null) {
				assert.ok(r.stopLoss < r.entry.price, `${label}: 손절 ${r.stopLoss} ≥ 진입 ${r.entry.price}`);
				assert.ok(isOnTick("KR", r.stopLoss), label);
			}
			if (r.target1 !== null) assert.ok(r.target1 > r.entry.price, `${label}: 목표 ${r.target1} ≤ 진입 ${r.entry.price}`);
			for (const sc of r.scenarios) if (sc.triggerPrice !== null) assert.ok(isOnTick("KR", sc.triggerPrice), `${label} ${sc.id}`);
		}
	});

	it("손절 폭은 스윙보다 짧다 (ATR×1.5 이내)", () => {
		for (const { label, r } of short) {
			const atr = r.snapshot.atr;
			if (r.stopLoss === null || atr === null) continue;
			// 손절가를 호가단위로 내리므로 한 틱까지 더 벌어질 수 있다
			assert.ok(r.entry.price - r.stopLoss <= atr * 1.5 + tickSize("KR", r.stopLoss), `${label}: 손절 폭 ${r.entry.price - r.stopLoss} > ATR×1.5 ${atr * 1.5}`);
		}
	});

	it("매수 시나리오의 S3 는 손절 + 5거래일 시간 손절", () => {
		for (const { label, r } of short.filter((x) => x.r.verdict === "매수")) {
			assert.match(r.scenarios[2]?.trigger ?? "", new RegExp(`${SHORT_TIME_STOP_DAYS}거래일`), label);
			assert.equal(r.scenarios[2]?.weightPct, 100, label);
		}
	});

	it("포지션 크기: 진입가에서 손절까지 잃어도 한도(1%, 과열 주의 0.5%) 이내", () => {
		for (const { label, r } of short) {
			if (r.verdict !== "매수") {
				assert.equal(r.sizing, null, label);
				continue;
			}
			if (!r.sizing || r.stopLoss === null) continue;
			const loss = r.sizing.quantity * (r.entry.price - r.stopLoss);
			assert.ok(loss <= r.sizing.riskBudgetKrw, `${label}: 손실 ${loss} > 한도 ${r.sizing.riskBudgetKrw}`);
			assert.equal(r.sizing.riskBudgetKrw, r.sizing.riskPct === 0.5 ? 500_000 : 1_000_000, label);
		}
	});

	it("매도는 보유 중일 때만, 시나리오는 늘 세 개", () => {
		for (const { label, r, held } of short) {
			if (r.verdict === "매도") assert.ok(held, label);
			assert.deepEqual(r.scenarios.map((x) => x.id), ["S1", "S2", "S3"], label);
		}
	});

	it("해외 종목도 0.01 단위로 진입·손절·트리거를 낸다", () => {
		for (const { label, r } of all("US", "short")) {
			const entry = r.entry.type === "breakout" ? r.entry.price : null;
			for (const v of [entry, r.stopLoss, ...r.scenarios.map((x) => x.triggerPrice)]) {
				if (v !== null) assert.ok(isOnTick("US", v), `${label}: ${v}`);
			}
		}
	});
});
