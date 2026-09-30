/**
 * 체결기가 보는 증권사 (PLAN §40 2단계) — 네 동작만: 호가 · 지정가 · 취소 · 주문 상태.
 *
 * 체결기는 증권사 API 를 모른다. 증권사마다 다른 것(IOC 지원, 멱등성 키, 체결 조회 방식)은 어댑터가 숨기고,
 * 체결기가 알아야 하는 차이만 플래그(supportsIoc · idempotent)로 드러낸다.
 *
 * ⚠️ place/cancel 은 **실제 돈을 움직인다.** 켜진 트리거의 신호(주문 실행기)나 사람이 확인한 경로에서만 부른다.
 */
import type { Market, OrderSide } from "../../orders.ts";

/** 체결 시장 — 국장·미장 + 코인 (Binance 현물, 24시간) */
export type VenueMarket = Market | "CRYPTO";

/**
 * 가격·수량 격자 — 체결기·규칙이 가격을 맞추고 수량을 자를 때.
 * 주식은 호가 단위표 · 정수 주 (stockGrid), 코인은 종목마다 거래소 규칙 (tickSize · stepSize · 최소 주문금액).
 */
export interface Grid {
	/** 유효한 가격으로 — down = 그 이하에서 가장 가까운 값, up = 그 이상 */
	roundPrice(price: number, dir: "down" | "up"): number;
	/** 한 호가 위(+1)·아래(−1) */
	stepPrice(price: number, dir: 1 | -1): number;
	/** 수량 단위로 내림 (주식 = 정수 주). 부동소수점 잡음(0.3 − 0.1)을 먼저 걷어 낸다 */
	floorQty(qty: number): number;
	/** 최소 수량 (주식 1) */
	minQty: number;
	/** 최소 주문금액 — 가격 × 수량 (없으면 0) */
	minNotional: number;
	/** 수량 단위 표시 ("주" · "BTC") */
	unit: string;
}

export interface BookLevel {
	price: number;
	volume: number;
}

/** 호가 — bids 는 높은 가격부터, asks 는 낮은 가격부터 (최우선 호가가 [0]) */
export interface Book {
	bids: BookLevel[];
	asks: BookLevel[];
	/** 조회 시각 (epoch ms) */
	at: number;
}

export interface VenuePlace {
	side: OrderSide;
	quantity: number;
	/** 호가 단위에 맞춘 지정가 */
	price: number;
	/** 즉시 체결·잔량 취소 — supportsIoc 인 곳만 */
	ioc: boolean;
	/** 멱등성 키 (최대 36자, 영숫자·-·_) — idempotent 인 곳은 같은 값으로 다시 보내도 주문이 하나다 */
	clientId: string;
}

export interface VenueOrderState {
	filledQty: number;
	/** 체결된 것의 평균가 — 체결이 없으면 null */
	avgPrice: number | null;
	/** 아직 체결될 수 있는가 (미체결 잔량이 살아 있다) */
	open: boolean;
	/** 거부됐으면 이유 */
	rejected?: string;
}

export interface ExecVenue {
	/** 표시용 ("토스 국장", "한국투자 미장") */
	readonly label: string;
	readonly market: VenueMarket;
	readonly symbol: string;
	/** 가격·수량 격자 — 없으면 주식 표 (market 의 호가 단위 · 정수 주) */
	readonly grid?: Grid;
	/** IOC 지정가를 낼 수 있는가 (KIS 국장) */
	readonly supportsIoc: boolean;
	/** 같은 clientId 로 다시 보내면 이전 결과를 돌려주는가 (토스) — 응답을 못 받았을 때 한 번 다시 보낼 수 있다 */
	readonly idempotent: boolean;
	book(): Promise<Book>;
	/** ref = 어댑터가 나중에 취소·조회에 쓸 값 (KIS 조직번호·주문일) — 기록에 남겨 기동 복구 때 adopt 로 되돌린다 */
	place(o: VenuePlace): Promise<{ orderId: string; ref?: string }>;
	cancel(orderId: string): Promise<void>;
	status(orderId: string): Promise<VenueOrderState>;
	/** 기동 복구 — 이전 프로세스가 낸 주문을 이 어댑터가 취소·조회할 수 있게 */
	adopt?(o: { orderId: string; ref: string | null; side: VenuePlace["side"]; quantity: number; price: number }): void;
}

/** 증권사가 **거절했다** (주문이 접수되지 않았다) — 다시 보내도 안전하지만 체결기는 다시 보내지 않고 멈춘다 */
export class VenueRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VenueRejected";
	}
}

/** 보냈는데 결과를 모른다 (연결 끊김·응답 파싱 실패·5xx) — 접수됐을 수도 있다. 멱등성 키가 없으면 다시 보내면 안 된다 */
export class VenueUnknown extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VenueUnknown";
	}
}
