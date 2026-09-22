/**
 * 기술적 지표 테스트.
 *
 * 지표는 틀려도 "그럴듯해서" 발견이 늦다 — 모델이 계산하게 두지 않는 이유이자,
 * 계산을 코드로 옮긴 이상 알려진 값으로 고정해둬야 하는 이유다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	analyze,
	atr,
	bollinger,
	ema,
	macd,
	rsi,
	sma,
	supportResistance,
	trendOf,
	type Bar,
} from "../src/indicators.ts";

/** 종가 배열 → 봉 배열 (고저는 종가 기준으로 좁게 만든다) */
function barsOf(closes: number[], startDate = 20260101): Bar[] {
	return closes.map((c, i) => ({
		date: String(startDate + i),
		open: c,
		high: c,
		low: c,
		close: c,
	}));
}

const approx = (actual: number | null, expected: number, tol: number, label: string): void => {
	assert.ok(actual !== null, `${label}: null 이면 안 된다`);
	assert.ok(
		Math.abs((actual as number) - expected) <= tol,
		`${label}: ${actual} 가 ${expected}±${tol} 밖이다`,
	);
};

describe("이동평균", () => {
	it("기간 전까지는 null, 이후 평균", () => {
		const r = sma([1, 2, 3, 4, 5], 3);
		assert.deepEqual(r, [null, null, 2, 3, 4]);
	});

	it("EMA 초기값은 첫 기간의 단순평균", () => {
		const r = ema([1, 2, 3, 4, 5], 3);
		assert.equal(r[0], null);
		assert.equal(r[1], null);
		assert.equal(r[2], 2); // (1+2+3)/3
		// 이후: 4*0.5 + 2*0.5 = 3
		approx(r[3] as number, 3, 1e-9, "ema[3]");
	});

	it("데이터가 기간보다 짧으면 전부 null", () => {
		assert.deepEqual(ema([1, 2], 5), [null, null]);
		assert.deepEqual(sma([1, 2], 5), [null, null]);
	});
});

describe("RSI", () => {
	it("Wilder 표준 예제와 일치한다 (≈70.5)", () => {
		// New Concepts in Technical Trading Systems 의 고전 예제
		const closes = [
			44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
		];
		const r = rsi(closes, 14);
		approx(r[14], 70.5, 0.6, "RSI(14)");
	});

	it("계속 오르면 100, 계속 내리면 0", () => {
		const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
		approx(up[29], 100, 1e-6, "상승 RSI");

		const down = rsi(Array.from({ length: 30 }, (_, i) => 200 - i), 14);
		approx(down[29], 0, 1e-6, "하락 RSI");
	});

	it("데이터가 부족하면 null", () => {
		assert.equal(rsi([1, 2, 3], 14).every((v) => v === null), true);
	});
});

describe("MACD", () => {
	it("직선 상승에서는 MACD 가 상수라 시그널과 같아진다", () => {
		// 등차수열이면 EMA 차이가 상수 → signal(EMA of 상수) 도 같은 값
		const r = macd(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
		approx(r.macd[79], 14, 1e-9, "MACD");
		approx(r.signal[79], 14, 1e-9, "signal");
		approx(r.histogram[79], 0, 1e-9, "histogram");
	});

	it("가속 상승에서는 MACD 가 시그널 위에 있다", () => {
		// 2차 함수로 상승 가속 → MACD 가 계속 커지고 signal 이 뒤따른다
		const r = macd(Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.1));
		const m = r.macd[79] as number;
		const s = r.signal[79] as number;
		assert.ok(m > s, `가속 상승이면 MACD(${m.toFixed(3)}) > signal(${s.toFixed(3)})`);
		assert.ok((r.histogram[79] as number) > 0);
	});

	it("히스토그램 = MACD − signal", () => {
		const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
		const r = macd(closes);
		for (let i = 0; i < closes.length; i++) {
			if (r.histogram[i] === null) continue;
			approx(r.histogram[i], (r.macd[i] as number) - (r.signal[i] as number), 1e-9, `hist[${i}]`);
		}
	});
});

describe("볼린저", () => {
	it("변동이 없으면 상·하단이 중심선과 같다", () => {
		const r = bollinger(new Array(30).fill(100), 20, 2);
		assert.equal(r.middle[29], 100);
		assert.equal(r.upper[29], 100);
		assert.equal(r.lower[29], 100);
	});

	it("상단 > 중심 > 하단", () => {
		const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 5);
		const r = bollinger(closes, 20, 2);
		assert.ok((r.upper[39] as number) > (r.middle[39] as number));
		assert.ok((r.middle[39] as number) > (r.lower[39] as number));
	});
});

describe("ATR", () => {
	it("변동폭이 일정하면 그 값으로 수렴한다", () => {
		// 매 봉 고저 폭 10, 종가 동일 → TR 은 항상 10
		const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({
			date: String(20260101 + i),
			open: 100,
			high: 105,
			low: 95,
			close: 100,
		}));
		approx(atr(bars, 14)[39], 10, 1e-6, "ATR");
	});
});

describe("지지·저항", () => {
	it("마지막 봉을 제외한 구간의 고저를 쓴다", () => {
		const bars = barsOf([10, 20, 5, 15, 999]);
		const r = supportResistance(bars, 20);
		assert.equal(r.resistance, 20, "마지막 봉(999)은 저항 계산에서 빠져야 한다");
		assert.equal(r.support, 5);
	});
});

describe("추세", () => {
	it("MA 배열로 판정한다", () => {
		assert.equal(trendOf(30, 20, 10), "정배열");
		assert.equal(trendOf(10, 20, 30), "역배열");
		assert.equal(trendOf(20, 10, 30), "혼조");
		assert.equal(trendOf(null, 20, 30), "혼조");
	});
});

describe("analyze 종합", () => {
	it("빈 배열이면 null", () => {
		assert.equal(analyze([]), null);
	});

	it("꾸준한 상승에서 정배열 + 과매수를 잡는다", () => {
		const snap = analyze(barsOf(Array.from({ length: 90 }, (_, i) => 100 + i)));
		assert.ok(snap);
		assert.equal(snap?.trend, "정배열");
		assert.ok((snap?.rsi ?? 0) >= 70, `RSI 가 과매수여야 한다: ${snap?.rsi}`);
		assert.match(snap?.signals.join() ?? "", /과매수/);
		assert.ok((snap?.periodChangePct ?? 0) > 80);
	});

	it("꾸준한 하락에서 역배열 + 과매도를 잡는다", () => {
		const snap = analyze(barsOf(Array.from({ length: 90 }, (_, i) => 200 - i)));
		assert.equal(snap?.trend, "역배열");
		assert.ok((snap?.rsi ?? 100) <= 30);
		assert.match(snap?.signals.join() ?? "", /과매도/);
	});

	it("데이터가 적으면 계산 가능한 것만 채우고 죽지 않는다", () => {
		const snap = analyze(barsOf([100, 101, 102]));
		assert.ok(snap);
		assert.equal(snap?.bars, 3);
		assert.equal(snap?.ma20, null);
		assert.equal(snap?.rsi, null);
		assert.equal(snap?.trend, "혼조");
		assert.equal(snap?.price, 102);
	});

	it("ATR 을 가격 대비 %로도 준다 (종목 간 변동성 비교)", () => {
		const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({
			date: String(20260101 + i),
			open: 1000,
			high: 1050,
			low: 950,
			close: 1000,
		}));
		const snap = analyze(bars);
		approx(snap?.atr ?? null, 100, 1e-6, "ATR");
		approx(snap?.atrPct ?? null, 10, 0.1, "ATR%");
	});

	it("횡보장에서 가짜 교차 신호를 내지 않는다", () => {
		// 완전 평탄 — 두 선의 차이가 부동소수점 노이즈(1e-15)까지 좁혀지는 구간
		const flat = analyze(barsOf(new Array(90).fill(50_000)));
		assert.equal(
			flat?.signals.some((s) => /크로스/.test(s)),
			false,
			`평탄 데이터에서 교차 신호가 나오면 안 된다: ${flat?.signals.join(", ")}`,
		);
	});

	it("실제 교차는 여전히 잡는다", () => {
		// analyze 는 "마지막 봉에서 일어난" 교차만 신호로 낸다.
		// 반등 길이를 하드코딩하면 깨지기 쉬우므로, 교차가 발생하는 지점을 탐색한다.
		const down = Array.from({ length: 60 }, (_, i) => 200 - i); // 140 까지 하락
		const found = Array.from({ length: 25 }, (_, n) => n + 1).some((rally) => {
			const up = Array.from({ length: rally }, (_, i) => 141 + i * 4);
			return /골든크로스/.test(analyze(barsOf([...down, ...up]))?.signals.join() ?? "");
		});
		assert.ok(found, "하락 후 반등 구간 어딘가에서 골든크로스가 잡혀야 한다");
	});

	it("기간 고저·등락률을 계산한다", () => {
		const snap = analyze(barsOf([100, 120, 90, 110]));
		assert.equal(snap?.periodHigh, 120);
		assert.equal(snap?.periodLow, 90);
		assert.equal(snap?.periodChangePct, 10);
	});
});
