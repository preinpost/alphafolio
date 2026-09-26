/** 조건 → 사람이 읽는 한 줄 (카드·목록·텔레그램 공용) */
import { refKey, refsOf } from "./condition.ts";
import type { Clause, CondNode, Condition, Field, Interval, Op, SeriesName, ValueRef } from "./types.ts";

export const SERIES_LABEL: Readonly<Record<SeriesName, string>> = {
	close: "종가",
	open: "시가",
	high: "고가",
	low: "저가",
	volume: "거래량",
	vol_chg_pct: "거래량 증가율(직전 봉 대비 %)",
	ma5: "5봉 이평",
	ma20: "20봉 이평",
	ma60: "60봉 이평",
	rsi14: "RSI(14)",
	bb_upper: "볼린저 상단",
	bb_lower: "볼린저 하단",
	atr14: "ATR(14)",
	vol_ratio20: "거래량 배수(20봉 평균 대비)",
};

export const INTERVAL_LABEL: Readonly<Record<Interval, string>> = {
	"1m": "1분봉",
	"5m": "5분봉",
	"10m": "10분봉",
	"15m": "15분봉",
	"30m": "30분봉",
	"1h": "1시간봉",
	"2h": "2시간봉",
	"4h": "4시간봉",
	"1d": "일봉",
	"1w": "주봉",
};

export const VENUE_LABEL: Readonly<Record<Condition["market"]["venue"], string>> = { binance: "Binance", krx: "국장", us: "미장" };

const OP_LABEL: Readonly<Record<Op, string>> = {
	"<": "<",
	">": ">",
	"<=": "≤",
	">=": "≥",
	crosses_above: "상향 돌파",
	crosses_below: "하향 이탈",
};

export function num(v: number): string {
	return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** 받침에 맞춘 주격 조사 — "종가가", "20봉 이평이". 한글로 안 끝나면 숫자는 읽는 소리로, 그 외는 "이(가)" */
export function subject(word: string): string {
	const ch = word.trim().at(-1) ?? "";
	const code = ch.charCodeAt(0);
	let batchim: boolean | null = null;
	if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
	else if (/[0-9]/.test(ch)) batchim = "013678".includes(ch); // 영·일·삼·육·칠·팔
	return batchim === null ? `${word}이(가)` : `${word}${batchim ? "이" : "가"}`;
}

const FIELD_LABEL: Readonly<Record<Field, string>> = { close: "종가", open: "시가", high: "고가", low: "저가", volume: "거래량" };

/** 값 → 한국어 ("50봉 이평 × 1.02", "직전 20봉 최고가", "상대 거래량(같은 시각·10일 평균 대비·누적)") */
export function refText(r: ValueRef): string {
	if (typeof r === "string") return SERIES_LABEL[r];
	const of = (f: Field | undefined, dflt: Field) => (f && f !== dflt ? ` ${FIELD_LABEL[f]}` : "");
	let t: string;
	switch (r.ind) {
		case "sma":
			t = `${r.period}봉 이평${of(r.of, "close")}`;
			break;
		case "ema":
			t = `${r.period}봉 지수이평${of(r.of, "close")}`;
			break;
		case "rsi":
			t = `RSI(${r.period})`;
			break;
		case "highest":
		case "lowest": {
			const off = r.offset ?? 1;
			const range = off === 0 ? `최근 ${r.period}봉` : off === 1 ? `직전 ${r.period}봉` : `${off}봉 전까지 ${r.period}봉`;
			const f = r.of ?? (r.ind === "highest" ? "high" : "low");
			t = `${range} ${r.ind === "highest" ? "최고" : "최저"}${f === "high" || f === "low" ? "가" : ` ${FIELD_LABEL[f]}`}`;
			break;
		}
		case "change_pct":
			t = `${r.period}봉 변동률(%)${of(r.of, "close")}`;
			break;
		case "vol_ratio":
			t = `거래량 배수(직전 ${r.period}봉 평균 대비)`;
			break;
		case "rvol":
			t = `상대 거래량(같은 시각·${r.length ?? 10}일 평균 대비·${r.mode === "regular" ? "봉 하나" : "누적"})`;
			break;
		case "value": {
			const off = r.offset ?? 0;
			t = off === 0 ? refText(r.of) : off === 1 ? `직전 봉 ${refText(r.of)}` : `${off}봉 전 ${refText(r.of)}`;
			break;
		}
	}
	return r.mul !== undefined && r.mul !== 1 ? `${t} × ${num(r.mul)}` : t;
}

export function clauseText(c: Clause): string {
	const right = typeof c.right === "number" ? num(c.right) : refText(c.right);
	if (c.op === "crosses_above" || c.op === "crosses_below") return `${subject(refText(c.left))} ${right} ${OP_LABEL[c.op]}`;
	return `${refText(c.left)} ${OP_LABEL[c.op]} ${right}`;
}

/** 트리 → 한 줄. 안쪽 묶음은 괄호 */
export function nodeText(n: CondNode, inner = false): string {
	if ("op" in n) return clauseText(n);
	if ("all" in n) {
		const t = n.all.map((x) => nodeText(x, true)).join(" 그리고 ");
		return inner && n.all.length > 1 ? `(${t})` : t;
	}
	if ("any" in n) {
		const t = n.any.map((x) => nodeText(x, true)).join(" 또는 ");
		return inner && n.any.length > 1 ? `(${t})` : t;
	}
	return `최근 ${n.within}봉 안에 한 번이라도 [${nodeText(n.cond)}]`;
}

/** \"ETHUSDT · 1시간봉 마감 · 종가 < 2,600 그리고 RSI(14) < 30 · 2봉 연속\" */
export function conditionText(c: Condition): string {
	// 코인은 심볼만으로 알아본다 (ETHUSDT), 주식은 시장을 붙인다 (국장 005930)
	const integrated = c.market.venue === "krx" && c.market.feed?.basis === "integrated" ? " (KRX+NXT 통합)" : "";
	const where = c.market.venue === "binance" ? c.market.symbol : `${VENUE_LABEL[c.market.venue]} ${c.market.symbol}${integrated}`;
	const session = c.session === "extended" ? " (프리·애프터 포함)" : "";
	const parts = [`${where} · ${INTERVAL_LABEL[c.interval]}${session} 마감`, c.all.map((n) => nodeText(n, true)).join(" 그리고 ")];
	if (c.confirmBars > 1) parts.push(`${c.confirmBars}봉 연속`);
	return parts.join(" · ");
}

/** 평가 값(valuesAt) → \"종가 2,594.2 · RSI(14) 28.1 · 50봉 이평 × 1.02 2,650\" */
export function valuesText(c: Condition, values: Record<string, number>): string {
	const label = new Map<string, string>([["close", "종가"]]);
	for (const r of refsOf(c.all)) label.set(refKey(r) + (typeof r !== "string" && r.mul !== undefined ? `x${r.mul}` : ""), refText(r));
	return Object.entries(values)
		.map(([k, v]) => `${label.get(k) ?? k} ${num(Math.round(v * 100) / 100)}`)
		.join(" · ");
}

/** epoch ms → \"09/26 19:00\" (KST) */
export function kstShort(t: number): string {
	const k = new Date(t + 9 * 3_600_000).toISOString();
	return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
}
