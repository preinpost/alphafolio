/**
 * 타점 판정 백테스트 — 실제 일봉으로 market_timing 규칙이 "얼마나 자주 매수를 내는지" 와
 * "그 매수가 쓸 만했는지" 를 잰다. 규칙을 바꿀 때 전후를 비교하는 용도다.
 *
 *   node --experimental-strip-types packages/broker/scripts/timing-backtest.ts [--refresh]
 *
 * 데이터: Yahoo Finance 일봉 2년 (키 불필요). `.data/backtest/` 에 캐시한다 (--refresh 로 다시 받는다).
 * 판정 시점마다 직전 100봉만 넘긴다 (market_timing 이 실제로 받는 봉 수).
 *
 * 매매 시뮬레이션 (미보유 · 매수 판정만):
 *   진입   now = 그날 종가 / breakout = 5거래일 안에 고가가 진입가에 닿으면 max(시가, 진입가), 안 닿으면 미체결
 *   청산   손절(저가 ≤ 손절, 갭이면 시가) · 목표1(고가 ≥ 목표1) · 기간 만료(종가)
 *          같은 날 손절·목표가 둘 다 닿으면 손절로 친다 (보수적)
 *   기간   short 5거래일 · swing 20거래일
 *   비용   왕복 0.2%
 * 기준선: 같은 날짜들에 판정과 무관하게 "그 모드의 손절·목표로 지금 샀다면" 의 결과.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "../src/indicators.ts";
import { evaluateTiming, type Horizon, type TimingResult } from "../src/timing.ts";
import type { Market } from "../src/orders.ts";

const US = [
	"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "MU", "INTC", "NFLX", "COST", "V", "JPM",
	"XOM", "LLY", "NVO", "UNH", "PLTR", "IONQ", "RKLB", "SMR", "SOFI", "COIN", "HOOD", "UBER", "SHOP", "CRWD", "ORCL",
	"QQQ", "SPY", "SMH", "IWM", "XLK", "XLE", "TLT", "GLD",
];
const KR = [
	"005930", "000660", "035420", "035720", "005380", "000270", "068270", "207940", "373220", "051910", "006400",
	"105560", "055550", "012330", "028260", "066570", "034020", "042700", "009150", "010130", "011200", "003490",
	"096770", "017670", "030200",
];

const ROOT = new URL("../../../", import.meta.url).pathname;
const CACHE = join(ROOT, ".data/backtest");
const WINDOW = 100;
const HOLD: Record<Horizon, number> = { swing: 20, short: 5 };
const BREAKOUT_WAIT = 5;
const COST_PCT = 0.2;
/** 기간을 둘로 나눠 한쪽 장세에서만 통하는 규칙인지 본다 */
const SPLIT = "20260101";

async function fetchYahoo(ticker: string): Promise<Bar[] | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
	const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
	if (!res.ok) return null;
	const json = (await res.json()) as any;
	const r = json?.chart?.result?.[0];
	const q = r?.indicators?.quote?.[0];
	if (!r?.timestamp || !q) return null;
	const bars: Bar[] = [];
	for (let i = 0; i < r.timestamp.length; i++) {
		const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
		if ([o, h, l, c].some((v) => v === null || v === undefined || !(v > 0))) continue;
		const d = new Date(r.timestamp[i] * 1000);
		bars.push({
			date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
			open: o,
			high: h,
			low: l,
			close: c,
			volume: q.volume?.[i] ?? undefined,
		});
	}
	return bars;
}

async function load(symbol: string, market: Market, refresh: boolean): Promise<Bar[] | null> {
	const file = join(CACHE, `${symbol}.json`);
	if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Bar[];
	let bars: Bar[] | null = null;
	if (market === "US") bars = await fetchYahoo(symbol);
	else {
		for (const sfx of [".KS", ".KQ"]) {
			bars = await fetchYahoo(symbol + sfx);
			if (bars && bars.length > 0) break;
		}
		// 국내 가격은 원 단위 정수 (Yahoo 는 소수로 줄 때가 있다)
		bars = bars?.map((b) => ({ ...b, open: Math.round(b.open), high: Math.round(b.high), low: Math.round(b.low), close: Math.round(b.close) })) ?? null;
	}
	if (bars && bars.length > 0) writeFileSync(file, JSON.stringify(bars));
	return bars;
}

interface Trade {
	filled: boolean;
	retPct: number;
	r: number;
	exit: "target" | "stop" | "time";
}

/** t 일에 r 의 진입·손절·목표로 샀다면 */
function simulate(bars: Bar[], t: number, r: TimingResult, horizon: Horizon): Trade | null {
	if (r.stopLoss === null || r.target1 === null) return null;
	const stop = r.stopLoss;
	const target = r.target1;
	let entry = r.entry.price;
	let start = t + 1; // 이 날부터 청산 조건을 본다
	if (r.entry.type === "breakout") {
		let fill = -1;
		for (let i = t + 1; i <= Math.min(t + BREAKOUT_WAIT, bars.length - 1); i++) {
			if ((bars[i] as Bar).high >= entry) {
				fill = i;
				entry = Math.max((bars[i] as Bar).open, entry);
				break;
			}
		}
		if (fill < 0) return { filled: false, retPct: 0, r: 0, exit: "time" };
		start = fill;
	}
	const risk = entry - stop;
	if (!(risk > 0)) return null;
	const last = Math.min(start + HOLD[horizon] - 1, bars.length - 1);
	let exitPx = (bars[last] as Bar).close;
	let exit: Trade["exit"] = "time";
	for (let i = start; i <= last; i++) {
		const b = bars[i] as Bar;
		// 돌파 체결일: 체결 뒤 손절만 본다 (같은 날 목표까지 쳤는지는 알 수 없다)
		const fillDay = r.entry.type === "breakout" && i === start;
		if (b.low <= stop) {
			exitPx = fillDay ? stop : Math.min(b.open, stop);
			exit = "stop";
			break;
		}
		if (!fillDay && b.high >= target) {
			exitPx = Math.max(b.open, target);
			exit = "target";
			break;
		}
	}
	const retPct = ((exitPx - entry) / entry) * 100 - COST_PCT;
	return { filled: true, retPct, r: (exitPx - entry - (entry * COST_PCT) / 100) / risk, exit };
}

interface Stat {
	evals: number;
	buys: number;
	trades: Trade[];
	base: Trade[];
	verdicts: Record<string, number>;
	reasons: Record<string, number>;
	/** 매수 근거별 결과 — 어떤 신호가 쓸 만한지 */
	byTrigger: Record<string, Trade[]>;
}
const emptyStat = (): Stat => ({ evals: 0, buys: 0, trades: [], base: [], verdicts: {}, reasons: {}, byTrigger: {} });
const TRIGGERS = ["5·20일선 골든크로스", "MACD 골든크로스", "최근 골든크로스", "과매도 회복", "눌림 반등", "저항 돌파", "RSI 50 회복", "추세 지속"];

function summarize(label: string, s: Stat): string {
	const f = (xs: Trade[]) => {
		const filled = xs.filter((x) => x.filled);
		if (filled.length === 0) return "—";
		const avg = filled.reduce((a, x) => a + x.retPct, 0) / filled.length;
		const avgR = filled.reduce((a, x) => a + x.r, 0) / filled.length;
		const win = filled.filter((x) => x.retPct > 0).length / filled.length;
		const tgt = filled.filter((x) => x.exit === "target").length / filled.length;
		const stp = filled.filter((x) => x.exit === "stop").length / filled.length;
		return (
			`n=${filled.length}${xs.length !== filled.length ? `(미체결 ${xs.length - filled.length})` : ""} ` +
			`평균 ${avg.toFixed(2)}% · ${avgR.toFixed(2)}R · 승률 ${(win * 100).toFixed(0)}% · 목표 ${(tgt * 100).toFixed(0)}% / 손절 ${(stp * 100).toFixed(0)}%`
		);
	};
	return [
		`■ ${label}: 판정 ${s.evals}건 중 매수 ${s.buys}건 (${((s.buys / s.evals) * 100).toFixed(1)}%)`,
		`   매수 신호 → ${f(s.trades)}`,
		`   기준선(매일 매수) → ${f(s.base)}`,
		...Object.entries(s.byTrigger).map(([k, v]) => `     · ${k}: ${f(v)}`),
	].join("\n");
}

async function main(): Promise<void> {
	const refresh = process.argv.includes("--refresh");
	mkdirSync(CACHE, { recursive: true });
	const universe: Array<[string, Market]> = [...US.map((s) => [s, "US"] as [string, Market]), ...KR.map((s) => [s, "KR"] as [string, Market])];

	const stats: Record<string, Stat> = {};
	const get = (k: string) => (stats[k] ??= emptyStat());
	/** 종목별 마지막 판정 (지금 시점) — "오늘 추천하면 몇 개가 나오나" */
	const today: Record<Horizon, string[]> = { swing: [], short: [] };
	let loaded = 0;

	for (const [symbol, market] of universe) {
		const bars = await load(symbol, market, refresh);
		if (!bars || bars.length < WINDOW + 25) {
			console.error(`skip ${symbol} (${bars?.length ?? 0}봉)`);
			continue;
		}
		loaded++;
		for (let t = WINDOW - 1; t < bars.length; t++) {
			const window = bars.slice(t - WINDOW + 1, t + 1);
			for (const horizon of ["swing", "short"] as Horizon[]) {
				const r = evaluateTiming({ bars: window, market, horizon });
				if (!r) continue;
				if (t === bars.length - 1) {
					if (r.verdict === "매수") today[horizon].push(`${symbol}${r.entry.type === "breakout" ? "(돌파)" : ""}`);
					continue;
				}
				if (t > bars.length - 1 - HOLD[horizon]) continue; // 결과를 볼 수 없는 끝부분
				const half = (bars[t] as Bar).date < SPLIT ? "~2025" : "2026~";
				for (const key of [`${horizon}`, `${horizon}/${market}`, `${horizon}/${half}`]) {
					const s = get(key);
					s.evals++;
					s.verdicts[r.verdict] = (s.verdicts[r.verdict] ?? 0) + 1;
					if (r.verdict !== "매수") s.reasons[r.summary.replace(/[\d.,$원%:()]+/g, "#").slice(0, 40)] = (s.reasons[r.summary.replace(/[\d.,$원%:()]+/g, "#").slice(0, 40)] ?? 0) + 1;
					const base = simulate(bars, t, { ...r, entry: { price: r.price, type: "now" } }, horizon);
					if (base) s.base.push(base);
					if (r.verdict === "매수") {
						s.buys++;
						const tr = simulate(bars, t, r, horizon);
						if (tr) {
							s.trades.push(tr);
							for (const tg of TRIGGERS) if (r.summary.includes(tg)) (s.byTrigger[tg] ??= []).push(tr);
						}
					}
				}
			}
		}
	}

	console.log(`종목 ${loaded}개 · 판정 시점마다 직전 ${WINDOW}봉\n`);
	const keys = process.argv.includes("--all") ? ["swing", "swing/US", "swing/KR", "swing/~2025", "swing/2026~", "short", "short/US", "short/KR", "short/~2025", "short/2026~"] : ["swing", "short"];
	for (const k of keys) {
		if (stats[k]) console.log(summarize(k, stats[k]));
	}
	for (const h of ["swing", "short"] as Horizon[]) {
		const s = stats[h];
		if (!s) continue;
		const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
		console.log(`\n${h} 관망·매도 사유 상위:`);
		for (const [r, n] of top) console.log(`   ${((n / s.evals) * 100).toFixed(1)}%  ${r}`);
	}
	console.log(`\n오늘(마지막 봉) 매수 — swing ${today.swing.length}개: ${today.swing.join(", ") || "없음"}`);
	console.log(`                     short ${today.short.length}개: ${today.short.join(", ") || "없음"}`);
}

await main();
