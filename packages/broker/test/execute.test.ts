/**
 * 주문 실행기 (PLAN §33) — 사람이 [확인] 을 누른 뒤 실제로 나가는 요청을 한 글자씩 검사한다.
 *
 * 지켜야 할 것:
 *   - 토큰의 증권사로만 간다 (토스 동작이 KIS 로, KIS 동작이 토스로 새지 않는다)
 *   - TR ID·경로·본문이 규격대로다 (매수/매도·국내/미국·정정/취소 조합 전부)
 *   - KIS 주문은 자동 재시도하지 않는다 (멱등성 키가 없어 재시도 = 중복 주문). 토큰 만료만 1회
 *   - 규격상 안 되는 조합(KIS 미국 시장가, 토스 미국 수량 정정)은 네트워크 전에 멈춘다
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { OrderAction, OriginalOrder } from "../src/actions.ts";
import { executeOrderAction } from "../src/execute.ts";
import type { KisContext } from "../src/kis/client.ts";
import type { BrokerAccess } from "../src/portfolio.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Req {
	host: string;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
}

let seq = 0;
/** 가짜 KIS + 토스. reply 로 주문 응답을 바꿀 수 있다 */
function fake(opts: { kisReply?: (n: number) => Response; tossReply?: (r: Req) => Response } = {}): Req[] {
	const reqs: Req[] = [];
	let kisPosts = 0;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
		if (url.pathname === "/oauth2/tokenP") return json({ access_token: "kt", expires_in: 86400 });
		if (url.pathname === "/oauth2/token") return json({ access_token: "tt", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json({ result: [{ accountSeq: 7 }] });
		const r: Req = {
			host: url.host,
			method: init?.method ?? "GET",
			path: url.pathname,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		};
		reqs.push(r);
		if (url.host.includes("koreainvestment")) {
			kisPosts++;
			return opts.kisReply?.(kisPosts) ?? json({ rt_cd: "0", msg1: "정상", output: { KRX_FWDG_ORD_ORGNO: "91252", ODNO: "0000117057" } });
		}
		return opts.tossReply?.(r) ?? json({ result: { orderId: "T-1", conditionalOrderId: "C-1" } });
	}) as typeof fetch;
	return reqs;
}

function access(): BrokerAccess {
	seq++;
	const kis: KisContext = {
		creds: { appKey: `k${seq}-${Math.random()}`, appSecret: "s", cano: "12345678", prdtCd: "01", env: "real" },
		store: memoryTokenStore(),
		owner: `u${seq}`,
	};
	const toss: TossContext = { creds: { clientId: `c${seq}-${Math.random()}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `u${seq}` };
	return { kis: () => kis, toss: () => toss };
}

const NONCE = "af0123456789abcdef";
const kr = { symbol: "005930", market: "KR" as const, currency: "KRW" as const };
const us = { symbol: "AAPL", market: "US" as const, currency: "USD" as const };
const orig = (o: Partial<OriginalOrder> = {}): OriginalOrder => ({
	orderId: "0000117057",
	side: "BUY",
	orderType: "LIMIT",
	openQuantity: 10,
	price: 70000,
	orderedAt: "091200",
	kisOrgNo: "91252",
	...o,
});
const onlyHost = (reqs: Req[], part: string) => assert.ok(reqs.every((r) => r.host.includes(part)), reqs.map((r) => r.host).join(","));

describe("신규 주문 — KIS", () => {
	it("국내 지정가 매수: TTTC0012U, 본문 규격 그대로 (토스에는 닿지 않는다)", async () => {
		const reqs = fake();
		const r = await executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "BUY", orderType: "LIMIT", quantity: 10, price: 70000, estimatedAmount: 700000 }, NONCE, access());
		assert.equal(reqs.length, 1);
		onlyHost(reqs, "koreainvestment");
		assert.equal(reqs[0]!.path, "/uapi/domestic-stock/v1/trading/order-cash");
		assert.equal(reqs[0]!.headers.tr_id, "TTTC0012U");
		assert.deepEqual(reqs[0]!.body, { CANO: "12345678", ACNT_PRDT_CD: "01", PDNO: "005930", ORD_DVSN: "00", ORD_QTY: "10", ORD_UNPR: "70000" });
		assert.equal(r.orderId, "0000117057");
	});

	it("국내 시장가 매도: TTTC0011U, 주문구분 01, 단가 0", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "SELL", orderType: "MARKET", quantity: 3, estimatedAmount: 1 }, NONCE, access());
		assert.equal(reqs[0]!.headers.tr_id, "TTTC0011U");
		assert.equal(reqs[0]!.body?.ORD_DVSN, "01");
		assert.equal(reqs[0]!.body?.ORD_UNPR, "0");
	});

	it("미국 지정가 매수: TTTT1002U, 거래소·단가, 매수는 SLL_TYPE 없음", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "place", broker: "kis", ...us, side: "BUY", orderType: "LIMIT", quantity: 2, price: 190.5, estimatedAmount: 381, excd: "NASD" }, NONCE, access());
		assert.equal(reqs[0]!.path, "/uapi/overseas-stock/v1/trading/order");
		assert.equal(reqs[0]!.headers.tr_id, "TTTT1002U");
		assert.deepEqual(reqs[0]!.body, { CANO: "12345678", ACNT_PRDT_CD: "01", OVRS_EXCG_CD: "NASD", PDNO: "AAPL", ORD_QTY: "2", OVRS_ORD_UNPR: "190.5", ORD_SVR_DVSN_CD: "0", ORD_DVSN: "00" });
	});

	it("미국 매도: TTTT1006U + SLL_TYPE 00", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "place", broker: "kis", ...us, side: "SELL", orderType: "LIMIT", quantity: 2, price: 190, estimatedAmount: 380, excd: "NYSE" }, NONCE, access());
		assert.equal(reqs[0]!.headers.tr_id, "TTTT1006U");
		assert.equal(reqs[0]!.body?.SLL_TYPE, "00");
		assert.equal(reqs[0]!.body?.OVRS_EXCG_CD, "NYSE");
	});

	it("미국 시장가는 네트워크 전에 거절 (KIS 에 일반 시장가가 없다)", async () => {
		const reqs = fake();
		await assert.rejects(
			executeOrderAction({ kind: "place", broker: "kis", ...us, side: "BUY", orderType: "MARKET", quantity: 1, estimatedAmount: 1, excd: "NASD" }, NONCE, access()),
			/지정가/,
		);
		assert.equal(reqs.length, 0);
	});
});

describe("신규 주문 — 토스", () => {
	it("nonce 를 clientOrderId 로, 계좌 헤더, KIS 에는 닿지 않는다", async () => {
		const reqs = fake();
		const r = await executeOrderAction({ kind: "place", broker: "toss", ...kr, side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000, estimatedAmount: 70000 }, NONCE, access());
		onlyHost(reqs, "tossinvest");
		assert.equal(reqs[0]!.path, "/api/v1/orders");
		assert.equal(reqs[0]!.headers["X-Tossinvest-Account"], "7");
		assert.deepEqual(reqs[0]!.body, { clientOrderId: NONCE, symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: "1", timeInForce: "DAY", price: "70000" });
		assert.equal(r.orderId, "T-1");
	});

	it("시장가에는 price 를 싣지 않는다 (토스가 거절한다)", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "place", broker: "toss", ...us, side: "BUY", orderType: "MARKET", quantity: 1, estimatedAmount: 1 }, NONCE, access());
		assert.equal("price" in (reqs[0]!.body ?? {}), false);
	});
});

describe("정정·취소 — KIS", () => {
	it("국내 정정: TTTC0013U, 정정코드 01, 조직번호·원주문번호, 전량 여부", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "modify", broker: "kis", ...kr, original: orig(), orderType: "LIMIT", quantity: 10, price: 69500 }, NONCE, access());
		assert.equal(reqs[0]!.path, "/uapi/domestic-stock/v1/trading/order-rvsecncl");
		assert.equal(reqs[0]!.headers.tr_id, "TTTC0013U");
		assert.deepEqual(reqs[0]!.body, {
			CANO: "12345678", ACNT_PRDT_CD: "01", KRX_FWDG_ORD_ORGNO: "91252", ORGN_ODNO: "0000117057",
			ORD_DVSN: "00", RVSE_CNCL_DVSN_CD: "01", ORD_QTY: "10", ORD_UNPR: "69500", QTY_ALL_ORD_YN: "Y",
		});
	});

	it("국내 일부 수량 정정은 전량 여부 N", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "modify", broker: "kis", ...kr, original: orig(), orderType: "LIMIT", quantity: 4, price: 69500 }, NONCE, access());
		assert.equal(reqs[0]!.body?.QTY_ALL_ORD_YN, "N");
		assert.equal(reqs[0]!.body?.ORD_QTY, "4");
	});

	it("국내 취소: 정정코드 02, 미체결 전량, 원주문 단가", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "cancel", broker: "kis", ...kr, original: orig({ openQuantity: 7 }) }, NONCE, access());
		assert.equal(reqs[0]!.body?.RVSE_CNCL_DVSN_CD, "02");
		assert.equal(reqs[0]!.body?.ORD_QTY, "7");
		assert.equal(reqs[0]!.body?.QTY_ALL_ORD_YN, "Y");
	});

	it("국내 정정·취소에 조직번호가 없으면 네트워크 전에 멈춘다", async () => {
		const reqs = fake();
		await assert.rejects(executeOrderAction({ kind: "cancel", broker: "kis", ...kr, original: orig({ kisOrgNo: undefined }) }, NONCE, access()), /조직번호/);
		assert.equal(reqs.length, 0);
	});

	it("미국 취소: TTTT1004U, 단가 \"0\"", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "cancel", broker: "kis", ...us, original: orig({ openQuantity: 2, price: 190 }), excd: "NASD" }, NONCE, access());
		assert.equal(reqs[0]!.headers.tr_id, "TTTT1004U");
		assert.equal(reqs[0]!.body?.RVSE_CNCL_DVSN_CD, "02");
		assert.equal(reqs[0]!.body?.OVRS_ORD_UNPR, "0");
		assert.equal(reqs[0]!.body?.ORGN_ODNO, "0000117057");
	});
});

describe("정정·취소 — 토스", () => {
	it("국내 정정은 수량 포함", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "modify", broker: "toss", ...kr, original: orig({ orderId: "T-9" }), orderType: "LIMIT", quantity: 5, price: 69000 }, NONCE, access());
		assert.equal(reqs[0]!.path, "/api/v1/orders/T-9/modify");
		assert.deepEqual(reqs[0]!.body, { orderType: "LIMIT", quantity: "5", price: "69000" });
	});

	it("미국 정정은 수량을 보내지 않는다 (규격: 보내면 400)", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "modify", broker: "toss", ...us, original: orig({ orderId: "T-9" }), orderType: "LIMIT", quantity: 5, price: 189 }, NONCE, access());
		assert.deepEqual(reqs[0]!.body, { orderType: "LIMIT", price: "189" });
	});

	it("취소는 /cancel", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "cancel", broker: "toss", ...kr, original: orig({ orderId: "T-9" }) }, NONCE, access());
		assert.equal(reqs[0]!.path, "/api/v1/orders/T-9/cancel");
		assert.equal(reqs[0]!.method, "POST");
	});
});

describe("조건주문 — 토스", () => {
	const oco: Extract<OrderAction, { kind: "conditional-create" }> = {
		kind: "conditional-create", broker: "toss", ...kr, type: "OCO", quantity: 3, orderType: "LIMIT", expireDate: "2026-10-23",
		first: { side: "SELL", triggerPrice: 75000, orderPrice: 74900 },
		second: { side: "SELL", triggerPrice: 65000, orderPrice: 64900 },
	};

	it("생성: symbol·clientOrderId(nonce)·두 조건", async () => {
		const reqs = fake();
		const r = await executeOrderAction(oco, NONCE, access());
		assert.equal(reqs[0]!.path, "/api/v1/conditional-orders");
		assert.deepEqual(reqs[0]!.body, {
			symbol: "005930", clientOrderId: NONCE, type: "OCO", quantity: "3", orderType: "LIMIT", expireDate: "2026-10-23",
			first: { orderSide: "SELL", triggerPrice: "75000", orderPrice: "74900" },
			second: { orderSide: "SELL", triggerPrice: "65000", orderPrice: "64900" },
		});
		assert.equal(r.conditionalOrderId, "C-1");
	});

	it("SINGLE 은 second 를 보내지 않는다", async () => {
		const reqs = fake();
		await executeOrderAction({ ...oco, type: "SINGLE", second: { side: "SELL", triggerPrice: 1 } }, NONCE, access());
		assert.equal("second" in (reqs[0]!.body ?? {}), false);
	});

	it("수정: symbol 없이 /modify, 새 번호를 돌려준다", async () => {
		const reqs = fake({ tossReply: () => new Response(JSON.stringify({ result: { conditionalOrderId: "C-NEW" } })) });
		const r = await executeOrderAction({ ...oco, kind: "conditional-modify", conditionalOrderId: "C-1" }, NONCE, access());
		assert.equal(reqs[0]!.path, "/api/v1/conditional-orders/C-1/modify");
		assert.equal("symbol" in (reqs[0]!.body ?? {}), false);
		assert.equal(r.conditionalOrderId, "C-NEW");
	});

	it("취소: DELETE", async () => {
		const reqs = fake();
		await executeOrderAction({ kind: "conditional-cancel", broker: "toss", symbol: "005930", conditionalOrderId: "C-1" }, NONCE, access());
		assert.equal(reqs[0]!.method, "DELETE");
		assert.equal(reqs[0]!.path, "/api/v1/conditional-orders/C-1");
	});
});

describe("안전장치", () => {
	it("KIS 주문은 서버 오류에 재시도하지 않는다 (재시도 = 중복 주문)", async () => {
		const reqs = fake({ kisReply: () => new Response("upstream error", { status: 502 }) });
		await assert.rejects(executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000, estimatedAmount: 1 }, NONCE, access()));
		assert.equal(reqs.length, 1, "한 번만 보낸다");
	});

	it("KIS 거절 응답(rt_cd≠0)도 재시도하지 않는다", async () => {
		const reqs = fake({ kisReply: () => new Response(JSON.stringify({ rt_cd: "1", msg_cd: "APBK0013", msg1: "주문가능금액을 초과했습니다" })) });
		await assert.rejects(
			executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000, estimatedAmount: 1 }, NONCE, access()),
			/주문가능금액/,
		);
		assert.equal(reqs.length, 1);
	});

	it("토큰 만료(EGW00121)만 한 번 다시 보낸다 — 인증 단계 거절이라 주문이 접수되지 않았다", async () => {
		const reqs = fake({
			kisReply: (n) =>
				n === 1
					? new Response(JSON.stringify({ rt_cd: "1", msg_cd: "EGW00121", msg1: "유효하지 않은 token" }))
					: new Response(JSON.stringify({ rt_cd: "0", output: { ODNO: "1" } })),
		});
		await executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000, estimatedAmount: 1 }, NONCE, access());
		assert.equal(reqs.length, 2);
	});

	it("수량 0·음수·NaN 은 네트워크 전에 멈춘다", async () => {
		for (const q of [0, -1, Number.NaN]) {
			const reqs = fake();
			await assert.rejects(executeOrderAction({ kind: "place", broker: "toss", ...kr, side: "BUY", orderType: "MARKET", quantity: q, estimatedAmount: 1 }, NONCE, access()));
			assert.equal(reqs.length, 0, String(q));
		}
	});

	it("토큰의 증권사가 연결되어 있지 않으면 다른 증권사로 보내지 않고 멈춘다", async () => {
		const reqs = fake();
		const a = access();
		await assert.rejects(
			executeOrderAction({ kind: "place", broker: "kis", ...kr, side: "BUY", orderType: "MARKET", quantity: 1, estimatedAmount: 1 }, NONCE, { toss: a.toss }),
			/한국투자증권 연결이 없습니다/,
		);
		assert.equal(reqs.length, 0);
	});
});
