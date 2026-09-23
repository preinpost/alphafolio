/**
 * 주문 검증 — 브로커 중립, **순수 함수**.
 *
 * 실제 주문은 돈이 나가서 마음 편히 테스트할 수 없다. 그래서 네트워크가 필요 없는
 * 검증·계산을 최대한 이 파일로 끌어와 단위 테스트로 덮는다.
 * (거래소가 거절할 주문을 미리 잡는 것이 목적 — 거절 자체는 손실이 아니지만,
 *  "왜 안 되지"를 사람이 장중에 헤매게 만드는 게 비용이다)
 */

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type Market = "KR" | "US";

export interface OrderIntent {
	symbol: string;
	side: OrderSide;
	orderType: OrderType;
	/** 주 단위 */
	quantity: number;
	/** 지정가일 때만 */
	price?: number;
}

export interface OrderContext {
	market: Market;
	currency: "KRW" | "USD";
	/** 현재가 — 시장가 예상금액 계산과 지정가 괴리 경고에 쓴다 */
	lastPrice: number;
	/** 매수 가능 금액 (해당 통화) — 모르면 생략 */
	buyingPower?: number;
	/** 매도 가능 수량 — 모르면 생략 */
	sellable?: number;
}

export interface ValidationResult {
	ok: boolean;
	/** 주문을 막는 문제 */
	errors: string[];
	/** 진행은 가능하지만 사람이 알아야 하는 것 */
	warnings: string[];
	/** 호가단위에 맞춰 보정된 가격 (지정가일 때) */
	normalizedPrice?: number;
	/** 예상 체결 금액 (수수료 제외) */
	estimatedAmount: number;
}

/**
 * KRX 호가단위 (2023-01 개정, 코스피·코스닥 동일).
 * 틀린 가격으로 주문하면 거래소가 거절한다.
 */
const KRX_TICKS: Array<{ under: number; tick: number }> = [
	{ under: 2_000, tick: 1 },
	{ under: 5_000, tick: 5 },
	{ under: 20_000, tick: 10 },
	{ under: 50_000, tick: 50 },
	{ under: 200_000, tick: 100 },
	{ under: 500_000, tick: 500 },
	{ under: Number.POSITIVE_INFINITY, tick: 1_000 },
];

export function tickSize(market: Market, price: number): number {
	if (market === "US") return 0.01; // $1 미만은 0.0001 이지만 보수적으로 0.01 을 쓴다
	return KRX_TICKS.find((t) => price < t.under)?.tick ?? 1_000;
}

/** 호가단위에 맞춰 내림한다 (매수·매도 모두 — 올림은 의도치 않게 비싸게 산다). */
export function roundToTick(market: Market, price: number): number {
	if (market === "US") {
		// 센트 정수로 계산한다. price / 0.01 로 나누면 4.35 가 434.99999… 가 되어 floor 가 1센트를 깎았다
		// ($1~$1,000 센트 가격의 9% — 사용자가 넣은 지정가가 조용히 1센트 내려갔다). 마이크로달러로 먼저
		// 반올림해 부동소수점 잡음을 없앤 뒤 센트로 내림한다.
		const micros = Math.round(price * 1_000_000);
		return Math.floor(micros / 10_000) / 100;
	}
	const tick = tickSize(market, price);
	return Math.floor(price / tick) * tick;
}

export function isOnTick(market: Market, price: number): boolean {
	return Math.abs(price - roundToTick(market, price)) < 1e-9;
}

/** 지정가가 현재가에서 얼마나 떨어져 있는지 (%) */
export function priceDeviationPct(price: number, lastPrice: number): number {
	if (lastPrice <= 0) return 0;
	return Math.round(((price - lastPrice) / lastPrice) * 10000) / 100;
}

/** 지정가 괴리 경고 임계치 — 오타(0 하나 더/덜)를 잡는 목적 */
const DEVIATION_WARN_PCT = 10;
/** 이 이상 벌어지면 오타로 보고 막는다 */
const DEVIATION_BLOCK_PCT = 50;

export function validateOrder(intent: OrderIntent, ctx: OrderContext): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 현재가를 모르면 괴리율 검사(자릿수 오타 방어)와 시장가 예상금액이 전부 무의미해진다.
	// 시세 조회 쪽에서 막고 있지만(QuoteNotFoundError) 여기서도 한 번 더 막는다.
	if (!Number.isFinite(ctx.lastPrice) || ctx.lastPrice <= 0) {
		return {
			ok: false,
			errors: ["현재가를 확인할 수 없어 주문을 준비할 수 없습니다 (종목코드를 확인하세요)."],
			warnings,
			estimatedAmount: 0,
		};
	}

	// ── 수량 ────────────────────────────────────────────────────
	if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) {
		errors.push("수량은 1주 이상이어야 합니다.");
	} else if (!Number.isInteger(intent.quantity)) {
		// 소수점 수량은 미국 시장가 매도에만 허용된다 (그 외는 거래소가 거절)
		if (!(ctx.market === "US" && intent.orderType === "MARKET" && intent.side === "SELL")) {
			errors.push("소수점 수량은 미국 주식 시장가 매도에서만 가능합니다.");
		}
	}

	// ── 가격 ────────────────────────────────────────────────────
	let normalizedPrice: number | undefined;

	if (intent.orderType === "LIMIT") {
		if (intent.price === undefined || !Number.isFinite(intent.price) || intent.price <= 0) {
			errors.push("지정가 주문에는 0보다 큰 가격이 필요합니다.");
		} else {
			normalizedPrice = intent.price;

			if (!isOnTick(ctx.market, intent.price)) {
				normalizedPrice = roundToTick(ctx.market, intent.price);
				warnings.push(
					`호가단위(${tickSize(ctx.market, intent.price).toLocaleString("ko-KR")})에 맞춰 ` +
						`${intent.price.toLocaleString("ko-KR")} → ${normalizedPrice.toLocaleString("ko-KR")} 로 조정했습니다.`,
				);
			}

			const dev = priceDeviationPct(normalizedPrice, ctx.lastPrice);
			if (Math.abs(dev) >= DEVIATION_BLOCK_PCT) {
				// 자릿수 실수는 여기서 거의 다 걸린다
				errors.push(
					`지정가가 현재가(${ctx.lastPrice.toLocaleString("ko-KR")})와 ${dev}% 차이납니다. ` +
						`자릿수를 확인하세요.`,
				);
			} else if (Math.abs(dev) >= DEVIATION_WARN_PCT) {
				warnings.push(`지정가가 현재가와 ${dev}% 차이납니다.`);
			}
		}
	} else if (intent.price !== undefined) {
		warnings.push("시장가 주문이라 입력한 가격은 무시됩니다.");
	}

	// ── 예상 금액 ────────────────────────────────────────────────
	const unit = intent.orderType === "LIMIT" ? (normalizedPrice ?? 0) : ctx.lastPrice;
	const estimatedAmount = unit * (Number.isFinite(intent.quantity) ? intent.quantity : 0);

	// ── 잔고 ────────────────────────────────────────────────────
	if (intent.side === "BUY" && ctx.buyingPower !== undefined) {
		if (estimatedAmount > ctx.buyingPower) {
			errors.push(
				`매수 가능 금액을 초과합니다 (예상 ${Math.round(estimatedAmount).toLocaleString("ko-KR")} > ` +
					`가능 ${Math.round(ctx.buyingPower).toLocaleString("ko-KR")}).`,
			);
		} else if (intent.orderType === "MARKET" && estimatedAmount > ctx.buyingPower * 0.95) {
			// 시장가는 현재가보다 비싸게 체결될 수 있다
			warnings.push("시장가는 현재가보다 높게 체결될 수 있어 매수 가능 금액을 넘길 여지가 있습니다.");
		}
	}

	if (intent.side === "SELL" && ctx.sellable !== undefined && intent.quantity > ctx.sellable) {
		errors.push(`매도 가능 수량을 초과합니다 (요청 ${intent.quantity} > 가능 ${ctx.sellable}).`);
	}

	if (intent.orderType === "MARKET") {
		warnings.push("시장가 주문은 체결 가격이 예상과 다를 수 있습니다.");
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		...(normalizedPrice !== undefined ? { normalizedPrice } : {}),
		estimatedAmount,
	};
}

/** 종목 심볼로 시장 판별 (국내 6자리 코드 / 그 외 해외 티커). */
export function marketOf(symbol: string): Market {
	return /^\d{6}$/.test(symbol.trim()) ? "KR" : "US";
}
