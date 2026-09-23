/**
 * market_timing 출력 — 기간을 정하지 않으면 스윙·단기를 둘 다 내보낸다.
 * 모델은 텍스트만 보고, 카드는 details 로 그린다 — 둘이 같은 판정을 가리켜야 한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "../src/indicators.ts";
import { evaluateTiming, type Horizon, type TimingResult } from "../src/timing.ts";
import { renderTiming } from "../src/tools.ts";

function barsOf(closes: number[]): Bar[] {
	return closes.map((c, i) => ({ date: String(20260101 + i), open: c, high: c * 1.01, low: c * 0.99, close: c }));
}

/** 흔들리며 오르는 시계열 — 두 모드에서 판정이 갈리는 국면을 찾는 데 쓴다 */
function wave(slope: number, amp: number, period: number): Bar[] {
	return barsOf(Array.from({ length: 100 }, (_, i) => Math.round(10_000 + i * slope + (((i * 37) % period) - (period >> 1)) * amp)));
}

function both(bars: Bar[]): TimingResult[] {
	return (["swing", "short"] as Horizon[]).map((h) => evaluateTiming({ bars, market: "KR", horizon: h }) as TimingResult);
}

describe("renderTiming", () => {
	it("둘 다 넘기면 텍스트에 두 판정이 모두 있고, 카드에는 alt 가 붙는다", () => {
		const { text, details } = renderTiming({ symbol: "005930", name: "삼성전자", currency: "KRW", results: both(wave(30, 80, 7)), notes: [] });
		assert.match(text, /\[스윙·단기 둘 다\]/);
		assert.match(text, /\[스윙 \(몇 주\)\] 결론:/);
		assert.match(text, /\[단기 1주\] 결론:/);
		assert.ok(details.alt, "alt 가 없다");
		assert.notEqual(details.result.horizon, details.alt.horizon);
		// 추세·밸류층은 한 번만 (두 모드에서 같다)
		assert.equal(text.match(/\[추세\]/g)?.length, 1);
		assert.equal(text.match(/\[밸류\]/g)?.length, 1);
		assert.equal(text.match(/\[리스크\]/g)?.length, 2);
		assert.equal(text.match(/매매 권유가 아닙니다/g)?.length, 1, "고지는 한 번만");
	});

	it("한쪽만 매수면 그쪽을 먼저 보여준다, 둘 다 같으면 스윙이 먼저", () => {
		let checkedSplit = false;
		let checkedSame = false;
		for (const slope of [10, 20, 30, 40, 60, 80]) {
			for (const amp of [40, 80, 120, 160]) {
				for (const period of [5, 7, 9, 11]) {
					const results = both(wave(slope, amp, period));
					const [sw, sh] = results as [TimingResult, TimingResult];
					const { details, text } = renderTiming({ symbol: "005930", name: "삼성전자", currency: "KRW", results, notes: [] });
					const firstLine = text.split("\n")[1] ?? "";
					if (sh.verdict === "매수" && sw.verdict !== "매수") {
						assert.equal(details.result.horizon, "short");
						assert.match(firstLine, /^\[단기 1주\]/);
						checkedSplit = true;
					} else {
						assert.equal(details.result.horizon, "swing");
						assert.match(firstLine, /^\[스윙/);
						if (sw.verdict === sh.verdict) checkedSame = true;
					}
				}
			}
		}
		assert.ok(checkedSame, "두 모드 판정이 같은 사례가 없다");
		assert.ok(checkedSplit, "단기만 매수인 사례가 없다");
	});

	it("하나만 넘기면 alt 없이 그 모드만", () => {
		const [sw] = both(wave(30, 80, 7));
		const { text, details } = renderTiming({ symbol: "005930", name: "삼성전자", currency: "KRW", results: [sw as TimingResult], notes: ["재무 조회 실패"] });
		assert.equal(details.alt, undefined);
		assert.match(text, /\[스윙 \(몇 주\)\] —/);
		assert.doesNotMatch(text, /\[단기 1주\]/);
		assert.match(text, /⚠️ 재무 조회 실패/);
	});
});
