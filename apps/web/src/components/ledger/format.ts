/** 가계부 화면 공용 — 금액 표기 · 날짜 · 분류 색 */

export const won = (n: number): string => `${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;
export const compact = (n: number): string => {
	const v = Math.abs(Math.round(n));
	if (v >= 1e8) return `${Number((v / 1e8).toFixed(2)).toLocaleString("ko-KR")}억원`;
	if (v >= 1e4) return `${Number((v / 1e4).toFixed(v >= 1e6 ? 0 : 1)).toLocaleString("ko-KR")}만원`;
	return `${v.toLocaleString("ko-KR")}원`;
};
export const todayKST = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
export const WEEKDAY = "일월화수목금토";

export function monthRange(month: string): { from: string; to: string } {
	const [y, m] = month.split("-").map(Number);
	const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function shiftMonth(month: string, by: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
	return d.toISOString().slice(0, 7);
}

/** 분류 색 — 자주 쓰는 분류는 고정, 나머지는 이름으로 골라 늘 같은 색 */
const CAT_COLOR: Record<string, string> = {
	주거: "var(--d1)",
	식비: "var(--d3)",
	교통: "var(--d4)",
	생활: "var(--d2)",
	통신: "var(--d6)",
	문화: "oklch(0.62 0.09 220)",
	구독: "oklch(0.6 0.08 330)",
	"카페·간식": "oklch(0.66 0.1 60)",
};
const EXTRA = ["oklch(0.6 0.1 140)", "oklch(0.64 0.1 280)", "oklch(0.7 0.09 100)", "oklch(0.58 0.1 200)", "oklch(0.66 0.11 40)"];
export function catColor(cat: string | null): string {
	if (!cat) return "var(--d5)";
	if (CAT_COLOR[cat]) return CAT_COLOR[cat];
	let h = 0;
	for (const ch of cat) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return EXTRA[h % EXTRA.length]!;
}
export const DEFAULT_CATS = ["식비", "카페·간식", "교통", "생활", "주거", "통신", "문화", "구독", "의료", "기타"];
