/**
 * 한국투자증권 주문 — 국내·미국 주식 현금 주문, 정정·취소, 그리고 주문 전 검증용 조회 (PLAN §34).
 *
 * ⚠️ place/modify/cancel 은 **실제 돈을 움직인다.** 서버의 확인 실행 경로(execute.ts)에서만 호출한다.
 *
 * 요청 본문은 순수 함수(*Body)로 만든다 — 테스트가 TR ID·본문을 한 글자씩 검사할 수 있게.
 * 조회는 범용 게이트웨이(gateway.ts)로 한다 — 규격 검증·계좌 주입이 같은 경로를 탄다.
 *
 * 규격에서 확인한 제약:
 *   - 국내: 매수 TTTC0012U · 매도 TTTC0011U. 지정가 00 / 시장가 01 (시장가 단가 "0")
 *   - 미국: 매수 TTTT1002U · 매도 TTTT1006U. **지정가(00)만** — KIS 미국 주식에는 일반 시장가가 없다
 *   - 정정·취소: 국내 TTTC0013U (한국거래소전송주문조직번호 필요) · 미국 TTTT1004U (취소 단가 "0")
 *   - 본문 키는 대문자, 값은 문자열
 */
import type { CancelAction, KisOrderExchange, ModifyAction, OriginalOrder, PlaceAction } from "../actions.ts";
import type { OrderSide } from "../orders.ts";
import { accountParams, kisPost, type KisContext, type KisResponse } from "./client.ts";
import { callKisApi } from "./gateway.ts";
import { overseasPriceAuto } from "./api.ts";

type Account = { CANO: string; ACNT_PRDT_CD: string };

const DOMESTIC_ORDER = "/uapi/domestic-stock/v1/trading/order-cash";
const DOMESTIC_RVSECNCL = "/uapi/domestic-stock/v1/trading/order-rvsecncl";
const OVERSEAS_ORDER = "/uapi/overseas-stock/v1/trading/order";
const OVERSEAS_RVSECNCL = "/uapi/overseas-stock/v1/trading/order-rvsecncl";

/** 시세 조회용 거래소(NAS/NYS/AMS) → 주문용 거래소(NASD/NYSE/AMEX) */
export function toOrderExchange(excd: string): KisOrderExchange {
	const m: Record<string, KisOrderExchange> = { NAS: "NASD", NYS: "NYSE", AMS: "AMEX", NASD: "NASD", NYSE: "NYSE", AMEX: "AMEX" };
	const hit = m[excd.toUpperCase()];
	if (!hit) throw new Error(`KIS 주문을 지원하지 않는 거래소: ${excd} (미국 NASD·NYSE·AMEX 만)`);
	return hit;
}

/** 미국 종목의 주문용 거래소 — 시세 조회로 상장 거래소를 찾는다 */
export async function kisOrderExchange(ctx: KisContext, symbol: string): Promise<KisOrderExchange> {
	const { excd } = await overseasPriceAuto(ctx, symbol);
	return toOrderExchange(excd);
}

export function kisPlaceTrId(market: "KR" | "US", side: OrderSide): string {
	if (market === "KR") return side === "BUY" ? "TTTC0012U" : "TTTC0011U";
	return side === "BUY" ? "TTTT1002U" : "TTTT1006U";
}

const n = (v: number): string => String(v);

export function kisPlaceBody(a: PlaceAction, acct: Account): { path: string; trId: string; body: Record<string, string> } {
	if (a.market === "KR") {
		return {
			path: DOMESTIC_ORDER,
			trId: kisPlaceTrId("KR", a.side),
			body: {
				...acct,
				PDNO: a.symbol,
				ORD_DVSN: a.orderType === "MARKET" ? "01" : "00",
				ORD_QTY: n(a.quantity),
				ORD_UNPR: a.orderType === "MARKET" ? "0" : n(a.price ?? 0),
			},
		};
	}
	if (a.orderType !== "LIMIT" || a.price === undefined) throw new Error("KIS 미국 주식은 지정가 주문만 지원합니다.");
	if (!a.excd) throw new Error("KIS 미국 주문에 거래소 코드가 없습니다.");
	return {
		path: OVERSEAS_ORDER,
		trId: kisPlaceTrId("US", a.side),
		body: {
			...acct,
			OVRS_EXCG_CD: a.excd,
			PDNO: a.symbol,
			ORD_QTY: n(a.quantity),
			OVRS_ORD_UNPR: n(a.price),
			ORD_SVR_DVSN_CD: "0",
			ORD_DVSN: "00",
			// 매도만 "00", 매수는 빈 값 (규격: "제거 : 매수")
			...(a.side === "SELL" ? { SLL_TYPE: "00" } : {}),
		},
	};
}

export function kisChangeBody(
	a: ModifyAction | CancelAction,
	acct: Account,
): { path: string; trId: string; body: Record<string, string> } {
	const cancel = a.kind === "cancel";
	const o = a.original;
	if (a.market === "KR") {
		if (!o.kisOrgNo) throw new Error("KIS 국내 정정·취소에 조직번호가 없습니다 (미체결 조회에서 받아야 한다).");
		const orderType = cancel ? o.orderType : a.orderType;
		const price = cancel ? (o.price ?? 0) : a.orderType === "MARKET" ? 0 : (a.price ?? 0);
		return {
			path: DOMESTIC_RVSECNCL,
			trId: "TTTC0013U",
			body: {
				...acct,
				KRX_FWDG_ORD_ORGNO: o.kisOrgNo,
				ORGN_ODNO: o.orderId,
				ORD_DVSN: orderType === "MARKET" ? "01" : "00",
				RVSE_CNCL_DVSN_CD: cancel ? "02" : "01",
				ORD_QTY: n(cancel ? o.openQuantity : a.quantity),
				ORD_UNPR: n(orderType === "MARKET" ? 0 : price),
				// 취소는 미체결 전량, 정정은 수량이 미체결 전량과 같을 때만 전량
				QTY_ALL_ORD_YN: cancel || a.quantity === o.openQuantity ? "Y" : "N",
			},
		};
	}
	if (!a.excd) throw new Error("KIS 미국 정정·취소에 거래소 코드가 없습니다.");
	if (!cancel && (a.orderType !== "LIMIT" || a.price === undefined)) throw new Error("KIS 미국 주식은 지정가로만 정정할 수 있습니다.");
	return {
		path: OVERSEAS_RVSECNCL,
		trId: "TTTT1004U",
		body: {
			...acct,
			OVRS_EXCG_CD: a.excd,
			PDNO: a.symbol,
			ORGN_ODNO: o.orderId,
			RVSE_CNCL_DVSN_CD: cancel ? "02" : "01",
			ORD_QTY: n(cancel ? o.openQuantity : a.quantity),
			// 규격: 취소 주문 시 "0"
			OVRS_ORD_UNPR: cancel ? "0" : n((a as ModifyAction).price ?? 0),
			ORD_SVR_DVSN_CD: "0",
		},
	};
}

function orderNo(res: KisResponse): { orderId: string; orgNo?: string } {
	const out = (res.output ?? {}) as Record<string, unknown>;
	const odno = String(out.ODNO ?? out.odno ?? "").trim();
	if (!odno) throw new Error(`KIS 주문 응답에 주문번호가 없습니다: ${res.msg1 ?? ""}`);
	const org = String(out.KRX_FWDG_ORD_ORGNO ?? out.krx_fwdg_ord_orgno ?? "").trim();
	return { orderId: odno, ...(org ? { orgNo: org } : {}) };
}

/** 신규 주문 — **실제 체결로 이어진다.** */
export async function kisPlaceOrder(ctx: KisContext, a: PlaceAction): Promise<{ orderId: string; orgNo?: string }> {
	const req = kisPlaceBody(a, accountParams(ctx.creds));
	return orderNo(await kisPost(ctx, { ...req, label: a.market === "KR" ? "국내 주문" : "해외 주문" }));
}

/** 정정·취소 — **실제 주문을 바꾼다.** */
export async function kisChangeOrder(ctx: KisContext, a: ModifyAction | CancelAction): Promise<{ orderId: string }> {
	const req = kisChangeBody(a, accountParams(ctx.creds));
	const res = await kisPost(ctx, { ...req, label: a.kind === "cancel" ? "주문 취소" : "주문 정정" });
	return { orderId: orderNo(res).orderId };
}

// ── 주문 전 조회 ────────────────────────────────────────────

const num = (v: unknown): number => {
	const x = Number(String(v ?? "").trim());
	return Number.isFinite(x) ? x : 0;
};
const rows = (res: KisResponse, key: "output" | "output1"): Array<Record<string, unknown>> => {
	const v = res[key];
	return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : v && typeof v === "object" ? [v as Record<string, unknown>] : [];
};

export interface KisOpenOrder extends OriginalOrder {
	symbol: string;
	name: string;
	market: "KR" | "US";
	/** 미국만 — 정정·취소에 필요 */
	excd?: KisOrderExchange;
}

/** 정정·취소 가능한 미체결 주문 — 국내(TTTC0084R) + 미국(TTTS3018R, NASD = 미국 전체) */
export async function kisOpenOrders(ctx: KisContext): Promise<KisOpenOrder[]> {
	const out: KisOpenOrder[] = [];
	const [kr, us] = await Promise.allSettled([
		callKisApi(ctx, "TTTC0084R", { INQR_DVSN_1: "0", INQR_DVSN_2: "0" }, { pages: 3 }),
		callKisApi(ctx, "TTTS3018R", { OVRS_EXCG_CD: "NASD", SORT_SQN: "DS" }, { pages: 3 }),
	]);
	if (kr.status === "fulfilled") {
		for (const p of kr.value.pages) {
			for (const r of rows(p, "output")) {
				const open = num(r.psbl_qty);
				if (open <= 0) continue;
				out.push({
					orderId: String(r.odno ?? "").trim(),
					kisOrgNo: String(r.ord_gno_brno ?? "").trim(),
					symbol: String(r.pdno ?? "").trim(),
					name: String(r.prdt_name ?? "").trim(),
					market: "KR",
					side: String(r.sll_buy_dvsn_cd) === "01" ? "SELL" : "BUY",
					orderType: String(r.ord_dvsn_cd) === "01" ? "MARKET" : "LIMIT",
					openQuantity: open,
					price: num(r.ord_unpr) || null,
					orderedAt: String(r.ord_tmd ?? "").trim() || null,
				});
			}
		}
	}
	if (us.status === "fulfilled") {
		for (const p of us.value.pages) {
			for (const r of rows(p, "output")) {
				const open = num(r.nccs_qty);
				if (open <= 0) continue;
				out.push({
					orderId: String(r.odno ?? "").trim(),
					symbol: String(r.pdno ?? "").trim(),
					name: String(r.prdt_name ?? "").trim(),
					market: "US",
					excd: toOrderExchange(String(r.ovrs_excg_cd ?? "NASD").trim() || "NASD"),
					side: String(r.sll_buy_dvsn_cd) === "01" ? "SELL" : "BUY",
					orderType: "LIMIT",
					openQuantity: open,
					price: num(r.ft_ord_unpr3) || null,
					orderedAt: String(r.ord_tmd ?? "").trim() || null,
				});
			}
		}
	}
	// 둘 다 실패면 "미체결 없음" 이 아니라 조회 실패다 — 정정·취소 준비가 엉뚱한 결론을 내지 않게
	if (kr.status === "rejected" && us.status === "rejected") throw kr.reason;
	return out;
}

/** 매수 가능 금액 (국내: 원 — 미수 없는 매수 금액 / 미국: 달러 — 해외주문가능금액) */
export async function kisBuyingPower(
	ctx: KisContext,
	market: "KR" | "US",
	symbol: string,
	price: number,
	excd?: KisOrderExchange,
): Promise<number> {
	if (market === "KR") {
		const r = await callKisApi(ctx, "TTTC8908R", { PDNO: symbol, ORD_UNPR: String(price), ORD_DVSN: "00", CMA_EVLU_AMT_ICLD_YN: "N", OVRS_ICLD_YN: "N" });
		return num(rows(r.pages[0]!, "output")[0]?.nrcvb_buy_amt);
	}
	const r = await callKisApi(ctx, "TTTS3007R", { OVRS_EXCG_CD: excd ?? "NASD", OVRS_ORD_UNPR: String(price), ITEM_CD: symbol });
	return num(rows(r.pages[0]!, "output")[0]?.ovrs_ord_psbl_amt);
}

/** 매도 가능 수량 (국내 TTTC8408R / 미국은 해외 잔고의 주문가능수량) */
export async function kisSellable(ctx: KisContext, market: "KR" | "US", symbol: string, excd?: KisOrderExchange): Promise<number> {
	if (market === "KR") {
		const r = await callKisApi(ctx, "TTTC8408R", { PDNO: symbol });
		return num(rows(r.pages[0]!, "output")[0]?.ord_psbl_qty);
	}
	const r = await callKisApi(ctx, "TTTS3012R", { OVRS_EXCG_CD: excd ?? "NASD", TR_CRCY_CD: "USD" }, { pages: 3 });
	for (const p of r.pages) {
		for (const row of rows(p, "output1")) {
			if (String(row.ovrs_pdno ?? "").trim().toUpperCase() === symbol.toUpperCase()) return num(row.ord_psbl_qty);
		}
	}
	return 0;
}
