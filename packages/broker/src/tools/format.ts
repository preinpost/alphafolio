/** 브로커 툴 공용 금액 표시. 조회·주문 준비에서 같은 통화 표기를 사용한다. */
export const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;
export const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** 예수금처럼 센트까지 보여야 하는 금액 — $1,234.5 가 아니라 $1,234.50 */
export const usdCash = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 원화 예수금 + (있으면) 달러 예수금 — 환산하지 않고 나란히 */
export const cashText = (krw: number, usdAmt: number): string =>
	won(krw) +
	(usdAmt > 0 ? ` · 달러 ${usdCash(usdAmt)} (달러 그대로 말한다 — 미국 주식은 달러로 주문하므로 원화로 환산하지 않는다. 사용자가 환산을 요청할 때만)` : "");

export function money(value: number, currency: "KRW" | "USD"): string {
	return currency === "KRW" ? won(value) : usd(value);
}

/** 거래량 — 주식은 정수, 코인은 소수 수량이라 1,000 미만일 때만 소수를 남긴다 */
export const volumeText = (n: number): string =>
	n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * 거래량 한 줄 — "거래량 1,234,567 (20봉 평균 1,000,000의 1.23배)".
 * 마지막 봉이 진행 중이면 배수가 낮게 나온다고 붙인다 (모델이 "거래량 부족" 으로 읽지 않게).
 */
export function volumeLine(
	s: { volume: number | null; volumeAvg20: number | null; volumeRatio20: number | null },
	lastOpen: boolean,
): string {
	if (s.volume === null) return "";
	return (
		`거래량 ${volumeText(s.volume)}` +
		(s.volumeAvg20 !== null && s.volumeRatio20 !== null
			? ` (20봉 평균 ${volumeText(s.volumeAvg20)}의 ${s.volumeRatio20}배)`
			: "") +
		(lastOpen ? " — 마지막 봉이 진행 중이라 거래량이 덜 쌓였다 (배수가 낮게 나온다 — 거래량 부족으로 해석하지 않는다)" : "")
	);
}

export function signed(n: number, currency: "KRW" | "USD"): string {
	return `${n >= 0 ? "+" : "-"}${money(Math.abs(n), currency)}`;
}
