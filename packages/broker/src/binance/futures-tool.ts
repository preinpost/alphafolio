/**
 * binance_futures — Binance **USDⓈ-M 선물** 계좌 조회 + 주문 **준비**. 실행은 확인 카드에서 사람이.
 *
 *   account   잔고·증거금·열린 포지션·미체결(익절·손절 포함)·계정 모드 (조회만)
 *   open      진입 (롱 BUY · 숏 SELL) + 레버리지·증거금 방식 + 익절·손절 — futures-prepare.ts
 *   close     청산 (reduceOnly) · tpsl 열린 포지션에 익절·손절 · cancel · cancel_all · settings
 *
 * 검증은 futures-validate.ts (순수), 카드·조회 텍스트는 futures-card.ts, 실행은 futures.ts executeFutures.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { OrderAction } from "../actions.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { accountText, type BinanceFuturesAccountDetails, type BinanceFuturesCard } from "./futures-card.ts";
import { prepareCancel, prepareClose, prepareOpen, prepareSettings, prepareTpsl, type FuturesParams, type PrepareDeps } from "./futures-prepare.ts";
import { futuresAccount, futuresHedgeMode, futuresMultiAssets, futuresOpenOrders, futuresPositions } from "./futures.ts";
import type { BinanceCreds } from "./trade.ts";

function connected<T>(get: (() => T) | undefined): T | null {
	if (!get) return null;
	try {
		return get();
	} catch {
		return null;
	}
}

const normSymbol = (s: string): string => s.trim().toUpperCase().replace(/[/\s_-]/g, "");
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 한 곳이 실패해도 나머지는 보여 준다 (선물 권한이 없으면 전부 -2015) */
async function account(c: BinanceCreds, symbol: string | undefined): Promise<BinanceFuturesAccountDetails> {
	const warnings: string[] = [];
	const soft = <T>(label: string, p: Promise<T>): Promise<T | null> =>
		p.catch((err) => {
			warnings.push(`${label} 실패: ${why(err)}`);
			return null;
		});
	const [acc, positions, orders, hedge, multiAssets] = await Promise.all([
		soft("선물 계좌", futuresAccount(c)),
		soft("포지션", futuresPositions(c, symbol)),
		soft("미체결", futuresOpenOrders(c, symbol)),
		soft("포지션 모드", futuresHedgeMode(c)),
		soft("멀티에셋 모드", futuresMultiAssets(c)),
	]);
	if (warnings.some((w) => /permissions|-2015/i.test(w))) warnings.push("키에 선물 권한(Enable Futures)이 없거나 허용 IP 밖일 수 있습니다 — Binance API 관리에서 확인하세요.");
	return { kind: "binance-futures-account", account: acc, positions, orders, hedge, multiAssets, warnings };
}

export function createBinanceFuturesTool(deps: { brokers: BrokerAccess; prepareOrder?: (a: OrderAction) => { token: string; expiresAt: number } }) {
	return defineTool({
		name: "binance_futures",
		label: "Binance 선물",
		description:
			"Binance **USDⓈ-M 선물**(무기한 BTCUSDT 등) 조회와 주문 **준비** (주문은 실행하지 않는다 — 확인 카드에서 사용자가 [확인] 해야 나간다). " +
			"action: account(잔고·증거금·포지션·미체결·모드 — 조회만, symbol 선택) / " +
			"open(진입: side BUY=롱·SELL=숏, type, 크기는 quantity(코인 수량)·notional(포지션 크기 USDT)·margin(넣을 증거금 USDT) 중 하나, LIMIT 은 price, " +
			"leverage·marginType(ISOLATED 격리·CROSSED 교차, 비우면 지금 설정), takeProfitPrice·stopLossPrice 를 함께 걸 수 있다) / " +
			"close(청산: type 기본 MARKET, quantity 비우면 전량) / tpsl(열린 포지션에 익절·손절 — 포지션 전체를 시장가로 닫는 조건) / " +
			"cancel(orderId 일반 · algoId 익절·손절 등 조건부 — 모르면 비우고 불러 목록을 받는다) / cancel_all / settings(leverage·marginType 만 바꾼다). " +
			"양방향(Hedge) 모드에서 close·tpsl 은 positionSide(LONG·SHORT)로 고른다. 증거금이 선물 지갑에 없으면 binance_wallet 으로 SPOT→FUTURES 이동을 먼저. " +
			"레버리지·크기를 사용자가 정하지 않았으면 추측하지 말고 묻는다. 사용자가 명시적으로 요청했을 때만 open·close 등을 준비한다.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("account"), Type.Literal("open"), Type.Literal("close"), Type.Literal("tpsl"),
				Type.Literal("cancel"), Type.Literal("cancel_all"), Type.Literal("settings"),
			]),
			symbol: Type.Optional(Type.String({ description: "선물 심볼 — 예: BTCUSDT (account 외에는 필수)" })),
			side: Type.Optional(Type.Union([Type.Literal("BUY"), Type.Literal("SELL")], { description: "open — BUY=롱, SELL=숏" })),
			type: Type.Optional(Type.Union([Type.Literal("LIMIT"), Type.Literal("MARKET")])),
			quantity: Type.Optional(Type.String({ description: "코인 수량 (문자열, 예 '0.002')" })),
			notional: Type.Optional(Type.String({ description: "open — 포지션 크기 (증거금 자산, 예 '200' USDT)" })),
			margin: Type.Optional(Type.String({ description: "open — 넣을 증거금 (예 '20' USDT → 크기 = 증거금 × 레버리지)" })),
			price: Type.Optional(Type.String({ description: "지정가" })),
			leverage: Type.Optional(Type.Integer({ description: "레버리지 (정수, 종목 최대 이하)" })),
			marginType: Type.Optional(Type.Union([Type.Literal("ISOLATED"), Type.Literal("CROSSED")], { description: "ISOLATED=격리 · CROSSED=교차" })),
			takeProfitPrice: Type.Optional(Type.String({ description: "익절 트리거 가격 (표시가격 기준)" })),
			stopLossPrice: Type.Optional(Type.String({ description: "손절 트리거 가격 (표시가격 기준)" })),
			positionSide: Type.Optional(Type.Union([Type.Literal("LONG"), Type.Literal("SHORT")], { description: "양방향 모드의 close·tpsl 대상" })),
			orderId: Type.Optional(Type.Number({ description: "cancel — 일반 주문 번호" })),
			algoId: Type.Optional(Type.Number({ description: "cancel — 조건부(익절·손절) 주문 번호" })),
		}),
		execute: async (_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: BinanceFuturesAccountDetails | BinanceFuturesCard }> => {
			const creds = connected(deps.brokers.binance) as BinanceCreds | null;
			if (!creds) throw new Error("Binance 선물에는 키가 필요합니다 — 설정 → 코인 (Binance) (선물 권한 켜고, 출금 권한 없이).");
			const symbol = params.symbol ? normSymbol(params.symbol) : undefined;

			if (params.action === "account") {
				const details = await account(creds, symbol);
				return { content: [{ type: "text" as const, text: accountText(details) }], details };
			}

			if (!deps.prepareOrder) throw new Error("주문 기능이 비활성 상태입니다.");
			if (!symbol) throw new Error(`${params.action} 에는 symbol 이 필요합니다 (예: BTCUSDT).`);
			const p: FuturesParams = { ...params, symbol };
			const prep: PrepareDeps = { creds, prepareOrder: deps.prepareOrder };
			switch (params.action) {
				case "open":
					return prepareOpen(p, prep);
				case "close":
					return prepareClose(p, prep);
				case "tpsl":
					return prepareTpsl(p, prep);
				case "cancel":
					return prepareCancel(p, prep, false);
				case "cancel_all":
					return prepareCancel(p, prep, true);
				case "settings":
					return prepareSettings(p, prep);
			}
		},
	});
}
