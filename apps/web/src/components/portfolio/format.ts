/** 투자 화면 공용 표기 — 원화·달러·USDT·수량·부호 */
import { compactWon } from "../../lib/portfolio.ts";

export const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;
/** 예수금 — 센트까지 ($1,234.50) */
export const usdCash = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** 코인 평가 — USDT 환산 (스테이블 포함) */
export const usdt = (n: number): string => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
/** 원래 통화 금액 곁에 붙이는 원화 환산 — 환율이 없으면 (0) 빈 문자열 */
export const approxWon = (n: number): string => (n > 0 ? `≈ ${won(n)}` : "");
export const approxShort = (n: number): string => (n > 0 ? `≈ ${compactWon(n)}` : "");
export const money = (n: number, currency: "KRW" | "USD"): string => (currency === "KRW" ? won(n) : usd(n));
/** 모바일 한 칸 — 원화는 만원 단위로 줄이고 달러는 그대로 */
export const shortMoney = (n: number, currency: "KRW" | "USD"): string => (currency === "KRW" ? compactWon(n) : usd(n));
export const signedShort = (n: number, currency: "KRW" | "USD"): string => `${sign(n)}${shortMoney(Math.abs(n), currency)}`;
/** 코인 단가 — 1달러 미만은 유효숫자 4자리 ($0.00001234) */
export const usdPrice = (n: number): string => (n >= 1 ? usd(n) : `$${Number(n.toPrecision(4))}`);
export const qty = (n: number): string => Number(n.toPrecision(8)).toLocaleString("en-US", { maximumFractionDigits: 8 });
export const sign = (n: number): string => (n > 0 ? "+" : n < 0 ? "−" : "");
export const move = (n: number): string => (n > 0 ? "up" : n < 0 ? "down" : "flat");
export const pctOf = (part: number, total: number): string => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");
export const signedPct = (n: number): string => `${sign(n)}${Math.abs(n).toFixed(2)}%`;

/** "10월 8일 14:32" */
export function stamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
