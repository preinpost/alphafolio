/**
 * 옵션 가격·그릭스·내재변동성 (PLAN §37) — 교과서 예제값과 수치 미분으로 검증한다.
 * 기준: Hull "Options, Futures, and Other Derivatives", Haug "The Complete Guide to Option Pricing Formulas".
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { greeks, impliedVol, normCdf, optionPrice, type OptionInput } from "../src/derivatives/greeks.ts";
import { buildGreeksReport, createDerivativesTools, daysToExpiry, money, parseDomesticOptionQuote } from "../src/derivatives/tool.ts";
import { memoryTokenStore } from "../src/tokens.ts";

const near = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

describe("정규분포", () => {
	it("기준값 — 꼬리는 상대 오차로 본다 (먼 외가격 옵션 가격이 여기서 나온다)", () => {
		near(normCdf(0), 0.5, 1e-15);
		near(normCdf(1), 0.8413447460685429, 1e-14);
		near(normCdf(-1.96), 0.024997895148220435, 1e-15);
		const tail = (x: number, ref: number) => near(normCdf(x) / ref, 1, 1e-9, `Φ(${x})`);
		tail(-5, 2.866515718791939e-7);
		tail(-8, 6.22096057427178e-16);
		tail(-10, 7.61985302416047e-24);
		near(normCdf(-3.0000001), normCdf(-3), 1e-9, "3 경계에서 연속");
		for (const x of [0.3, 1.7, 2.9, 3.5, 6]) near(normCdf(x) + normCdf(-x), 1, 1e-15, `대칭 ${x}`);
	});
});

const bsm = (o: Partial<OptionInput>): OptionInput => ({ type: "call", model: "bsm", underlying: 100, strike: 100, years: 0.5, rate: 0.05, vol: 0.2, ...o });

describe("가격 — 교과서 예제", () => {
	it("Hull 15.6: S=42 K=40 r=10% σ=20% T=0.5 → 콜 4.76 · 풋 0.81", () => {
		near(optionPrice(bsm({ underlying: 42, strike: 40, rate: 0.1 })), 4.7594, 1e-4);
		near(optionPrice(bsm({ type: "put", underlying: 42, strike: 40, rate: 0.1 })), 0.8086, 1e-4);
	});
	it("Haug 1.1.6 배당(q=5%): S=100 K=95 T=0.5 r=10% σ=20% → 풋 2.4648", () => {
		near(optionPrice(bsm({ type: "put", strike: 95, rate: 0.1, dividend: 0.05 })), 2.4648, 1e-4);
	});
	it("Haug 1.1.4 Black-76: F=19 K=19 T=0.75 r=10% σ=28% → 1.7011 (등가라 콜=풋)", () => {
		const f = { model: "black76" as const, underlying: 19, strike: 19, years: 0.75, rate: 0.1, vol: 0.28 };
		near(optionPrice(bsm(f)), 1.7011, 1e-4);
		near(optionPrice(bsm({ ...f, type: "put" })), 1.7011, 1e-4);
	});
	it("풋-콜 패리티 — 현물(배당 포함)·선물 모두", () => {
		for (const o of [bsm({ strike: 90, dividend: 0.03 }), bsm({ strike: 115, years: 2, vol: 0.45 }), bsm({ model: "black76", strike: 80, underlying: 95 })]) {
			const c = optionPrice(o);
			const p = optionPrice({ ...o, type: "put" });
			const fwd = o.model === "black76" ? o.underlying * Math.exp(-o.rate * o.years) : o.underlying * Math.exp(-(o.dividend ?? 0) * o.years);
			near(c - p, fwd - o.strike * Math.exp(-o.rate * o.years), 1e-10);
		}
	});
	it("잘못된 입력은 거절", () => {
		assert.throws(() => optionPrice(bsm({ years: 0 })), /years/);
		assert.throws(() => optionPrice(bsm({ vol: -0.1 })), /vol/);
		assert.throws(() => optionPrice(bsm({ underlying: Number.NaN })), /underlying/);
	});
});

describe("그릭스", () => {
	it("Hull 19장 예: S=49 K=50 r=5% σ=20% T=20주 → Δ 0.522 · Γ 0.066 · Θ −4.31/년 · 𝜈 12.1 · ρ 8.91", () => {
		const g = greeks(bsm({ underlying: 49, strike: 50, years: 20 / 52 }));
		near(g.delta, 0.522, 5e-4);
		near(g.gamma, 0.066, 5e-4);
		near(g.theta * 365, -4.31, 5e-3);
		near(g.vega * 100, 12.1, 5e-2);
		near(g.rho * 100, 8.91, 5e-3);
	});

	it("수치 미분과 일치 — 현물·선물 × 콜·풋 (단위: 베가·로 1%p, 세타 1일)", () => {
		const cases = [bsm({}), bsm({ type: "put", dividend: 0.02, strike: 110 }), bsm({ model: "black76", underlying: 6000, strike: 6200, years: 0.1, vol: 0.18 }), bsm({ model: "black76", type: "put", underlying: 50, strike: 45, years: 1.3, vol: 0.5 })];
		for (const o of cases) {
			const g = greeks(o);
			const P = (d: Partial<OptionInput>) => optionPrice({ ...o, ...d });
			const h = o.underlying * 1e-4;
			const label = `${o.model} ${o.type}`;
			near(g.delta, (P({ underlying: o.underlying + h }) - P({ underlying: o.underlying - h })) / (2 * h), 1e-6, `${label} Δ`);
			near(g.gamma, (P({ underlying: o.underlying + h }) - 2 * P({}) + P({ underlying: o.underlying - h })) / (h * h), 1e-4 * Math.max(1, g.gamma), `${label} Γ`);
			near(g.vega, (P({ vol: o.vol + 1e-5 }) - P({ vol: o.vol - 1e-5 })) / 2e-5 / 100, 1e-6, `${label} 𝜈`);
			near(g.theta, -(P({ years: o.years + 1e-6 }) - P({ years: o.years - 1e-6 })) / 2e-6 / 365, 1e-6, `${label} Θ`);
			// 현물옵션은 배당수익률을 고정하고 금리만 바꾼다 (보유비용 b = r − q 도 함께 움직인다)
			near(g.rho, (P({ rate: o.rate + 1e-6 }) - P({ rate: o.rate - 1e-6 })) / 2e-6 / 100, 1e-6, `${label} ρ`);
		}
	});
});

describe("내재변동성", () => {
	it("가격 → 변동성 → 가격이 되돌아온다 (행사가·만기·변동성 격자)", () => {
		for (const type of ["call", "put"] as const)
			for (const strike of [70, 95, 100, 105, 140])
				for (const years of [7 / 365, 0.25, 2])
					for (const vol of [0.08, 0.3, 1.2]) {
						const o = bsm({ type, strike, years, vol, dividend: 0.01 });
						const p = optionPrice(o);
						if (p < 1e-8) continue; // 가격이 사실상 0 이면 변동성이 정해지지 않는다
						const r = impliedVol(o, p);
						assert.ok(r.vol !== null, `${type} K${strike} T${years} σ${vol}: ${r.reason}`);
						near(optionPrice({ ...o, vol: r.vol! }), p, 1e-8 * Math.max(1, p), `${type} K${strike} T${years} σ${vol}`);
					}
	});
	it("내재가치보다 싼 가격·0 이하 가격은 변동성이 없다고 답한다", () => {
		assert.equal(impliedVol(bsm({ strike: 80 }), 15).vol, null);
		assert.match(impliedVol(bsm({ strike: 80 }), 15).reason ?? "", /내재가치/);
		assert.equal(impliedVol(bsm({}), 0).vol, null);
	});
});

// KIS 선물옵션 시세(FHMIF10000000) 응답 모양 — KOSPI200 콜 (시세 값은 예시)
const QUOTE = {
	output1: {
		hts_kor_isnm: "C 202610 1,127.5", futs_prpr: "29.20", futs_sdpr: "27.00", acpr: "1127.50", futs_last_tr_date: "20261008", hts_rmnn_dynu: "16",
		hts_ints_vltl: "32.3464", delta_val: "0.5296", gama: "0.0023", theta: "-2.3467", vega: "0.9078", rho: "0.2166",
	},
	output2: { hts_kor_isnm: "종합", bstp_nmix_prpr: "7080.92" },
	output3: { hts_kor_isnm: "KOSPI200", bstp_nmix_prpr: "1126.12" },
	rt_cd: "0",
};

describe("국내 옵션 시세 읽기", () => {
	it("콜/풋은 이름 첫 글자, 기초자산은 output3 (output2 는 종합지수다), 승수 250,000", () => {
		const q = parseDomesticOptionQuote("B01610A52", QUOTE, "O")!;
		assert.equal(q.type, "call");
		assert.equal(q.strike, 1127.5);
		assert.equal(q.underlying, 1126.12);
		assert.equal(q.underlyingName, "KOSPI200");
		assert.equal(q.multiplier, 250_000);
		assert.equal(q.price, 29.2);
		assert.equal(q.priceIsBase, false);
		assert.equal(parseDomesticOptionQuote("C01610A52", { ...QUOTE, output1: { ...QUOTE.output1, hts_kor_isnm: "P 202610 1,127.5" } }, "O")!.type, "put");
	});
	it("체결이 없으면 기준가 · 미니는 50,000 · 주식옵션은 10 · 옵션이 아니면 null", () => {
		const q = parseDomesticOptionQuote("x", { ...QUOTE, output1: { ...QUOTE.output1, futs_prpr: "0.00", hts_kor_isnm: "미니 C 202610 1,127.5" } }, "O")!;
		assert.deepEqual([q.price, q.priceIsBase, q.multiplier, q.type], [27, true, 50_000, "call"]);
		assert.equal(parseDomesticOptionQuote("x", QUOTE, "JO")!.multiplier, 10);
		assert.equal(parseDomesticOptionQuote("101W12", { output1: { hts_kor_isnm: "F 202612", futs_prpr: "1130", acpr: "0" } }, "O"), null);
	});
	it("만기까지 남은 날 — 최종거래일 15:20 KST 기준", () => {
		const nineAmKst = Date.UTC(2026, 9, 7, 0, 0); // 10/7 09:00 KST
		near(daysToExpiry("20261008", nineAmKst), 1 + 6.333 / 24, 1e-3);
		near(daysToExpiry("2026-10-08", nineAmKst), daysToExpiry("20261008", nineAmKst), 1e-12);
		assert.throws(() => daysToExpiry("10/08"), /형식/);
	});
});

describe("보고", () => {
	const base = { title: "t", type: "put" as const, model: "bsm" as const, underlying: 1126.12, strike: 1127.5, days: 14, rate: 0.025, dividend: 0, price: 40.95, multiplier: 250_000, currency: "KRW" };

	it("매도 포지션은 부호가 뒤집힌다 — 풋 매도는 델타·세타가 +, 베가가 −", () => {
		const long = buildGreeksReport(base);
		const short = buildGreeksReport({ ...base, quantity: -2 });
		assert.ok(long.g && long.g.delta < 0 && long.g.theta < 0 && long.g.vega > 0);
		const posLine = short.lines.find((l) => l.startsWith("보유 매도 2계약"))!;
		assert.match(posLine, /1 오르면 \+/);
		assert.match(posLine, /하루 지나면 \+/);
		assert.match(posLine, /변동성 1%p 오르면 -/);
		assert.match(posLine, /금리 1%p 오르면 \+/, "풋 매도는 로도 뒤집힌다");
		// 기초자산 노출 = 델타 × 수량 × 지수 × 승수
		const exposure = Math.round(long.g.delta * -2 * base.underlying * base.multiplier);
		assert.ok(posLine.includes(money(exposure, "KRW")), posLine);
	});

	it("만기 손익분기점·최대 손익 — 풋 매도는 손실이 행사가−프리미엄까지, 콜 매도는 제한 없음", () => {
		const shortPut = buildGreeksReport({ ...base, quantity: -2 }).lines.find((l) => l.startsWith("만기 손익분기점"))!;
		assert.match(shortPut, /손익분기점 1,086\.55/);
		assert.ok(shortPut.includes(`최대 이익 ${money(40.95 * 250_000 * 2, "KRW")}`), shortPut);
		assert.ok(shortPut.includes(`최대 손실 ${money(-(1127.5 - 40.95) * 250_000 * 2, "KRW")}`), shortPut);
		const shortCall = buildGreeksReport({ ...base, type: "call", price: 29.2, quantity: -1 }).lines.find((l) => l.startsWith("만기 손익분기점"))!;
		assert.match(shortCall, /손익분기점 1,156\.7 .*최대 손실 제한 없음/);
		const longCall = buildGreeksReport({ ...base, type: "call", price: 29.2 }).lines.find((l) => l.startsWith("만기 손익분기점"))!;
		assert.match(longCall, /최대 이익 제한 없음 · 최대 손실 -7,300,000원/);
	});

	it("시나리오 표 — '그대로·지금' 칸은 0, 폭락에 풋 매도는 손실", () => {
		const r = buildGreeksReport({ ...base, quantity: -1 });
		const row0 = r.lines.find((l) => l.startsWith("| 그대로"))!;
		assert.equal(row0.split("|")[2]!.trim(), "0");
		const crash = r.lines.find((l) => l.startsWith("| -5%"))!;
		assert.match(crash.split("|")[2]!.trim(), /^-/);
	});

	it("만기가 지났으면·가격이 내재가치 밑이면 계산하지 않고 말한다", () => {
		assert.throws(() => buildGreeksReport({ ...base, days: 0 }), /만기/);
		const r = buildGreeksReport({ ...base, type: "call", strike: 1000, price: 100 });
		assert.equal(r.g, null);
		assert.match(r.lines.join("\n"), /내재변동성을 구할 수 없습니다/);
	});

	it("손익 표시 — 반올림해 0 이면 '0' (−0 이 '+-0' 으로 나오던 문제)", () => {
		assert.equal(money(-0.2, "KRW"), "0원");
		assert.equal(money(1234.6, "USD"), "+1,235 USD");
		assert.equal(money(-5, "KRW"), "-5원");
	});
});

describe("derivatives_greeks 툴", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("code 로 KIS 시세를 읽어 계산 — 지수옵션(O)에 없으면 주식옵션(JO)으로", async () => {
		const markets: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			const u = new URL(String(input));
			if (u.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "T", expires_in: 86400 }));
			const mk = u.searchParams.get("FID_COND_MRKT_DIV_CODE")!;
			markets.push(mk);
			if (mk === "O") return new Response(JSON.stringify({ output1: { hts_kor_isnm: "", acpr: "0" }, rt_cd: "0" }));
			return new Response(JSON.stringify({ ...QUOTE, output3: { hts_kor_isnm: "삼성전자", bstp_nmix_prpr: "1126.12" } }));
		}) as typeof fetch;
		const ctx = { creds: { appKey: "A", appSecret: "S", env: "real" as const }, store: memoryTokenStore(), owner: "u" };
		const [tool] = createDerivativesTools({ brokers: { kis: () => ctx }, now: () => Date.UTC(2026, 8, 24, 4, 0) });
		const r = (await tool!.execute("id", { code: "b01610a52" } as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
		assert.deepEqual(markets, ["O", "JO"]);
		const text = r.content[0]!.text;
		assert.match(text, /\(B01610A52\)/, "코드는 대문자로");
		assert.match(text, /승수 10\)/, "주식옵션 승수");
		assert.match(text, /KIS 제공 32\.35%/);
	});

	it("직접 입력 — 빠진 값은 알려 주고, USD 는 USD 그대로", async () => {
		const [tool] = createDerivativesTools({ brokers: {}, now: () => Date.UTC(2026, 8, 24, 4, 0) });
		await assert.rejects(tool!.execute("id", { type: "call", strike: 200 } as never, undefined, undefined, undefined as never), /underlying·expiry/);
		const r = (await tool!.execute("id", { type: "call", underlying: 210, strike: 200, expiry: "2026-12-18", price: 18.5, multiplier: 100 } as never, undefined, undefined, undefined as never)) as {
			content: Array<{ text: string }>;
		};
		assert.match(r.content[0]!.text, / USD/);
		assert.doesNotMatch(r.content[0]!.text, /원/);
	});
});
