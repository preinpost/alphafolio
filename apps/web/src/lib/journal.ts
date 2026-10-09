/**
 * 매매일지 화면의 순수 함수 — 기간 · 금액 표시 · 요약 · 걸러 보기 (테스트: test/journal.test.ts).
 * 요약은 서버 도구(broker/journal/stats.ts)와 같은 규칙이다: 체결 없이 끝난 주문은 세지 않는다.
 */
import type { JournalEntryDto } from "@alphafolio/protocol";

/** 서버가 받는 감정 (broker/journal/types.ts JOURNAL_EMOTIONS 와 같다) */
export const EMOTIONS = ["차분", "확신", "불안", "조급", "욕심", "충동"] as const;

export const BROKER_LABEL: Record<JournalEntryDto["broker"], string> = {
	kis: "한국투자",
	toss: "토스",
	binance: "Binance",
	binance_stock: "Binance 주식",
	other: "기타",
};

export const SOURCE_LABEL: Record<JournalEntryDto["source"], string> = {
	manual: "직접",
	order: "챗 주문",
	auto: "자동 매매",
	import: "계좌 체결",
};

export type PeriodId = "30d" | "90d" | "year" | "all";
export const PERIODS: Array<{ id: PeriodId; label: string }> = [
	{ id: "30d", label: "30일" },
	{ id: "90d", label: "90일" },
	{ id: "year", label: "올해" },
	{ id: "all", label: "전체" },
];

/** 오늘 KST 날짜 */
export const kstToday = (now = Date.now()): string => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);

/** 기간 → 시작일 (KST, 그날 포함). 전체는 undefined */
export function periodFrom(id: PeriodId, today: string): string | undefined {
	const back = (days: number): string => {
		const d = new Date(`${today}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() - days);
		return d.toISOString().slice(0, 10);
	};
	if (id === "30d") return back(29);
	if (id === "90d") return back(89);
	if (id === "year") return `${today.slice(0, 4)}-01-01`;
	return undefined;
}

/** 금액 — 원은 정수, 달러는 센트까지, 코인 등은 그 통화 단위로 */
/** 달러에 묶인 코인 — 1 이상이면 센트까지만 (958.24467 USDT → 958.24 USDT) */
const STABLE = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI"]);

export function money(v: number, currency: string): string {
	if (currency === "KRW") return `${Math.round(v).toLocaleString("ko-KR")}원`;
	if (currency === "USD") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 6 : 2 })}`;
	if (STABLE.has(currency) && Math.abs(v) >= 1) return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
	return `${Number(v.toPrecision(8)).toLocaleString("en-US", { maximumFractionDigits: 8 })} ${currency}`;
}

export const qty = (n: number): string => Number(n.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 8 });

/** 수량 단위 — 코인은 단위 없이, 나머지는 주 */
export const unitOf = (e: Pick<JournalEntryDto, "broker">): string => (e.broker === "binance" ? "" : "주");

/** "10주 @ 71,000원" · 금액 주문 pending 은 "금액 주문" */
export function tradeText(e: Pick<JournalEntryDto, "broker" | "quantity" | "price" | "currency" | "context">): string {
	const q = e.quantity > 0 ? `${qty(e.quantity)}${unitOf(e)}` : e.context?.orderAmount ? `${money(e.context.orderAmount, e.currency)}어치` : "금액 주문";
	return e.price !== null ? `${q} @ ${money(e.price, e.currency)}` : q;
}

/** 체결 금액 — 가격을 모르면 null */
export const amountOf = (e: Pick<JournalEntryDto, "quantity" | "price">): number | null => (e.price !== null && e.quantity > 0 ? e.price * e.quantity : null);

export type Chip = "all" | "missing" | "BUY" | "SELL" | "pending";
export const CHIPS: Array<{ id: Chip; label: string }> = [
	{ id: "all", label: "전체" },
	{ id: "missing", label: "근거 없음" },
	{ id: "BUY", label: "매수" },
	{ id: "SELL", label: "매도" },
	{ id: "pending", label: "체결 확인 전" },
];

/** 칩 · 태그 · 검색어로 거른다 (순수) */
export function filterEntries(list: readonly JournalEntryDto[], f: { chip: Chip; tag: string | null; q: string }): JournalEntryDto[] {
	const needle = f.q.trim().toLowerCase();
	return list.filter((e) => {
		if (f.chip === "missing" && (e.thesis || e.status === "canceled")) return false;
		if ((f.chip === "BUY" || f.chip === "SELL") && e.side !== f.chip) return false;
		if (f.chip === "pending" && e.status !== "pending") return false;
		if (f.tag && !e.tags.includes(f.tag)) return false;
		if (needle && !e.symbol.toLowerCase().includes(needle) && !(e.name ?? "").toLowerCase().includes(needle) && !(e.thesis ?? "").toLowerCase().includes(needle)) return false;
		return true;
	});
}

export interface Summary {
	total: number;
	buys: number;
	sells: number;
	pending: number;
	withThesis: number;
	withReview: number;
	buysWithStop: number;
	tags: Array<{ tag: string; count: number }>;
	emotions: Array<{ emotion: string; count: number }>;
}

export function summarize(list: readonly JournalEntryDto[]): Summary {
	const live = list.filter((e) => e.status !== "canceled");
	const count = (keys: string[]): Array<[string, number]> => {
		const m = new Map<string, number>();
		for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
		return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
	};
	const buys = live.filter((e) => e.side === "BUY");
	return {
		total: live.length,
		buys: buys.length,
		sells: live.length - buys.length,
		pending: live.filter((e) => e.status === "pending").length,
		withThesis: live.filter((e) => e.thesis).length,
		withReview: live.filter((e) => e.review).length,
		buysWithStop: buys.filter((e) => e.stopPrice !== null).length,
		tags: count(live.flatMap((e) => e.tags)).map(([tag, n]) => ({ tag, count: n })),
		emotions: count(live.flatMap((e) => (e.emotion ? [e.emotion] : []))).map(([emotion, n]) => ({ emotion, count: n })),
	};
}

/** "#돌파, 실적  #눌림" → ["돌파", "실적", "눌림"] — 서버 normalizeTags 와 같은 규칙 */
export function parseTags(text: string): string[] {
	const out: string[] = [];
	for (const t of text.split(/[,\s]+/)) {
		const tag = t.trim().replace(/^#+/, "").trim();
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

/** 숫자 입력 — 천 단위 쉼표·공백을 떼고, 비었거나 숫자가 아니면 null */
export function parseNumber(text: string): number | null {
	const t = text.replace(/[,\s]/g, "");
	if (!t) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}
