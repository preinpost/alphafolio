/**
 * binance_wallet — Binance 지갑별 잔고 조회 + 지갑 간 이동 **준비**. 이동은 확인 카드에서 사람이.
 *
 * 현물 잔고만 보면 USDT 가 0 인데 Earn·펀딩에 있는 경우가 흔하다 (실측 2026-10-03: 현물 0, Earn 100.71).
 * 그래서 잔고는 지갑별로 함께 보여 주고, 매수 전에 Earn → 현물로 옮기는 동작을 같은 툴에서 준비한다.
 * 가용 수량·Earn 상품 ID 는 준비 단계에서 서버가 Binance 에서 조회한 값이다 (모델 값을 믿지 않는다).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BinanceTransferAction, OrderAction, WalletName } from "../actions.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { cmpDec } from "./decimal.ts";
import type { BinanceCreds } from "./trade.ts";
import { earnWallet, flexibleProduct, fundingWallet, routeApi, spotWallet, transferRoute, validAmount, walletBalances, WALLET_LABEL, WALLETS, type WalletAsset } from "./wallet.ts";

export interface BinanceTransferCard {
	kind: "binance-transfer-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	from: WalletName;
	to: WalletName;
	asset: string;
	/** 옮길 수량 — 전량이면 준비 시점의 이동 가능 수량 */
	amount: string | null;
	all: boolean;
	/** 보내는 지갑의 이동 가능 수량 */
	available: string | null;
	/** Earn 유연 상품 ID (환매·예치) */
	productId: string | null;
	/** 표시용 — 어떤 API 로 나가는지 */
	api: string | null;
	warnings: string[];
	errors: string[];
}

export interface BinanceWalletDetails {
	kind: "binance-wallet";
	wallets: Awaited<ReturnType<typeof walletBalances>>;
}

const trim = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

function connected<T>(get: (() => T) | undefined): T | null {
	if (!get) return null;
	try {
		return get();
	} catch {
		return null;
	}
}

const SOURCE: Record<WalletName, (c: BinanceCreds, asset: string) => Promise<WalletAsset[]>> = {
	SPOT: (c) => spotWallet(c),
	FUNDING: (c) => fundingWallet(c),
	EARN: (c, asset) => earnWallet(c, asset),
};

function balancesText(rows: BinanceWalletDetails["wallets"]): string {
	const lines = ["Binance 지갑별 잔고 (조회 시점):"];
	for (const w of rows) {
		if (w.error) {
			lines.push(`- ${WALLET_LABEL[w.wallet]}: 조회 실패 — ${w.error.slice(0, 120)}`);
			continue;
		}
		const assets = w.assets ?? [];
		if (assets.length === 0) {
			lines.push(`- ${WALLET_LABEL[w.wallet]}: 없음`);
			continue;
		}
		const items = assets.map((a) => {
			const extra = [a.locked ? `묶임 ${trim(a.locked)}` : "", a.apr ? `연 ${(Number(a.apr) * 100).toFixed(2)}%` : "", a.canRedeem === false ? "환매 불가" : ""].filter(Boolean);
			return `${a.asset} ${trim(a.free)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
		});
		lines.push(`- ${WALLET_LABEL[w.wallet]}: ${items.join(" · ")}`);
	}
	lines.push("현물에서 주문하려면 Earn·펀딩의 자산을 현물로 옮겨야 한다 (binance_wallet transfer — 확인 카드).");
	return lines.join("\n");
}

const WalletParam = Type.Union([Type.Literal("SPOT"), Type.Literal("FUNDING"), Type.Literal("EARN")], {
	description: "SPOT=현물 · FUNDING=펀딩 · EARN=Simple Earn 유연 예치",
});

export function createBinanceWalletTool(deps: { brokers: BrokerAccess; prepareOrder?: (a: OrderAction) => { token: string; expiresAt: number } }) {
	return defineTool({
		name: "binance_wallet",
		label: "Binance 지갑",
		description:
			"Binance **지갑별 잔고**와 **지갑 간 이동**(같은 계정 안 — 외부 출금 아님). 지갑: SPOT(현물)·FUNDING(펀딩)·EARN(Simple Earn 유연 예치). " +
			"action=balances: 세 지갑 잔고 (조회만). '바이낸스 잔고·USDT 얼마' 는 이걸로 — 현물이 0 이어도 Earn·펀딩에 있을 수 있다. " +
			"action=transfer: from·to·asset + amount(문자열) 또는 all=true 로 이동을 **준비**한다 (실행하지 않는다 — 확인 카드에서 사용자가 [확인] 해야 옮겨진다). " +
			"경로: SPOT↔FUNDING, EARN→SPOT/FUNDING(환매), SPOT/FUNDING→EARN(예치). 매수 전 Earn 에 있는 USDT 는 EARN→SPOT 으로 옮긴다. " +
			"사용자가 이동을 명시적으로 요청했을 때만 transfer 를 호출한다.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("balances"), Type.Literal("transfer")]),
			from: Type.Optional(WalletParam),
			to: Type.Optional(WalletParam),
			asset: Type.Optional(Type.String({ description: "자산 — 예: USDT" })),
			amount: Type.Optional(Type.String({ description: "옮길 수량 (문자열, 예: '50'). all=true 면 비운다" })),
			all: Type.Optional(Type.Boolean({ description: "보내는 지갑의 이동 가능 전량" })),
		}),
		execute: async (_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: BinanceWalletDetails | BinanceTransferCard }> => {
			const creds = connected(deps.brokers.binance) as BinanceCreds | null;
			if (!creds) throw new Error("Binance 지갑 조회에는 키가 필요합니다 — 설정 → 코인 (Binance).");

			if (params.action === "balances") {
				const wallets = await walletBalances(creds, WALLETS);
				const details: BinanceWalletDetails = { kind: "binance-wallet", wallets };
				return { content: [{ type: "text" as const, text: balancesText(wallets) }], details };
			}

			if (!deps.prepareOrder) throw new Error("이동 기능이 비활성 상태입니다.");
			const from = params.from ?? "SPOT";
			const to = params.to ?? "SPOT";
			const asset = (params.asset ?? "").trim().toUpperCase();
			const all = params.all === true;
			const card: BinanceTransferCard = {
				kind: "binance-transfer-card", ok: false, token: null, expiresAt: null, from, to, asset, amount: null, all,
				available: null, productId: null, api: null, warnings: [], errors: [],
			};
			const fail = () => ({
				content: [{ type: "text" as const, text: `지갑 이동을 준비하지 못했습니다 (${WALLET_LABEL[from]} → ${WALLET_LABEL[to]} ${asset || "?"}).\n${card.errors.map((e) => `- ${e}`).join("\n")}` }],
				details: card,
			});

			if (!params.from || !params.to) card.errors.push("from·to(보내는·받는 지갑)가 필요합니다.");
			if (!/^[A-Z0-9]{1,20}$/.test(asset)) card.errors.push(`자산 이름이 올바르지 않습니다: ${params.asset ?? "(없음)"}`);
			const amountIn = params.amount?.trim();
			if (!all && !amountIn) card.errors.push("amount(수량) 또는 all=true 가 필요합니다.");
			if (!all && amountIn && !validAmount(amountIn)) card.errors.push(`수량이 올바르지 않습니다: ${amountIn}`);
			const route = transferRoute(from, to);
			if (!route) card.errors.push("보내는 지갑과 받는 지갑이 같습니다.");
			if (creds.testnet) card.errors.push("지갑 이동은 테스트넷이 없습니다 — 실전 키로만 됩니다.");
			if (card.errors.length > 0 || !route) return fail();
			card.api = routeApi(route);

			// 보내는 지갑의 이동 가능 수량 — 서버가 조회한 값
			let held: WalletAsset | undefined;
			try {
				held = (await SOURCE[from](creds, asset)).find((a) => a.asset === asset);
			} catch (err) {
				card.errors.push(`${WALLET_LABEL[from]} 지갑을 조회하지 못했습니다: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
				return fail();
			}
			const available = held?.free ?? "0";
			card.available = trim(available);
			if (!(Number(available) > 0)) {
				card.errors.push(`${WALLET_LABEL[from]} 지갑에 옮길 수 있는 ${asset} 이(가) 없습니다.`);
				return fail();
			}
			const amount = all ? available : amountIn!;
			if (cmpDec(amount, available) > 0) card.errors.push(`${WALLET_LABEL[from]} 의 이동 가능 ${asset} 은(는) ${trim(available)} 입니다 (요청 ${amount}).`);
			card.amount = trim(amount);
			if (held?.locked) card.warnings.push(`${asset} ${trim(held.locked)} 은(는) 주문·동결로 묶여 있어 옮길 수 없습니다.`);

			let productId: string | undefined;
			if (route.kind === "redeem") {
				if (!held?.productId) card.errors.push(`${asset} Earn 상품을 찾지 못했습니다.`);
				else if (held.canRedeem === false) card.errors.push(`${asset} Earn 예치분은 지금 환매할 수 없습니다.`);
				productId = held?.productId;
				card.warnings.push("환매한 만큼 Earn 이자가 멈춥니다.");
				if (all) card.warnings.push("전량 환매 — 확인 시점까지 붙은 이자까지 함께 옮겨집니다.");
			} else if (route.kind === "subscribe") {
				const product = await flexibleProduct(creds, asset).catch((err: Error) => {
					card.errors.push(`Earn 상품을 조회하지 못했습니다: ${err.message.slice(0, 120)}`);
					return null;
				});
				if (product === null && card.errors.length === 0) card.errors.push(`${asset} 유연 예치 상품이 없거나 지금 예치할 수 없습니다.`);
				if (product?.minAmount && cmpDec(amount, product.minAmount) < 0) card.errors.push(`${asset} 유연 예치 최소 수량은 ${trim(product.minAmount)} 입니다.`);
				productId = product?.productId;
				card.warnings.push("예치한 자산은 현물 주문에 바로 쓸 수 없습니다 (다시 옮겨야 한다).");
			}
			card.productId = productId ?? null;
			if (card.errors.length > 0) return fail();

			const action: BinanceTransferAction = {
				kind: "binance-transfer", broker: "binance", from, to, asset, amount, all, route,
				...(productId ? { productId } : {}),
			};
			const { token, expiresAt } = deps.prepareOrder(action);
			card.ok = true;
			card.token = token;
			card.expiresAt = expiresAt;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`확인이 필요합니다 — [Binance 지갑 이동] ${WALLET_LABEL[from]} → ${WALLET_LABEL[to]} ${asset} ${all ? `전량(약 ${card.amount})` : card.amount}` +
							` · 이동 가능 ${card.available}. 화면의 확인 버튼을 눌러야 옮겨집니다 (2분 내). 같은 계정 안의 이동이며 외부 출금이 아니다.`,
					},
				],
				details: card,
			};
		},
	});
}
