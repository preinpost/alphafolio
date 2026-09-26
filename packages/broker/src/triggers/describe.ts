/** 조건 → 사람이 읽는 한 줄 (카드·목록·텔레그램 공용) */
import type { Clause, Condition, Interval, Op, SeriesName } from "./types.ts";

export const SERIES_LABEL: Readonly<Record<SeriesName, string>> = {
	close: "종가",
	open: "시가",
	high: "고가",
	low: "저가",
	volume: "거래량",
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
	"15m": "15분봉",
	"30m": "30분봉",
	"1h": "1시간봉",
	"4h": "4시간봉",
	"1d": "일봉",
};

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

export function clauseText(c: Clause): string {
	const right = typeof c.right === "number" ? num(c.right) : SERIES_LABEL[c.right];
	if (c.op === "crosses_above" || c.op === "crosses_below") return `${subject(SERIES_LABEL[c.left])} ${right} ${OP_LABEL[c.op]}`;
	return `${SERIES_LABEL[c.left]} ${OP_LABEL[c.op]} ${right}`;
}

/** \"ETHUSDT · 1시간봉 마감 · 종가 < 2,600 그리고 RSI(14) < 30 · 2봉 연속\" */
export function conditionText(c: Condition): string {
	const parts = [`${c.market.symbol} · ${INTERVAL_LABEL[c.interval]} 마감`, c.all.map(clauseText).join(" 그리고 ")];
	if (c.confirmBars > 1) parts.push(`${c.confirmBars}봉 연속`);
	return parts.join(" · ");
}

/** epoch ms → \"09/26 19:00\" (KST) */
export function kstShort(t: number): string {
	const k = new Date(t + 9 * 3_600_000).toISOString();
	return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
}
