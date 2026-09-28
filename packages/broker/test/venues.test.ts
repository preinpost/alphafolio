/**
 * 체결 어댑터 (PLAN §40 2단계) — 응답 해석과 실제로 나가는 요청을 검사한다 (가짜 fetch).
 *
 * 지켜야 할 것:
 *   - KIS 국장 IOC = ORD_DVSN 11, 취소는 조직번호를 싣고 잔량 전부
 *   - 응답을 못 받은 주문은 결과 모름(다시 보내지 않는다), 증권사가 판단한 오류는 거절
 *   - 토스 주문은 clientOrderId·지정가 문자열·DAY
 *   - 상태: 잔여수량·취소 시각으로 닫힘을 가른다
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { KisContext } from "../src/kis/client.ts";
import { KisError } from "../src/kis/types.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import { TossError, type TossContext } from "../src/toss/client.ts";
import type { TossOrder } from "../src/toss/orders.ts";
import { classifyKisError, kisBook, kisDomesticState, kisOverseasState, kisVenue } from "../src/triggers/venues/kis.ts";
import { classifyTossError, tossBook, tossOrderState, tossVenue } from "../src/triggers/venues/toss.ts";
import { VenueRejected, VenueUnknown } from "../src/triggers/venues/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Req {
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fake(reply: (r: Req) => Response | Promise<Response>): Req[] {
	const reqs: Req[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/oauth2/tokenP") return json({ access_token: "kt", expires_in: 86400 });
		if (url.pathname === "/oauth2/token") return json({ access_token: "tt", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json({ result: [{ accountSeq: 7 }] });
		const r: Req = {
			method: init?.method ?? "GET",
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		};
		reqs.push(r);
		return reply(r);
	}) as typeof fetch;
	return reqs;
}

let seq = 0;
const kis = (): KisContext => ({
	creds: { appKey: `k${++seq}-${Math.random()}`, appSecret: "s", cano: "12345678", prdtCd: "01", env: "real" },
	store: memoryTokenStore(),
	owner: `u${seq}`,
});
const toss = (): TossContext => ({ creds: { clientId: `c${++seq}-${Math.random()}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `u${seq}` });

// ── 해석 ────────────────────────────────────────────────────

describe("응답 해석", () => {
	it("토스 호가 — 문자열 숫자, 정렬, 빈 칸 제거", () => {
		const b = tossBook(
			{
				asks: [
					{ price: "71100", volume: "3" },
					{ price: "71000", volume: "5" },
					{ price: "71200", volume: "0" },
				],
				bids: [
					{ price: "70800", volume: "1" },
					{ price: "70900", volume: "2" },
				],
			},
			5,
		);
		assert.deepEqual(
			b.asks.map((l) => l.price),
			[71_000, 71_100],
		);
		assert.deepEqual(
			b.bids.map((l) => l.price),
			[70_900, 70_800],
		);
		assert.equal(b.at, 5);
	});

	it("토스 주문 상태 — PARTIAL_FILLED 는 취소 시각으로 가른다", () => {
		const o = (status: string, filled: string, canceledAt: string | null = null) =>
			({ status, canceledAt, execution: { filledQuantity: filled, averageFilledPrice: filled === "0" ? null : "71000" } }) as unknown as TossOrder;
		assert.deepEqual(tossOrderState(o("PENDING", "0")), { filledQty: 0, avgPrice: null, open: true });
		assert.equal(tossOrderState(o("PARTIAL_FILLED", "3")).open, true);
		assert.equal(tossOrderState(o("PARTIAL_FILLED", "3", "2026-09-28T10:00:00+09:00")).open, false);
		assert.deepEqual(tossOrderState(o("CANCELED", "3")), { filledQty: 3, avgPrice: 71_000, open: false });
		assert.equal(tossOrderState(o("REJECTED", "0")).rejected, "증권사가 주문을 거부했습니다");
	});

	it("KIS 10호가 · 국장 잔여수량 · 미장 미체결", () => {
		const b = kisBook({ askp1: "71000", askp_rsqn1: "10", askp2: "0", askp_rsqn2: "0", bidp1: "70900", bidp_rsqn1: "7" }, { ask: "askp", bid: "bidp", askQty: "askp_rsqn", bidQty: "bidp_rsqn" }, 1);
		assert.deepEqual(b.asks, [{ price: 71_000, volume: 10 }]);
		assert.deepEqual(b.bids, [{ price: 70_900, volume: 7 }]);
		assert.deepEqual(kisDomesticState({ ord_qty: "10", tot_ccld_qty: "4", avg_prvs: "71000", rmn_qty: "6", rjct_qty: "0" }), { filledQty: 4, avgPrice: 71_000, open: true });
		assert.equal(kisDomesticState({ ord_qty: "10", tot_ccld_qty: "4", avg_prvs: "71000", rmn_qty: "0", cncl_cfrm_qty: "6" }).open, false);
		assert.equal(kisDomesticState({ ord_qty: "10", tot_ccld_qty: "0", rmn_qty: "0", rjct_qty: "10" }).rejected, "증권사가 주문을 거부했습니다");
		assert.deepEqual(kisOverseasState({ ft_ccld_qty: "2", ft_ccld_unpr3: "190.5", nccs_qty: "3", prcs_stat_name: "완료" }), { filledQty: 2, avgPrice: 190.5, open: true });
		assert.equal(kisOverseasState({ ft_ccld_qty: "0", nccs_qty: "5", prcs_stat_name: "거부", rjct_rson_name: "잔고부족" }).rejected, "잔고부족");
	});

	it("오류 구분 — 증권사 판단은 거절, 응답 없음·파싱 실패·5xx 는 모름", () => {
		assert.ok(classifyKisError(new KisError("주문가능금액 초과", { status: 200, code: "APBK0952", api: "x" })) instanceof VenueRejected);
		assert.ok(classifyKisError(new KisError("응답을 파싱할 수 없습니다", { status: 502, api: "x" })) instanceof VenueUnknown);
		assert.ok(classifyKisError(new TypeError("fetch failed")) instanceof VenueUnknown);
		assert.ok(classifyTossError(new TossError("잔고 부족", { status: 400 })) instanceof VenueRejected);
		assert.ok(classifyTossError(new TossError("bad gateway", { status: 502 })) instanceof VenueUnknown);
		assert.ok(classifyTossError(new TypeError("fetch failed")) instanceof VenueUnknown);
	});
});

// ── KIS 국장 ────────────────────────────────────────────────

describe("KIS 국장", () => {
	it("IOC 지정가 → 상태(ODNO) → 잔량 취소(조직번호·전량)", async () => {
		let row: Record<string, string> = { odno: "0000117057", ord_qty: "10", tot_ccld_qty: "4", avg_prvs: "71000", rmn_qty: "6" };
		const reqs = fake((r) => {
			if (r.path.endsWith("/trading/order-cash")) return json({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91252", ODNO: "0000117057" } });
			if (r.path.endsWith("/trading/inquire-daily-ccld")) return json({ rt_cd: "0", output1: [row] });
			if (r.path.endsWith("/trading/order-rvsecncl")) {
				row = { ...row, rmn_qty: "0", cncl_cfrm_qty: "6" };
				return json({ rt_cd: "0", output: { ODNO: "0000117060" } });
			}
			return json({ rt_cd: "1", msg1: `unexpected ${r.path}` });
		});
		const v = await kisVenue(kis(), "005930");
		assert.equal(v.supportsIoc, true);
		assert.equal(v.idempotent, false);
		const { orderId, ref } = await v.place({ side: "BUY", quantity: 10, price: 71_000, ioc: true, clientId: "x-0" });
		assert.equal(orderId, "0000117057");
		assert.match(ref ?? "", /^91252\|\d{8}$/);
		const place = reqs.find((r) => r.path.endsWith("/order-cash"))!;
		assert.equal(place.headers.tr_id, "TTTC0012U");
		assert.equal(place.body!.ORD_DVSN, "11");
		assert.equal(place.body!.ORD_UNPR, "71000");
		assert.equal(place.body!.ORD_QTY, "10");

		assert.deepEqual(await v.status(orderId), { filledQty: 4, avgPrice: 71_000, open: true });
		const q = reqs.find((r) => r.path.endsWith("/inquire-daily-ccld"))!;
		assert.equal(q.headers.tr_id, "TTTC0081R");
		assert.equal(q.query.ODNO, "0000117057");
		assert.equal(q.query.PDNO, "005930");

		await v.cancel(orderId);
		const c = reqs.find((r) => r.path.endsWith("/order-rvsecncl"))!;
		assert.equal(c.headers.tr_id, "TTTC0013U");
		assert.equal(c.body!.KRX_FWDG_ORD_ORGNO, "91252");
		assert.equal(c.body!.ORGN_ODNO, "0000117057");
		assert.equal(c.body!.RVSE_CNCL_DVSN_CD, "02");
		assert.equal(c.body!.QTY_ALL_ORD_YN, "Y");
		assert.equal(c.body!.ORD_QTY, "6");
		assert.equal((await v.status(orderId)).open, false);
	});

	it("연결이 끊기면 결과 모름 — POST 는 한 번뿐", async () => {
		let posts = 0;
		fake((r) => {
			if (r.method === "POST") {
				posts++;
				throw new TypeError("fetch failed");
			}
			return json({ rt_cd: "0" });
		});
		const v = await kisVenue(kis(), "005930");
		await assert.rejects(v.place({ side: "SELL", quantity: 1, price: 71_000, ioc: false, clientId: "x-0" }), VenueUnknown);
		assert.equal(posts, 1);
	});

	it("증권사 거절(rt_cd) 은 거절", async () => {
		fake(() => json({ rt_cd: "1", msg_cd: "APBK0952", msg1: "주문가능금액을 초과 했습니다" }));
		const v = await kisVenue(kis(), "005930");
		await assert.rejects(v.place({ side: "BUY", quantity: 1, price: 71_000, ioc: false, clientId: "x-0" }), VenueRejected);
	});

	it("기동 복구 — 기록(ref)으로 되살린 주문을 취소할 수 있다", async () => {
		const reqs = fake((r) => {
			if (r.path.endsWith("/trading/inquire-daily-ccld")) return json({ rt_cd: "0", output1: [{ odno: "0000000009", ord_qty: "5", tot_ccld_qty: "0", rmn_qty: "5" }] });
			if (r.path.endsWith("/trading/order-rvsecncl")) return json({ rt_cd: "0", output: { ODNO: "10" } });
			return json({ rt_cd: "1", msg1: "unexpected" });
		});
		const v = await kisVenue(kis(), "005930");
		v.adopt!({ orderId: "0000000009", ref: "91252|20260925", side: "BUY", quantity: 5, price: 70_000 });
		await v.cancel("0000000009");
		assert.equal(reqs.find((r) => r.path.endsWith("/inquire-daily-ccld"))!.query.INQR_STRT_DT, "20260925");
		const c = reqs.find((r) => r.path.endsWith("/order-rvsecncl"))!;
		assert.equal(c.body!.KRX_FWDG_ORD_ORGNO, "91252");
		assert.equal(c.body!.ORD_QTY, "5");
	});

	it("이미 닫힌 주문은 취소를 보내지 않는다", async () => {
		const reqs = fake((r) => {
			if (r.path.endsWith("/trading/order-cash")) return json({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91252", ODNO: "1" } });
			if (r.path.endsWith("/trading/inquire-daily-ccld")) return json({ rt_cd: "0", output1: [{ odno: "0000000001", ord_qty: "1", tot_ccld_qty: "1", avg_prvs: "71000", rmn_qty: "0" }] });
			return json({ rt_cd: "1", msg1: "unexpected" });
		});
		const v = await kisVenue(kis(), "005930");
		await v.place({ side: "BUY", quantity: 1, price: 71_000, ioc: false, clientId: "x-0" });
		await v.cancel("1");
		assert.equal(reqs.filter((r) => r.path.endsWith("/order-rvsecncl")).length, 0);
	});
});

// ── KIS 미장 ────────────────────────────────────────────────

describe("KIS 미장", () => {
	it("상장 거래소를 찾아 지정가 → 오늘 체결 내역에서 주문번호로 찾는다", async () => {
		const reqs = fake((r) => {
			if (r.path.endsWith("/quotations/price")) return json({ rt_cd: "0", output: { last: r.query.EXCD === "NYS" ? "190.1" : "" } });
			if (r.path.endsWith("/quotations/inquire-asking-price")) return json({ rt_cd: "0", output1: { last: "190.1" }, output2: { pask1: "190.12", vask1: "30", pbid1: "190.08", vbid1: "12" } });
			if (r.path.endsWith("/trading/order")) return json({ rt_cd: "0", output: { ODNO: "0030123456" } });
			if (r.path.endsWith("/trading/inquire-ccnl"))
				return json({ rt_cd: "0", output: [{ odno: "0030999999", ft_ccld_qty: "9" }, { odno: "0030123456", ft_ord_qty: "5", ft_ccld_qty: "5", ft_ccld_unpr3: "190.1", nccs_qty: "0", prcs_stat_name: "완료" }] });
			return json({ rt_cd: "1", msg1: `unexpected ${r.path}` });
		});
		const v = await kisVenue(kis(), "ORCL");
		assert.equal(v.supportsIoc, false);
		const b = await v.book();
		assert.deepEqual(b.asks, [{ price: 190.12, volume: 30 }]);
		assert.equal(reqs.find((r) => r.path.endsWith("/inquire-asking-price"))!.query.EXCD, "NYS");
		await assert.rejects(v.place({ side: "BUY", quantity: 5, price: 190.12, ioc: true, clientId: "x-0" }), VenueRejected);
		const { orderId } = await v.place({ side: "BUY", quantity: 5, price: 190.12, ioc: false, clientId: "x-0" });
		const place = reqs.find((r) => r.path.endsWith("/trading/order"))!;
		assert.equal(place.headers.tr_id, "TTTT1002U");
		assert.equal(place.body!.OVRS_EXCG_CD, "NYSE");
		assert.equal(place.body!.OVRS_ORD_UNPR, "190.12");
		assert.equal(place.body!.ORD_DVSN, "00");
		assert.deepEqual(await v.status(orderId), { filledQty: 5, avgPrice: 190.1, open: false });
		const q = reqs.find((r) => r.path.endsWith("/inquire-ccnl"))!;
		assert.equal(q.query.PDNO, "ORCL");
		assert.equal(q.query.ODNO, "");
		assert.match(q.query.ORD_STRT_DT!, /^\d{8}$/);
	});
});

// ── 토스 ────────────────────────────────────────────────────

describe("토스", () => {
	it("지정가 — clientOrderId · 가격 문자열 · DAY, 상태는 원주문 상세", async () => {
		const reqs = fake((r) => {
			if (r.path === "/api/v1/orders" && r.method === "POST") return json({ result: { orderId: "T-1", clientOrderId: r.body!.clientOrderId } });
			if (r.path === "/api/v1/orders/T-1") return json({ result: { orderId: "T-1", status: "PARTIAL_FILLED", canceledAt: null, execution: { filledQuantity: "2", averageFilledPrice: "190.1" } } });
			if (r.path === "/api/v1/orderbook") return json({ result: { asks: [{ price: "190.12", volume: "3" }], bids: [] } });
			return json({ error: { message: "unexpected" } }, 404);
		});
		const v = await tossVenue(toss(), "AAPL");
		assert.equal(v.market, "US");
		assert.equal(v.idempotent, true);
		assert.equal((await v.book()).asks[0]!.price, 190.12);
		const { orderId } = await v.place({ side: "BUY", quantity: 5, price: 190.1, ioc: false, clientId: "sig01-0" });
		assert.equal(orderId, "T-1");
		const p = reqs.find((r) => r.method === "POST")!;
		assert.deepEqual(p.body, { clientOrderId: "sig01-0", symbol: "AAPL", side: "BUY", orderType: "LIMIT", quantity: "5", timeInForce: "DAY", price: "190.10" });
		assert.equal(p.headers["X-Tossinvest-Account"], "7");
		assert.deepEqual(await v.status("T-1"), { filledQty: 2, avgPrice: 190.1, open: true });
	});

	it("4xx 는 거절, 5xx 는 모름", async () => {
		let code = 400;
		fake(() => json({ error: { message: "잔고 부족" } }, code));
		const v = await tossVenue(toss(), "005930");
		await assert.rejects(v.place({ side: "BUY", quantity: 1, price: 71_000, ioc: false, clientId: "a-0" }), VenueRejected);
		code = 503;
		await assert.rejects(v.place({ side: "BUY", quantity: 1, price: 71_000, ioc: false, clientId: "a-1" }), VenueUnknown);
		await assert.rejects(v.place({ side: "BUY", quantity: 1, price: 71_000, ioc: true, clientId: "a-2" }), VenueRejected);
	});
});
