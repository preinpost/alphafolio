/**
 * 투자 화면 계산 — 추이·변동·같은 종목 합치기. DOM·React 없이 순수 함수만 (test/portfolio.test.ts).
 *
 * 금액 환산은 서버가 한다. 여기서는 이미 원화로 바뀐 값만 더하고 비교한다.
 */
import type { BrokerHolding, PortfolioDto, PortfolioSnapshotDto } from "@alphafolio/protocol";

export interface HistoryPoint {
	date: string;
	/** 총자산 — 0011 이전 행은 주식 + 원화 예수금(totalKrw) */
	value: number;
	/** 계좌 구성 ("binance,toss") — 바뀐 날은 입출금이 아니라 계좌 추가·제거로 값이 뛴다 */
	composition: string;
	/** 계좌 하나가 통째로 빠진 날 (조회 실패) — 값이 낮게 찍혀 있다 */
	partial: boolean;
}

const counted = (status: string): boolean => status === "ok" || status === "partial";

/** 지금 화면의 계좌 구성 — 스냅샷과 같은 규칙 */
export function compositionOf(sources: PortfolioDto["sources"]): string {
	return sources
		.filter((s) => counted(s.status))
		.map((s) => s.id)
		.sort()
		.join(",");
}

export function historySeries(items: readonly PortfolioSnapshotDto[]): HistoryPoint[] {
	return items.map((s) => ({
		date: s.date,
		value: s.netKrw ?? s.totalKrw,
		// 0011 이전 행은 총자산이 아니라 증권(주식 + 원화 예수금)만이라 구성이 다르다
		composition: s.sources && s.netKrw !== null ? compositionOf(s.sources as PortfolioDto["sources"]) : `legacy:${[...s.brokers].sort().join(",")}`,
		partial: (s.sources ?? []).some((x) => x.status === "failed"),
	}));
}

/** 계좌 구성이 바뀐 점의 인덱스 (그 점부터 새 구성) */
export function compositionBreaks(points: readonly HistoryPoint[]): number[] {
	const out: number[] = [];
	for (let i = 1; i < points.length; i++) if (points[i]!.composition !== points[i - 1]!.composition) out.push(i);
	return out;
}

export interface Change {
	base: number;
	baseDate: string;
	diff: number;
	pct: number;
}

/**
 * 지금 총자산과 `before` 이전 마지막 스냅샷의 차이. 계좌 구성이 다르거나 일부가 빠진 점이면 null —
 * 계좌를 새로 붙인 걸 "올랐다"고 보여 주면 안 된다. 입출금도 변동에 들어간다 (수익률이 아니다).
 */
export function changeSince(points: readonly HistoryPoint[], current: number, composition: string, before: string): Change | null {
	let base: HistoryPoint | undefined;
	for (const p of points) if (p.date < before) base = p;
	if (!base || base.partial || base.composition !== composition || base.value <= 0) return null;
	const diff = current - base.value;
	return { base: base.value, baseDate: base.date, diff, pct: Math.round((diff / base.value) * 10000) / 100 };
}

export interface GroupedHolding {
	key: string;
	symbol: string;
	name: string;
	market: BrokerHolding["market"];
	currency: BrokerHolding["currency"];
	quantity: number;
	/** 평가금액 (원래 통화 — 같은 통화끼리만 묶으므로 더할 수 있다) */
	value: number;
	valueKrw: number;
	/** 평단을 아는 잔고만으로 계산 — 하나도 모르면 null */
	profitPct: number | null;
	brokers: string[];
	/** 원래 잔고 (계좌별) */
	parts: BrokerHolding[];
}

/** 같은 종목(시장·통화·심볼)을 계좌와 상관없이 합친다 — 평가금액 순 */
export function groupHoldings(holdings: readonly BrokerHolding[]): GroupedHolding[] {
	const by = new Map<string, BrokerHolding[]>();
	for (const h of holdings) {
		const key = `${h.market}:${h.currency}:${h.symbol.toUpperCase()}`;
		by.set(key, [...(by.get(key) ?? []), h]);
	}
	return [...by.entries()]
		.map(([key, parts]): GroupedHolding => {
			const known = parts.filter((h) => h.avgPrice > 0);
			const cost = known.reduce((s, h) => s + h.quantity * h.avgPrice, 0);
			const value = known.reduce((s, h) => s + h.value, 0);
			const first = parts[0]!;
			return {
				key,
				symbol: first.symbol,
				// 증권사가 준 이름을 쓴다 (Binance 는 이름이 없어 심볼)
				name: parts.find((h) => h.name && h.name !== h.symbol)?.name ?? first.name,
				market: first.market,
				currency: first.currency,
				quantity: Number(parts.reduce((s, h) => s + h.quantity, 0).toPrecision(12)),
				value: Math.round(parts.reduce((s, h) => s + h.value, 0) * 100) / 100,
				valueKrw: parts.reduce((s, h) => s + h.valueKrw, 0),
				profitPct: cost > 0 ? Math.round(((value - cost) / cost) * 10000) / 100 : null,
				brokers: [...new Set(parts.map((h) => h.broker))],
				parts,
			};
		})
		.sort((a, b) => b.valueKrw - a.valueKrw);
}

/** KST 날짜 (YYYY-MM-DD) */
export function kstDate(now: Date = new Date()): string {
	return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** n일 전 (KST 날짜 문자열 기준) */
export function daysBefore(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

/** 원화 환산을 짧게 (모바일 한 줄용) — 1만 이상은 만원, 1억 이상은 억원. 100만 이상은 만 단위 정수, 그 아래는 소수 한 자리 */
export function compactWon(n: number): string {
	const v = Math.round(n);
	if (Math.abs(v) >= 1e8) return `${Number((v / 1e8).toFixed(2)).toLocaleString("ko-KR")}억원`;
	if (Math.abs(v) >= 1e4) return `${Number((v / 1e4).toFixed(Math.abs(v) >= 1e6 ? 0 : 1)).toLocaleString("ko-KR")}만원`;
	return `${v.toLocaleString("ko-KR")}원`;
}
