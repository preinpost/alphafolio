/**
 * 주문 확인 카드 계약 (orders.ts) — 서버가 details 로 보내고 웹이 kind 로 골라 그리는 모양.
 *
 * 이 패키지는 타입뿐이라 계약의 절반은 typecheck 가 잡는다 (tsconfig 가 test/ 도 포함한다):
 * 아래 픽스처는 `satisfies` 로 각 카드 타입에 맞아야 컴파일된다. 필드가 바뀌면 여기서 먼저 깨진다.
 * 나머지 절반 — kind 판별자·JSON 왕복·UICard 포함 여부 — 는 런타임으로 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
	BinanceFuturesCard,
	BinanceOrderCard,
	BinanceTransferCard,
	ConditionalOrderCard,
	OrderChangeCard,
	UICard,
} from "../src/index.ts";

const orderChange = {
	kind: "order-change-card",
	ok: true,
	token: "tok",
	expiresAt: 1_700_000_000_000,
	broker: "toss",
	action: "modify",
	symbol: "005930",
	name: "삼성전자",
	currency: "KRW",
	original: { orderId: "1", side: "BUY", orderType: "LIMIT", openQuantity: 3, price: 70000, orderedAt: null },
	after: { orderType: "LIMIT", quantity: 3, price: 69000 },
	warnings: [],
	errors: [],
} satisfies OrderChangeCard;

const conditional = {
	kind: "conditional-order-card",
	ok: true,
	token: "tok",
	expiresAt: 1_700_000_000_000,
	broker: "toss",
	action: "create",
	symbol: "AAPL",
	name: "Apple",
	currency: "USD",
	conditionalOrderId: null,
	type: "OCO",
	quantity: 1,
	orderType: "LIMIT",
	expireDate: "2026-12-31",
	first: { side: "SELL", triggerPrice: 250, orderPrice: 250 },
	second: { side: "SELL", triggerPrice: 200, orderPrice: null },
	currentPrice: 225,
	avgPrice: 210,
	warnings: [],
	errors: [],
} satisfies ConditionalOrderCard;

const transfer = {
	kind: "binance-transfer-card",
	ok: true,
	token: "tok",
	expiresAt: 1_700_000_000_000,
	from: "SPOT",
	to: "EARN",
	asset: "USDT",
	amount: "100.5",
	all: false,
	available: "1000",
	productId: "USDT001",
	api: "POST /sapi/v1/simple-earn/flexible/subscribe",
	warnings: [],
	errors: [],
} satisfies BinanceTransferCard;

const binanceOrder = {
	kind: "binance-order-card",
	market: "stock",
	ok: true,
	token: "tok",
	expiresAt: 1_700_000_000_000,
	action: "place",
	symbol: "AAPLUSDC",
	base: "AAPL",
	quote: "USDC",
	side: "BUY",
	type: "LIMIT",
	quantity: "1",
	quoteQuantity: null,
	price: "225.10",
	estimatedQuote: "225.10",
	lastPrice: "225.00",
	balance: { asset: "USDC", free: "500" },
	minNotional: "5",
	gap: { bid: 224.9, ask: 225.1, underlying: 225, source: "kis", pct: 0, marketCostPct: 0.04, limitCostPct: 0.04, spreadPct: 0.09 },
	original: null,
	lines: [{ label: "가격", text: "225.10", pct: null }],
	orders: [],
	warnings: [],
	errors: [],
} satisfies BinanceOrderCard;

const futures = {
	kind: "binance-futures-card",
	ok: false,
	token: null,
	expiresAt: null,
	action: "open",
	symbol: "BTCUSDT",
	base: "BTC",
	marginAsset: "USDT",
	direction: "LONG",
	type: "MARKET",
	quantity: "0.001",
	price: null,
	notional: "100",
	margin: "20",
	leverage: 5,
	marginType: "ISOLATED",
	liqPrice: "80000",
	markPrice: "100000",
	available: "10",
	takeProfitPrice: null,
	stopLossPrice: null,
	position: null,
	orders: [{ source: "algo", id: 1, side: "SELL", type: "STOP_MARKET", price: "0", triggerPrice: "90000", quantity: "0", closePosition: true }],
	lines: [],
	warnings: [],
	errors: ["증거금 부족"],
} satisfies BinanceFuturesCard;

type OrderCard = OrderChangeCard | ConditionalOrderCard | BinanceTransferCard | BinanceOrderCard | BinanceFuturesCard;

const cards: OrderCard[] = [orderChange, conditional, transfer, binanceOrder, futures];

test("orders.ts 카드 kind 는 서로 다르고 웹이 아는 값이다", () => {
	// 웹 렌더러가 kind 문자열로 분기한다 — 이름이 바뀌면 카드가 조용히 안 그려진다
	assert.deepEqual(
		cards.map((c) => c.kind),
		["order-change-card", "conditional-order-card", "binance-transfer-card", "binance-order-card", "binance-futures-card"],
	);
	assert.equal(new Set(cards.map((c) => c.kind)).size, cards.length);
});

test("JSON 왕복 후에도 같다 (WS·REST 로 그대로 나간다)", () => {
	for (const card of cards) assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
});

test("모든 확인 카드는 실행 토큰 계약을 갖는다 — ok 가 아니면 토큰이 없다", () => {
	for (const card of cards) {
		assert.ok(Array.isArray(card.warnings) && Array.isArray(card.errors));
		if (!card.ok) assert.equal(card.token, null);
	}
});

// 모두 UICard 에 들어 있어야 한다 — 빠지면 이 대입이 컴파일되지 않는다
const asUICards: UICard[] = cards;

test("kind 로 좁히면 카드별 필드를 쓸 수 있다", () => {
	const describe = (card: UICard): string => {
		switch (card.kind) {
			case "order-change-card":
				return `${card.action} ${card.original.orderId}`;
			case "conditional-order-card":
				return `${card.type} ${card.first.triggerPrice}`;
			case "binance-transfer-card":
				return `${card.from}→${card.to}`;
			case "binance-order-card":
				return `${card.market ?? "spot"} ${card.symbol}`;
			case "binance-futures-card":
				return `${card.direction} x${card.leverage}`;
			default:
				return card.kind;
		}
	};
	assert.deepEqual(asUICards.map(describe), ["modify 1", "OCO 250", "SPOT→EARN", "stock AAPLUSDC", "LONG x5"]);
});
