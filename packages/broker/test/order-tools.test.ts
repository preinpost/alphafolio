/**
 * 정정·취소·조건주문 준비 툴 (PLAN §34).
 *
 * 지켜야 할 것:
 *   - 원주문 값(수량·가격)은 **서버가 증권사 미체결 목록에서** 가져온다 — 모델이 준 값이 아니다
 *   - 미체결 목록에 없는 주문(체결·취소됨·오타)은 준비하지 않는다
 *   - 토스 미국 수량 정정·한국투자 미국 시장가 정정·바뀌는 것 없는 정정은 막는다
 *   - 조건주문은 규격 규칙(OCO 매도·매도 + 익절 > 현재가 > 손절, OTO 매수→매도, 지정가, 미래 만료일)
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { OrderAction } from "../src/actions.ts";
import { createOrderTools, resolveExpireDate, validateConditional, type OrderChangeDetails } from "../src/order-tools.ts";
import type { ConditionalSpec } from "../src/actions.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const NOW = Date.UTC(2026, 8, 23, 3, 0); // KST 2026-09-23 12:00

describe("조건주문 규칙", () => {
	const base = (o: Partial<ConditionalSpec> = {}): ConditionalSpec => ({
		symbol: "005930", market: "KR", currency: "KRW", type: "OCO", quantity: 3, orderType: "LIMIT", expireDate: "2026-10-23",
		first: { side: "SELL", triggerPrice: 75000, orderPrice: 74900 },
		second: { side: "SELL", triggerPrice: 65000, orderPrice: 64900 },
		...o,
	});

	it("정상 OCO 는 통과", () => {
		assert.deepEqual(validateConditional(base(), 70000, NOW).errors, []);
	});

	it("OCO 는 익절 감시가 > 현재가 > 손절 감시가 (뒤바뀌면 거절)", () => {
		const r = validateConditional(base({ first: { side: "SELL", triggerPrice: 65000, orderPrice: 64900 }, second: { side: "SELL", triggerPrice: 75000, orderPrice: 74900 } }), 70000, NOW);
		assert.ok(r.errors.some((e) => e.includes("익절 감시가")), r.errors.join(" / "));
	});

	it("OCO 는 둘 다 매도, 지정가만", () => {
		assert.ok(validateConditional(base({ first: { side: "BUY", triggerPrice: 75000, orderPrice: 1 } }), 70000, NOW).errors.some((e) => e.includes("매도")));
		assert.ok(validateConditional(base({ orderType: "MARKET" }), 70000, NOW).errors.some((e) => e.includes("지정가")));
	});

	it("OTO 는 매수 → 매도", () => {
		const ok = base({ type: "OTO", first: { side: "BUY", triggerPrice: 68000, orderPrice: 68000 }, second: { side: "SELL", triggerPrice: 75000, orderPrice: 74900 } });
		assert.deepEqual(validateConditional(ok, 70000, NOW).errors, []);
		const bad = base({ type: "OTO", first: { side: "SELL", triggerPrice: 68000, orderPrice: 68000 } });
		assert.ok(validateConditional(bad, 70000, NOW).errors.some((e) => e.includes("OTO")));
	});

	it("지정가면 주문가 필수, 두 번째 조건이 없으면 OCO 불가", () => {
		assert.ok(validateConditional(base({ first: { side: "SELL", triggerPrice: 75000 } }), 70000, NOW).errors.some((e) => e.includes("주문가")));
		const { second: _s, ...noSecond } = base();
		assert.ok(validateConditional(noSecond as ConditionalSpec, 70000, NOW).errors.some((e) => e.includes("second")));
	});

	it("만료일은 오늘 이후, 형식 YYYY-MM-DD", () => {
		assert.ok(validateConditional(base({ expireDate: "2026-09-23" }), 70000, NOW).errors.some((e) => e.includes("오늘 이후")));
		assert.ok(validateConditional(base({ expireDate: "10/23" }), 70000, NOW).errors.some((e) => e.includes("형식")));
	});

	it("감시가가 현재가와 50% 넘게 벌어지면 자릿수 오타로 막는다", () => {
		assert.ok(validateConditional(base({ first: { side: "SELL", triggerPrice: 750000, orderPrice: 749000 } }), 70000, NOW).errors.some((e) => e.includes("자릿수")));
	});

	it("호가단위에 안 맞는 가격은 보정하고 알린다", () => {
		const r = validateConditional(base({ first: { side: "SELL", triggerPrice: 75003, orderPrice: 74907 } }), 70000, NOW);
		assert.equal(r.spec.first.triggerPrice, 75000);
		assert.equal(r.spec.first.orderPrice, 74900);
		assert.ok(r.warnings.some((w) => w.includes("호가단위")));
	});

	it("SINGLE 은 두 번째 조건을 버린다", () => {
		const r = validateConditional(base({ type: "SINGLE" }), 70000, NOW);
		assert.deepEqual(r.errors, []);
		assert.equal(r.spec.second, undefined);
	});

	it("만료일 토큰은 KST 기준", () => {
		assert.equal(resolveExpireDate("today+30", NOW), "2026-10-23");
		assert.equal(resolveExpireDate("2026-12-31", NOW), "2026-12-31");
	});
});

// ── order_change — 가짜 토스 ────────────────────────────────

let seq = 0;
function tossOnly(openOrders: unknown[], price = "70000", symbolPrice: Record<string, string> = {}): { access: { toss: () => TossContext }; hits: string[] } {
	const hits: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input));
		const json = (b: unknown) => new Response(JSON.stringify(b));
		hits.push(`${url.pathname}`);
		if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json({ result: [{ accountSeq: 7 }] });
		if (url.pathname === "/api/v1/orders") return json({ result: { orders: openOrders } });
		if (url.pathname === "/api/v1/prices") {
			const sym = url.searchParams.get("symbols") ?? "";
			return json({ result: [{ symbol: sym, lastPrice: symbolPrice[sym] ?? price, currency: /^\d{6}$/.test(sym) ? "KRW" : "USD" }] });
		}
		if (url.pathname === "/api/v1/stocks") return json({ result: [{ symbol: url.searchParams.get("symbols"), name: "삼성전자" }] });
		return json({ result: {} });
	}) as typeof fetch;
	seq++;
	const ctx: TossContext = { creds: { clientId: `c${seq}-${Math.random()}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `u${seq}` };
	return { access: { toss: () => ctx }, hits };
}

const tossOrder = (o: Record<string, unknown> = {}) => ({
	orderId: "T-1", symbol: "005930", side: "BUY", orderType: "LIMIT", timeInForce: "DAY", status: "OPEN",
	price: "70000", quantity: "10", currency: "KRW", orderedAt: "2026-09-23T09:12:00+09:00", canceledAt: null,
	execution: { filledQuantity: "3", averageFilledPrice: null, filledAmount: null, commission: null, tax: null, filledAt: null },
	...o,
});

async function run(access: { toss: () => TossContext }, params: Record<string, unknown>): Promise<{ text: string; details: OrderChangeDetails; prepared: OrderAction[] }> {
	const prepared: OrderAction[] = [];
	const [change] = createOrderTools({ brokers: access, prepareOrder: (a) => (prepared.push(a), { token: "tok", expiresAt: 1 }) });
	const r = (await change!.execute("id", params as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }>; details: OrderChangeDetails };
	return { text: r.content[0]!.text, details: r.details, prepared };
}

describe("order_change", () => {
	it("orderId 가 없으면 미체결 목록 (미체결 = 주문 − 체결)", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "cancel" });
		assert.match(r.text, /orderId=T-1/);
		assert.match(r.text, /미체결 7주/);
		assert.equal(r.prepared.length, 0);
	});

	it("취소 — 원주문 값은 증권사 목록에서 (모델은 id 만 줬다)", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "cancel", orderId: "T-1" });
		assert.equal(r.prepared.length, 1);
		const a = r.prepared[0]!;
		assert.equal(a.kind, "cancel");
		assert.equal(a.kind === "cancel" && a.original.openQuantity, 7);
		assert.equal(a.kind === "cancel" && a.original.price, 70000);
		assert.equal(a.kind === "cancel" && a.broker, "toss");
	});

	it("모델이 수량·가격을 같이 넘겨도 원주문 값은 증권사 조회값 (취소 100주로 부풀리기 차단)", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "cancel", orderId: "T-1", quantity: 100, price: 1 });
		const a = r.prepared[0]!;
		assert.equal(a.kind === "cancel" && a.original.openQuantity, 7);
		assert.equal(a.kind === "cancel" && a.original.price, 70000);
	});

	it("정정에서도 원주문(before)은 조회값 — 모델 값은 '바뀐 뒤' 에만", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "modify", orderId: "T-1", quantity: 5, price: 69500 });
		const a = r.prepared[0]!;
		assert.equal(a.kind === "modify" && a.original.openQuantity, 7);
		assert.equal(a.kind === "modify" && a.original.price, 70000);
		assert.equal(a.kind === "modify" && a.quantity, 5);
	});

	it("목록에 없는 주문은 준비하지 않는다 (체결·취소됨·오타)", async () => {
		const { access } = tossOnly([tossOrder()]);
		await assert.rejects(run(access, { action: "cancel", orderId: "T-없음" }), /미체결 목록에 없는 주문/);
	});

	it("다 체결된 주문은 미체결이 아니다", async () => {
		const { access } = tossOnly([tossOrder({ execution: { filledQuantity: "10" } })]);
		await assert.rejects(run(access, { action: "cancel", orderId: "T-1" }), /미체결 목록에 없는/);
	});

	it("정정 — 수량을 비우면 미체결 수량 그대로, 가격만 바꾼다", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "modify", orderId: "T-1", price: 69500 });
		const a = r.prepared[0]!;
		assert.equal(a.kind === "modify" && a.quantity, 7);
		assert.equal(a.kind === "modify" && a.price, 69500);
	});

	it("미체결 수량보다 많이 정정할 수 없다", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "modify", orderId: "T-1", quantity: 8, price: 69500 });
		assert.equal(r.prepared.length, 0);
		assert.match(r.text, /미체결 수량\(7\)보다 많습니다/);
	});

	it("바뀌는 것이 없는 정정은 막는다", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "modify", orderId: "T-1", price: 70000 });
		assert.equal(r.prepared.length, 0);
		assert.match(r.text, /바뀌는 것이 없습니다/);
	});

	it("토스 미국 주식은 수량 정정을 막는다 (규격)", async () => {
		const { access } = tossOnly([tossOrder({ orderId: "T-US", symbol: "AAPL", price: "190", currency: "USD" })], "190");
		const r = await run(access, { action: "modify", orderId: "T-US", quantity: 5, price: 189 });
		assert.equal(r.prepared.length, 0);
		assert.match(r.text, /수량을 정정할 수 없습니다/);
	});

	it("정정 가격도 호가단위·자릿수 검사 (신규 주문과 같은 규칙)", async () => {
		const { access } = tossOnly([tossOrder()]);
		const r = await run(access, { action: "modify", orderId: "T-1", price: 695000 });
		assert.equal(r.prepared.length, 0);
		assert.match(r.text, /자릿수/);
	});
});
