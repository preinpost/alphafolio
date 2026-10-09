/**
 * 일지 요약 (순수) — 회고의 출발점. 손익은 계산하지 않는다:
 * 매수·매도 짝짓기(평단·선입선출)·수수료·세금·환율이 계좌마다 달라 일지만으로는 틀린 숫자가 나온다.
 * 대신 "기록이 얼마나 채워졌나 · 어떤 태그·감정에서 매매했나" 를 센다.
 */
import type { JournalEntry, JournalSource } from "./types.ts";

export interface JournalStats {
	total: number;
	buys: number;
	sells: number;
	pending: number;
	canceled: number;
	/** 근거를 쓴 체결 · 회고를 쓴 체결 (취소된 것은 세지 않는다) */
	withThesis: number;
	withReview: number;
	/** 손절가를 정해 둔 매수 */
	buysWithStop: number;
	bySource: Record<JournalSource, number>;
	tags: Array<{ tag: string; count: number }>;
	emotions: Array<{ emotion: string; count: number }>;
	symbols: Array<{ symbol: string; name: string | null; count: number }>;
}

const top = <T extends string>(m: Map<T, number>, n: number): Array<[T, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function journalStats(entries: readonly JournalEntry[]): JournalStats {
	const live = entries.filter((e) => e.status !== "canceled");
	const tags = new Map<string, number>();
	const emotions = new Map<string, number>();
	const symbols = new Map<string, number>();
	const names = new Map<string, string | null>();
	const bySource: Record<JournalSource, number> = { manual: 0, order: 0, auto: 0, import: 0 };
	for (const e of live) {
		bySource[e.source] += 1;
		for (const t of e.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
		if (e.emotion) emotions.set(e.emotion, (emotions.get(e.emotion) ?? 0) + 1);
		symbols.set(e.symbol, (symbols.get(e.symbol) ?? 0) + 1);
		if (!names.get(e.symbol) && e.name) names.set(e.symbol, e.name);
	}
	return {
		total: live.length,
		buys: live.filter((e) => e.side === "BUY").length,
		sells: live.filter((e) => e.side === "SELL").length,
		pending: live.filter((e) => e.status === "pending").length,
		canceled: entries.length - live.length,
		withThesis: live.filter((e) => e.thesis).length,
		withReview: live.filter((e) => e.review).length,
		buysWithStop: live.filter((e) => e.side === "BUY" && e.stopPrice !== null).length,
		bySource,
		tags: top(tags, 10).map(([tag, count]) => ({ tag, count })),
		emotions: top(emotions, 10).map(([emotion, count]) => ({ emotion, count })),
		symbols: top(symbols, 10).map(([symbol, count]) => ({ symbol, name: names.get(symbol) ?? null, count })),
	};
}
