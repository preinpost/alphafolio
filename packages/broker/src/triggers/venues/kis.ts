/**
 * 한국투자 체결 어댑터 (PLAN §40 2단계) — 국장·미장.
 *
 *   국장  호가 FHKST01010200 (J = KRX, 10호가) · 지정가/IOC 지정가(ORD_DVSN 11) · 취소 TTTC0013U ·
 *         상태 TTTC0081R 일별 체결 (ODNO 로 찾는다 — 잔여수량 rmn_qty 가 0 이면 닫힘)
 *   미장  호가 HHDFS76200100 (나스닥 마켓센터 물량만 — NYSE 종목은 얇게 보인다) · 지정가 · 취소 TTTT1004U ·
 *         상태 TTTS3035R 체결 내역 (주문번호 검색이 안 돼 오늘(뉴욕) 목록에서 찾는다)
 *
 * 멱등성 키가 없다 (idempotent=false) — 응답을 못 받은 주문은 다시 보내지 않는다. 체결기가 "결과 모름" 으로 멈춘다.
 * 주문은 실전 TR 만 — 모의투자(V…) TR 은 아직 없다.
 */
import type { KisOrderExchange, OriginalOrder } from "../../actions.ts";
import { overseasPriceAuto } from "../../kis/api.ts";
import { accountParams, kisGet, kisPost, type KisContext, type KisResponse } from "../../kis/client.ts";
import { callKisApi } from "../../kis/gateway.ts";
import { kisChangeOrder, kisPlaceBody, toOrderExchange } from "../../kis/orders.ts";
import { KisError } from "../../kis/types.ts";
import type { Market, OrderSide } from "../../orders.ts";
import { isDomesticSymbol } from "../../quote.ts";
import { localDate } from "../market-time.ts";
import { VenueRejected, VenueUnknown, type Book, type BookLevel, type ExecVenue, type VenueOrderState } from "./types.ts";

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
	const x = Number(String(v ?? "").trim());
	return Number.isFinite(x) ? x : 0;
};
const rowsOf = (res: KisResponse, key: string): Row[] => {
	const v = res[key];
	return Array.isArray(v) ? (v as Row[]) : v && typeof v === "object" ? [v as Row] : [];
};
/** 주문번호 비교 — 앞의 0 은 응답마다 다르게 온다 */
const sameOrder = (a: unknown, b: string): boolean => String(a ?? "").trim().replace(/^0+/, "") === b.trim().replace(/^0+/, "");
const ymd = (t: number, tz: string): string => localDate(t, tz).ymd.replaceAll("-", "");

/** 10호가 필드(askp1…10) → 호가. 가격 0 은 빈 칸 */
export function kisBook(r: Row, keys: { ask: string; bid: string; askQty: string; bidQty: string }, at: number): Book {
	const side = (p: string, q: string): BookLevel[] => {
		const out: BookLevel[] = [];
		for (let i = 1; i <= 10; i++) {
			const price = num(r[`${p}${i}`]);
			const volume = num(r[`${q}${i}`]);
			if (price > 0 && volume > 0) out.push({ price, volume });
		}
		return out;
	};
	return {
		asks: side(keys.ask, keys.askQty).sort((a, b) => a.price - b.price),
		bids: side(keys.bid, keys.bidQty).sort((a, b) => b.price - a.price),
		at,
	};
}

/** 국장 일별 체결 한 줄 → 상태. 잔여수량 = 주문 − 체결 − 취소확인 − 거부 */
export function kisDomesticState(r: Row): VenueOrderState {
	const qty = num(r.ord_qty);
	const filledQty = num(r.tot_ccld_qty);
	const rejected = num(r.rjct_qty);
	const rest = r.rmn_qty !== undefined ? num(r.rmn_qty) : qty - filledQty - num(r.cncl_cfrm_qty) - rejected;
	const avg = num(r.avg_prvs);
	return {
		filledQty,
		avgPrice: filledQty > 0 && avg > 0 ? avg : null,
		open: rest > 0,
		...(rejected > 0 && filledQty === 0 && rest <= 0 ? { rejected: "증권사가 주문을 거부했습니다" } : {}),
	};
}

/** 미장 체결 내역 한 줄 → 상태 */
export function kisOverseasState(r: Row): VenueOrderState {
	const filledQty = num(r.ft_ccld_qty);
	const avg = num(r.ft_ccld_unpr3);
	const status = String(r.prcs_stat_name ?? "").trim();
	const rejected = status === "거부";
	return {
		filledQty,
		avgPrice: filledQty > 0 && avg > 0 ? avg : null,
		open: !rejected && num(r.nccs_qty) > 0,
		...(rejected ? { rejected: String(r.rjct_rson_name ?? "").trim() || "증권사가 주문을 거부했습니다" } : {}),
	};
}

/**
 * KIS 오류 → 거절 / 모름. rt_cd 가 실린 응답(msg_cd 가 있다)은 증권사가 판단해 거절한 것이고,
 * 응답을 못 받았거나 파싱하지 못했으면 접수됐을 수도 있다.
 */
export function classifyKisError(err: unknown): Error {
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof KisError && err.code !== undefined) return new VenueRejected(msg);
	return new VenueUnknown(msg);
}

interface Placed {
	orderId: string;
	orgNo?: string;
	side: OrderSide;
	quantity: number;
	price: number;
	/** 미장 — 주문 넣은 날(뉴욕)에서 찾는다 */
	day: string;
}

export async function kisVenue(ctx: KisContext, symbol: string, opts: { now?: () => number } = {}): Promise<ExecVenue> {
	const market: Market = isDomesticSymbol(symbol) ? "KR" : "US";
	const now = opts.now ?? Date.now;
	accountParams(ctx.creds); // 계좌번호 없으면 여기서 멈춘다 (주문을 내기 전에)
	let excd: KisOrderExchange | undefined;
	let quoteExcd = "";
	if (market === "US") {
		const found = await overseasPriceAuto(ctx, symbol);
		quoteExcd = found.excd;
		excd = toOrderExchange(found.excd);
	}
	const placed = new Map<string, Placed>();
	const currency = market === "KR" ? ("KRW" as const) : ("USD" as const);

	const original = (p: Placed, open: number): OriginalOrder => ({
		orderId: p.orderId,
		side: p.side,
		orderType: "LIMIT",
		openQuantity: open,
		price: p.price,
		orderedAt: null,
		...(p.orgNo ? { kisOrgNo: p.orgNo } : {}),
	});

	const findRow = async (p: Placed): Promise<Row | null> => {
		if (market === "KR") {
			const day = p.day;
			const r = await callKisApi(
				ctx,
				"TTTC0081R",
				{
					INQR_STRT_DT: day,
					INQR_END_DT: day,
					SLL_BUY_DVSN_CD: "00",
					PDNO: symbol,
					ORD_GNO_BRNO: "",
					ODNO: p.orderId,
					CCLD_DVSN: "00",
					INQR_DVSN: "00",
					INQR_DVSN_1: "",
					INQR_DVSN_3: "00",
					EXCG_ID_DVSN_CD: "KRX",
				},
				{ trId: "TTTC0081R" },
			);
			for (const page of r.pages) for (const row of rowsOf(page, "output1")) if (sameOrder(row.odno, p.orderId)) return row;
			return null;
		}
		const r = await callKisApi(
			ctx,
			"TTTS3035R",
			{
				PDNO: symbol,
				ORD_STRT_DT: p.day,
				ORD_END_DT: p.day,
				SLL_BUY_DVSN: "00",
				CCLD_NCCS_DVSN: "00",
				OVRS_EXCG_CD: "NASD",
				SORT_SQN: "DS",
				ORD_DT: "",
				ORD_GNO_BRNO: "",
				ODNO: "",
			},
			{ pages: 3 },
		);
		for (const page of r.pages) for (const row of rowsOf(page, "output")) if (sameOrder(row.odno, p.orderId)) return row;
		return null;
	};

	return {
		label: market === "KR" ? "한국투자 국장" : "한국투자 미장",
		market,
		symbol,
		supportsIoc: market === "KR",
		idempotent: false,
		async book() {
			if (market === "KR") {
				const res = await kisGet(ctx, {
					path: "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
					trId: "FHKST01010200",
					query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
					label: "국내 호가",
				});
				return kisBook(rowsOf(res, "output1")[0] ?? {}, { ask: "askp", bid: "bidp", askQty: "askp_rsqn", bidQty: "bidp_rsqn" }, now());
			}
			const res = await kisGet(ctx, {
				path: "/uapi/overseas-price/v1/quotations/inquire-asking-price",
				trId: "HHDFS76200100",
				query: { AUTH: "", EXCD: quoteExcd, SYMB: symbol },
				label: "해외 호가",
			});
			// 10호가는 output2 에 온다 (output1 은 현재가 요약) — 어느 쪽이든 pask1 이 있는 줄
			const row = [...rowsOf(res, "output2"), ...rowsOf(res, "output1")].find((r) => r.pask1 !== undefined || r.pbid1 !== undefined) ?? {};
			return kisBook(row, { ask: "pask", bid: "pbid", askQty: "vask", bidQty: "vbid" }, now());
		},
		async place(o) {
			if (o.ioc && market !== "KR") throw new VenueRejected("KIS 미장은 IOC 주문이 없습니다");
			const req = kisPlaceBody(
				{ kind: "place", broker: "kis", symbol, market, currency, side: o.side, orderType: "LIMIT", quantity: o.quantity, price: o.price, estimatedAmount: o.price * o.quantity, ...(excd ? { excd } : {}) },
				accountParams(ctx.creds),
			);
			if (o.ioc) req.body.ORD_DVSN = "11";
			let res: KisResponse;
			try {
				res = await kisPost(ctx, { ...req, label: market === "KR" ? "국내 주문" : "해외 주문" });
			} catch (err) {
				throw classifyKisError(err);
			}
			const out = (res.output ?? {}) as Row;
			const orderId = String(out.ODNO ?? out.odno ?? "").trim();
			// 성공 응답인데 주문번호가 없다 — 접수됐을 수 있다
			if (!orderId) throw new VenueUnknown(`주문 응답에 주문번호가 없습니다: ${res.msg1 ?? ""}`);
			const orgNo = String(out.KRX_FWDG_ORD_ORGNO ?? out.krx_fwdg_ord_orgno ?? "").trim();
			const day = ymd(now(), market === "KR" ? "Asia/Seoul" : "America/New_York");
			placed.set(orderId, { orderId, ...(orgNo ? { orgNo } : {}), side: o.side, quantity: o.quantity, price: o.price, day });
			return { orderId, ref: `${orgNo}|${day}` };
		},
		adopt(o) {
			const [orgNo = "", day = ymd(now(), market === "KR" ? "Asia/Seoul" : "America/New_York")] = (o.ref ?? "").split("|");
			placed.set(o.orderId, { orderId: o.orderId, ...(orgNo ? { orgNo } : {}), side: o.side, quantity: o.quantity, price: o.price, day });
		},
		async cancel(orderId) {
			const p = placed.get(orderId);
			if (!p) throw new Error(`이 체결기가 낸 주문이 아닙니다: ${orderId}`);
			const row = await findRow(p);
			const st = row ? (market === "KR" ? kisDomesticState(row) : kisOverseasState(row)) : null;
			const open = st ? p.quantity - st.filledQty : p.quantity;
			if (st && !st.open) return;
			await kisChangeOrder(ctx, { kind: "cancel", broker: "kis", symbol, market, currency, original: original(p, Math.max(1, open)), ...(excd ? { excd } : {}) });
		},
		async status(orderId) {
			const p = placed.get(orderId);
			if (!p) throw new Error(`이 체결기가 낸 주문이 아닙니다: ${orderId}`);
			const row = await findRow(p);
			// 방금 낸 주문이 아직 목록에 없을 수 있다 — 살아 있는 것으로 본다 (취소 확인에서 끝내 안 보이면 체결기가 "결과 모름")
			if (!row) return { filledQty: 0, avgPrice: null, open: true };
			return market === "KR" ? kisDomesticState(row) : kisOverseasState(row);
		},
	};
}
