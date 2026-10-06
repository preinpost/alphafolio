/** 감시·반복매매 도구가 공유하는 시장 선택과 목록 표시. 도구 팩터리에 의존하지 않는다. */
import { kstShort } from "./describe.ts";
import type { StockFeed, TriggerState, Venue } from "./types.ts";
import type { WatchSummary } from "./tool.ts";

/** 출처마다 가격·거래량 기준이 다르므로 준비할 때 하나로 고정한다. */
export function chooseFeed(venue: "krx" | "us", has: { kis: boolean; toss: boolean }, basis?: "krx" | "integrated"): StockFeed {
	if (!has.kis && !has.toss) throw new Error("주식 감시에는 증권 키가 필요합니다 — 설정 → 연결 → 증권 (한국투자 또는 토스)");
	if (venue === "us") return { provider: has.kis ? "kis" : "toss" };
	const selectedBasis = basis ?? (has.kis ? "krx" : "integrated");
	if (selectedBasis === "krx") {
		if (!has.kis) throw new Error("KRX 정규장 기준 시세는 한국투자 키가 필요합니다 — 토스는 KRX+NXT 통합 시세뿐입니다 (basis: 'integrated' 로 준비할 수 있다)");
		return { provider: "kis", basis: "krx" };
	}
	return { provider: has.kis ? "kis" : "toss", basis: "integrated" };
}

/** 국장 코드, 코인 거래쌍, 미장 티커 순으로 추정한다. */
export function guessVenue(symbol: string): Venue {
	if (/^\d{6}$|^\d{4}[A-Z0-9]\d$/.test(symbol)) return "krx";
	if (/^[A-Z0-9]{2,}(USDT|USDC|FDUSD|BTC|ETH|BNB|KRW)$/.test(symbol) && symbol.length >= 6) return "binance";
	return "us";
}

const STATE_LABEL: Readonly<Record<TriggerState, string>> = {
	armed: "켜짐", paused: "일시정지", done: "소진", expired: "만료", off: "꺼짐",
};

export function summaryLine(watch: WatchSummary): string {
	const bits = [
		STATE_LABEL[watch.state],
		`발동 ${watch.fires}${watch.maxFires ? `/${watch.maxFires}` : ""}회`,
		watch.repeat ? "정지할 때까지 반복" : `만료 ${watch.expiresAt.slice(0, 10)}`,
	];
	if (watch.lastFiredAt) bits.push(`마지막 발동 ${kstShort(watch.lastFiredAt)}`);
	if (watch.state === "armed" && watch.nextEvalAt) bits.push(`다음 평가 ${kstShort(watch.nextEvalAt)}`);
	const order = watch.order ? `\n  → 자동 ${watch.order}` : "";
	return `- ${watch.id} · ${watch.name} — ${watch.text}${order}\n  ${bits.join(" · ")}`;
}
