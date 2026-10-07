/**
 * Binance 지갑(Wallet) — 지갑별 잔고 + 같은 계정 안의 지갑 간 이동.
 *
 * 지갑:
 *   SPOT     현물 지갑          GET  /api/v3/account (LD* 는 Earn 예치 영수증이라 빼고 EARN 에서 원금으로 본다)
 *   FUNDING  펀딩 지갑          POST /sapi/v1/asset/get-funding-asset (POST 지만 조회)
 *   EARN     Simple Earn 유연   GET  /sapi/v1/simple-earn/flexible/position
 *   FUTURES  USDⓈ-M 선물        GET  /fapi/v3/account (free = 옮길 수 있는 수량, locked = 증거금·미실현 몫 — 합이 증거금 잔고)
 *
 * 이동 경로 (같은 계정 내부 — 외부 출금이 아니다):
 *   SPOT ↔ FUNDING     POST /sapi/v1/asset/transfer             type=MAIN_FUNDING | FUNDING_MAIN  (키 권한: Permits Universal Transfer)
 *   SPOT·FUNDING ↔ FUTURES  같은 API                            type=MAIN_UMFUTURE · UMFUTURE_MAIN · FUNDING_UMFUTURE · UMFUTURE_FUNDING
 *   EARN → SPOT        POST /sapi/v1/simple-earn/flexible/redeem    destAccount=SPOT              (키 권한: Spot & Margin Trading)
 *   SPOT·FUNDING → EARN POST /sapi/v1/simple-earn/flexible/subscribe sourceAccount=SPOT | FUND
 *   EARN → FUNDING 은 없다 — 환매는 destAccount=SPOT 만 받는다 (실측 2026-10-05: FUND 는 HTTP 400
 *   "'destAccount' parameter only accepts 'SPOT'"). EARN → SPOT 뒤 SPOT → FUNDING 두 번으로 옮긴다.
 *   EARN ↔ FUTURES 도 없다 — 현물을 거친다.
 *
 * ⚠️ executeWalletTransfer 는 **실제 돈을 움직인다.** 서버의 확인 실행 경로(execute.ts)에서만 호출한다.
 * 이 모듈의 쓰기는 위 세 API 가 전부다 — 출금(withdraw)·서브계정·마진·코인M 선물 이체는 없다.
 * 멱등성 키가 없는 API 라 중복은 토큰 nonce 소비(서버)와 자동 재시도 금지로 막는다.
 * 수량은 문자열 10진수 그대로 (부동소수점 없이, decimal.ts).
 */
import type { BinanceTransferAction, TransferRoute, WalletName } from "../actions.ts";
import { cmpDec, subDec } from "./decimal.ts";
import { futuresAccount } from "./futures.ts";
import { fundingAssets } from "./stocks.ts";
import { BinanceError, signed, type BinanceCreds } from "./trade.ts";

export const WALLETS: readonly WalletName[] = ["SPOT", "FUNDING", "EARN", "FUTURES"];

export const WALLET_LABEL: Record<WalletName, string> = {
	SPOT: "현물(Spot)",
	FUNDING: "펀딩(Funding)",
	EARN: "Earn 유연 예치",
	FUTURES: "선물(USDⓈ-M)",
};

export interface WalletAsset {
	asset: string;
	/** 옮길 수 있는 수량 (API 원문) */
	free: string;
	/** 주문·동결로 묶인 수량 — 옮길 수 없다 */
	locked?: string;
	/** EARN — 유연 상품 ID (환매에 쓴다) · 연이율 · 환매 가능 여부 */
	productId?: string;
	apr?: string;
	canRedeem?: boolean;
}

const positive = (v: unknown): boolean => Number(v) > 0;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export async function spotWallet(c: BinanceCreds): Promise<WalletAsset[]> {
	const r = (await signed("GET", "/api/v3/account", { omitZeroBalances: "true" }, c, "현물 지갑 조회")) as {
		balances?: Array<{ asset: string; free: string; locked: string }>;
	};
	return (r.balances ?? [])
		.filter((b) => !b.asset.startsWith("LD") && (positive(b.free) || positive(b.locked)))
		.map((b) => ({ asset: b.asset, free: b.free, ...(positive(b.locked) ? { locked: b.locked } : {}) }));
}

export async function fundingWallet(c: BinanceCreds): Promise<WalletAsset[]> {
	return (await fundingAssets(c))
		.filter((a) => positive(a.free) || positive(a.locked) || positive(a.freeze))
		.map((a) => {
			const held = Number(a.locked) + Number(a.freeze);
			return { asset: a.asset, free: a.free, ...(held > 0 ? { locked: String(held) } : {}) };
		});
}

export async function earnWallet(c: BinanceCreds, asset?: string): Promise<WalletAsset[]> {
	if (c.testnet) throw new BinanceError("Simple Earn 은 테스트넷이 없습니다 — 실전 키로만 됩니다");
	const r = (await signed("GET", "/sapi/v1/simple-earn/flexible/position", { size: "100", ...(asset ? { asset } : {}) }, c, "Earn 조회")) as {
		rows?: Array<Record<string, unknown>>;
	};
	return (r.rows ?? [])
		.filter((x) => positive(x.totalAmount))
		.map((x) => ({
			asset: str(x.asset),
			free: str(x.totalAmount),
			productId: str(x.productId),
			apr: str(x.latestAnnualPercentageRate),
			canRedeem: x.canRedeem !== false,
		}));
}

/** 선물 지갑 — free 는 지갑 밖으로 옮길 수 있는 수량, 나머지(증거금·미실현 손익)는 locked. 합 = 증거금 잔고 */
export async function futuresWallet(c: BinanceCreds): Promise<WalletAsset[]> {
	const r = await futuresAccount(c);
	return r.assets
		.filter((a) => positive(a.marginBalance) || positive(a.walletBalance))
		.map((a) => {
			const free = positive(a.maxWithdrawAmount) ? a.maxWithdrawAmount : "0";
			const rest = subDec(positive(a.marginBalance) ? a.marginBalance : a.walletBalance, free);
			return { asset: a.asset, free, ...(positive(rest) ? { locked: rest } : {}) };
		});
}

const READERS: Record<WalletName, (c: BinanceCreds) => Promise<WalletAsset[]>> = {
	SPOT: spotWallet,
	FUNDING: fundingWallet,
	EARN: (c) => earnWallet(c),
	FUTURES: futuresWallet,
};

export interface WalletBalances {
	wallet: WalletName;
	assets: WalletAsset[] | null;
	/** 이 지갑만 실패 (키 권한 등) — 나머지는 보여 준다 */
	error?: string;
}

export async function walletBalances(c: BinanceCreds, wallets: readonly WalletName[] = WALLETS): Promise<WalletBalances[]> {
	return Promise.all(
		wallets.map(async (wallet) => {
			try {
				return { wallet, assets: await READERS[wallet](c) };
			} catch (err) {
				return { wallet, assets: null, error: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
}

// ── 이동 경로 (순수) ─────────────────────────────────────────

/** 보내는·받는 지갑 → API. 같은 지갑이거나 EARN → FUNDING(Binance 가 막음)·EARN ↔ FUTURES 면 null */
export function transferRoute(from: WalletName, to: WalletName): TransferRoute | null {
	if (from === to) return null;
	if (from === "SPOT" && to === "FUNDING") return { kind: "universal", type: "MAIN_FUNDING" };
	if (from === "FUNDING" && to === "SPOT") return { kind: "universal", type: "FUNDING_MAIN" };
	if (from === "SPOT" && to === "FUTURES") return { kind: "universal", type: "MAIN_UMFUTURE" };
	if (from === "FUTURES" && to === "SPOT") return { kind: "universal", type: "UMFUTURE_MAIN" };
	if (from === "FUNDING" && to === "FUTURES") return { kind: "universal", type: "FUNDING_UMFUTURE" };
	if (from === "FUTURES" && to === "FUNDING") return { kind: "universal", type: "UMFUTURE_FUNDING" };
	if (from === "FUTURES" || to === "FUTURES") return null;
	if (from === "EARN") return to === "SPOT" ? { kind: "redeem", destAccount: "SPOT" } : null;
	return { kind: "subscribe", sourceAccount: from === "SPOT" ? "SPOT" : "FUND" };
}

export function routeApi(r: TransferRoute): string {
	switch (r.kind) {
		case "universal":
			return `POST /sapi/v1/asset/transfer (type=${r.type})`;
		case "redeem":
			return `POST /sapi/v1/simple-earn/flexible/redeem (destAccount=${r.destAccount})`;
		case "subscribe":
			return `POST /sapi/v1/simple-earn/flexible/subscribe (sourceAccount=${r.sourceAccount})`;
	}
}

/** 유연 예치 상품 — 예치(subscribe)에 쓴다 */
export async function flexibleProduct(c: BinanceCreds, asset: string): Promise<{ productId: string; minAmount: string | null } | null> {
	const r = (await signed("GET", "/sapi/v1/simple-earn/flexible/list", { asset, size: "100" }, c, "Earn 상품 조회")) as {
		rows?: Array<Record<string, unknown>>;
	};
	const row = (r.rows ?? []).find((x) => str(x.asset) === asset && x.canPurchase !== false && x.isSoldOut !== true);
	if (!row) return null;
	return { productId: str(row.productId), minAmount: positive(row.minPurchaseAmount) ? str(row.minPurchaseAmount) : null };
}

// ── 요청 파라미터 (순수) ────────────────────────────────────

export function transferRequest(a: BinanceTransferAction): { path: string; params: Record<string, string> } {
	const r = a.route;
	switch (r.kind) {
		case "universal":
			return { path: "/sapi/v1/asset/transfer", params: { type: r.type, asset: a.asset, amount: a.amount } };
		case "redeem":
			if (!a.productId) throw new BinanceError("Earn 환매에는 상품 ID 가 필요합니다");
			return {
				path: "/sapi/v1/simple-earn/flexible/redeem",
				// 전량은 redeemAll — 이자가 계속 붙어 준비 시점의 수량보다 늘어 있다
				params: { productId: a.productId, ...(a.all ? { redeemAll: "true" } : { amount: a.amount }), destAccount: r.destAccount },
			};
		case "subscribe":
			if (!a.productId) throw new BinanceError("Earn 예치에는 상품 ID 가 필요합니다");
			return { path: "/sapi/v1/simple-earn/flexible/subscribe", params: { productId: a.productId, amount: a.amount, sourceAccount: r.sourceAccount } };
	}
}

/** 수량 형식 — 양의 10진수 문자열만 (지수 표기·음수·쉼표 거절) */
export function validAmount(v: string): boolean {
	return /^\d+(\.\d+)?$/.test(v) && cmpDec(v, "0") > 0;
}

// ── 실행 — **실제 돈을 움직인다** ───────────────────────────

export async function executeWalletTransfer(a: BinanceTransferAction, c: BinanceCreds): Promise<{ message: string; orderId?: string }> {
	const { path, params } = transferRequest(a);
	const r = (await signed("POST", path, params, c, "지갑 이동")) as { tranId?: number; redeemId?: number; purchaseId?: number; success?: boolean };
	if (r && r.success === false) throw new BinanceError("Binance 가 지갑 이동을 거절했습니다 (success=false)");
	const id = r?.tranId ?? r?.redeemId ?? r?.purchaseId;
	const what = a.all ? `${a.asset} 전량` : `${a.amount} ${a.asset}`;
	return {
		message: `${WALLET_LABEL[a.from]} → ${WALLET_LABEL[a.to]} ${what} 이동이 접수되었습니다`,
		...(id !== undefined ? { orderId: String(id) } : {}),
	};
}
