/**
 * 해외 종목 뉴스 — KIS 해외뉴스종합(제목).
 *
 * 국내 뉴스(국내주식-141)는 종목 필터가 먹지 않아 네이버(market_news)를 쓰지만,
 * 해외뉴스종합은 SYMB + EXCHANGE_CD 로 **종목 필터가 실제로 동작한다** (2026-09 실측).
 * 제목만 온다 — 본문·링크가 없다.
 *
 * 페이지 로직은 조회 함수를 주입받아 조회 없이 테스트한다.
 */
import { OVERSEAS_EXCHANGES } from "./kis/api.ts";
import type { KisResponse } from "./kis/client.ts";

export interface OverseasNewsItem {
	/** 중복 제거 키 */
	key: string;
	/** YYYY-MM-DD (KST) */
	date: string;
	/** HH:MM (KST) */
	time: string;
	title: string;
	/** 자료원 (연합미국, 한국투자증권 …) */
	source: string;
	/** 중분류 (종목리포트, 특징주, 실적공시 …) */
	category: string;
	symbol: string;
	name: string;
	/** 다음 페이지 커서 (원본 형식) */
	rawDate: string;
	rawTime: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** outblock1 → 정규화된 기사 목록. 제목 없는 행은 버린다. */
export function parseOverseasNews(json: KisResponse): OverseasNewsItem[] {
	const rows = Array.isArray(json.outblock1) ? (json.outblock1 as Record<string, unknown>[]) : [];
	const out: OverseasNewsItem[] = [];
	for (const r of rows) {
		const title = str(r.title);
		if (!title) continue;
		const d = str(r.data_dt);
		const t = str(r.data_tm);
		out.push({
			key: str(r.news_key) || `${d}${t}${title}`,
			date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d,
			time: t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t,
			title,
			source: str(r.source),
			category: str(r.class_name),
			symbol: str(r.symb),
			name: str(r.symb_name),
			rawDate: d,
			rawTime: t,
		});
	}
	return out;
}

/** 한 페이지 조회 — 거래소·커서(시각)를 받아 원본 응답을 돌려준다. */
export type OverseasNewsPage = (q: { excd: string; date: string; time: string }) => Promise<KisResponse>;

export interface OverseasNewsResult {
	items: OverseasNewsItem[];
	/** 실제로 찾은 거래소 (종목 지정 시). 전체 조회면 null */
	excd: string | null;
	pages: number;
}

/**
 * 최신순으로 count 건까지 모은다.
 *   - 종목 지정 + 거래소 미지정 → NAS→NYS→AMS 중 첫 페이지가 비지 않은 곳
 *   - 다음 페이지는 마지막 행 시각을 커서로 (경계 행 중복은 key 로 제거)
 *   - 새 행이 없으면 멈춘다 (같은 시각 기사가 한 페이지를 넘으면 커서가 안 움직인다)
 */
export async function collectOverseasNews(
	fetchPage: OverseasNewsPage,
	opts: { symbol?: string; excd?: string; count: number; maxPages?: number },
): Promise<OverseasNewsResult> {
	const maxPages = opts.maxPages ?? 10;
	const excds: readonly string[] = opts.excd ? [opts.excd] : opts.symbol ? OVERSEAS_EXCHANGES : [""];
	let calls = 0;

	for (const excd of excds) {
		const seen = new Set<string>();
		const items: OverseasNewsItem[] = [];
		let date = "";
		let time = "";
		let pages = 0;
		while (items.length < opts.count && pages < maxPages) {
			const batch = parseOverseasNews(await fetchPage({ excd, date, time }));
			pages++;
			calls++;
			const fresh = batch.filter((n) => !seen.has(n.key));
			for (const n of fresh) seen.add(n.key);
			items.push(...fresh);
			const tail = batch.at(-1);
			if (fresh.length === 0 || !tail?.rawDate) break;
			date = tail.rawDate;
			time = tail.rawTime;
		}
		if (items.length > 0) return { items: items.slice(0, opts.count), excd: excd || null, pages };
	}
	return { items: [], excd: null, pages: calls };
}
