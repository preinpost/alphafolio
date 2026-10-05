/**
 * Binance 지갑 간 이동 — 돈이 움직이는 코드라 경로·요청을 한 글자씩 검사한다.
 * 준비(binance_wallet)는 토큰만 만들고, 실제 요청은 executeOrderAction 에서만 나간다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BinanceTransferAction, OrderAction } from "../src/actions.ts";
import { createBinanceWalletTool, type BinanceTransferCard } from "../src/binance/wallet-tool.ts";
import { transferRequest, transferRoute, validAmount } from "../src/binance/wallet.ts";
import { executeOrderAction } from "../src/execute.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const CREDS = { key: "BINKEY000111", secret: "BINSECRET222333" };

describe("이동 경로", () => {
	it("지갑 쌍 → API", () => {
		assert.deepEqual(transferRoute("SPOT", "FUNDING"), { kind: "universal", type: "MAIN_FUNDING" });
		assert.deepEqual(transferRoute("FUNDING", "SPOT"), { kind: "universal", type: "FUNDING_MAIN" });
		assert.deepEqual(transferRoute("EARN", "SPOT"), { kind: "redeem", destAccount: "SPOT" });
		assert.equal(transferRoute("EARN", "FUNDING"), null, "환매는 destAccount=SPOT 만 — Binance 가 FUND 를 HTTP 400 으로 거절");
		assert.deepEqual(transferRoute("SPOT", "EARN"), { kind: "subscribe", sourceAccount: "SPOT" });
		assert.deepEqual(transferRoute("FUNDING", "EARN"), { kind: "subscribe", sourceAccount: "FUND" });
		assert.equal(transferRoute("SPOT", "SPOT"), null);
	});

	it("수량 형식 — 양의 10진수 문자열만", () => {
		for (const ok of ["50", "0.5", "100.71309226"]) assert.equal(validAmount(ok), true, ok);
		for (const bad of ["0", "-1", "1e3", "1,000", "", " 5", "0.0"]) assert.equal(validAmount(bad), false, bad);
	});
});

const base = { kind: "binance-transfer", broker: "binance", asset: "USDT" } as const;

describe("요청 파라미터", () => {
	it("현물 → 펀딩: Universal Transfer", () => {
		const a: BinanceTransferAction = { ...base, from: "SPOT", to: "FUNDING", amount: "12.5", all: false, route: { kind: "universal", type: "MAIN_FUNDING" } };
		assert.deepEqual(transferRequest(a), { path: "/sapi/v1/asset/transfer", params: { type: "MAIN_FUNDING", asset: "USDT", amount: "12.5" } });
	});

	it("Earn → 현물: 수량 환매", () => {
		const a: BinanceTransferAction = { ...base, from: "EARN", to: "SPOT", amount: "50", all: false, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" };
		assert.deepEqual(transferRequest(a), { path: "/sapi/v1/simple-earn/flexible/redeem", params: { productId: "USDT001", amount: "50", destAccount: "SPOT" } });
	});

	it("Earn 전량은 redeemAll — 수량을 보내지 않는다 (이자가 붙어 준비 시점보다 많다)", () => {
		const a: BinanceTransferAction = { ...base, from: "EARN", to: "SPOT", amount: "100.7", all: true, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" };
		assert.deepEqual(transferRequest(a).params, { productId: "USDT001", redeemAll: "true", destAccount: "SPOT" });
	});

	it("펀딩 → Earn: 예치", () => {
		const a: BinanceTransferAction = { ...base, from: "FUNDING", to: "EARN", amount: "30", all: false, route: { kind: "subscribe", sourceAccount: "FUND" }, productId: "USDT001" };
		assert.deepEqual(transferRequest(a), { path: "/sapi/v1/simple-earn/flexible/subscribe", params: { productId: "USDT001", amount: "30", sourceAccount: "FUND" } });
	});
});

/** 실측(2026-10-03) 모양 — 현물 USDT 0 (LDUSDT 만), Earn 에 USDT 100.71 */
function fakeBinance() {
	const calls: Array<{ method: string; path: string; q: URLSearchParams }> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		calls.push({ method: init?.method ?? "GET", path: u.pathname, q: u.searchParams });
		const json = (b: unknown) => new Response(JSON.stringify(b));
		if (u.pathname === "/api/v3/account")
			return json({ balances: [{ asset: "ETH", free: "0.00005700", locked: "0" }, { asset: "LDUSDT", free: "88.49917410", locked: "0" }, { asset: "BNB", free: "0.1", locked: "0.05" }] });
		if (u.pathname === "/sapi/v1/asset/get-funding-asset") return json([{ asset: "USDC", free: "0.00475663", locked: "0", freeze: "0", withdrawing: "0" }]);
		if (u.pathname === "/sapi/v1/simple-earn/flexible/position")
			return json({ total: 1, rows: [{ asset: "USDT", totalAmount: "100.71309226", productId: "USDT001", latestAnnualPercentageRate: "0.02687045", canRedeem: true }] });
		if (u.pathname === "/sapi/v1/simple-earn/flexible/list") return json({ total: 1, rows: [{ asset: "USDC", productId: "USDC001", canPurchase: true, isSoldOut: false, minPurchaseAmount: "1" }] });
		if (u.pathname === "/sapi/v1/simple-earn/flexible/redeem") return json({ redeemId: 40607, success: true });
		return json({});
	}) as typeof fetch;
	const prepared: OrderAction[] = [];
	const tool = createBinanceWalletTool({ brokers: { binance: () => CREDS }, prepareOrder: (a) => (prepared.push(a), { token: "tok", expiresAt: 1 }) });
	const run = (p: Record<string, unknown>) =>
		tool.execute("id", p as never, undefined, undefined, undefined as never) as Promise<{ content: Array<{ text: string }>; details: BinanceTransferCard }>;
	return { calls, prepared, run };
}

describe("binance_wallet — 잔고", () => {
	it("현물·펀딩·Earn 을 함께 — LD* 영수증은 빼고 Earn 원금으로", async () => {
		const { run, calls } = fakeBinance();
		const r = await run({ action: "balances" });
		const text = r.content[0]!.text;
		assert.match(text, /현물\(Spot\): ETH 0\.000057 · BNB 0\.1 \(묶임 0\.05\)/);
		assert.match(text, /펀딩\(Funding\): USDC 0\.00475663/);
		assert.match(text, /Earn 유연 예치: USDT 100\.71309226 \(연 2\.69%\)/);
		assert.doesNotMatch(text, /LDUSDT/);
		assert.ok(calls.every((c) => c.method === "GET" || c.path === "/sapi/v1/asset/get-funding-asset"), "잔고 조회는 쓰기를 보내지 않는다");
	});
});

describe("binance_wallet — 이동 준비 (토큰만, 요청은 안 나간다)", () => {
	it("Earn → 현물 50 USDT — 상품 ID 는 서버가 보유 내역에서 찾는다", async () => {
		const { run, prepared, calls } = fakeBinance();
		const r = await run({ action: "transfer", from: "EARN", to: "SPOT", asset: "usdt", amount: "50" });
		assert.equal(r.details.ok, true, r.details.errors.join(" / "));
		assert.equal(r.details.token, "tok");
		assert.deepEqual(prepared, [
			{ kind: "binance-transfer", broker: "binance", from: "EARN", to: "SPOT", asset: "USDT", amount: "50", all: false, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" },
		]);
		assert.equal(calls.filter((c) => c.method === "POST" && c.path !== "/sapi/v1/asset/get-funding-asset").length, 0, "준비 단계는 이동 요청을 보내지 않는다");
	});

	it("전량 — 카드에 가용 수량, 액션은 all", async () => {
		const { run, prepared } = fakeBinance();
		const r = await run({ action: "transfer", from: "EARN", to: "SPOT", asset: "USDT", all: true });
		assert.equal(r.details.amount, "100.71309226");
		assert.equal((prepared[0] as BinanceTransferAction).all, true);
	});

	it("가용보다 많으면 준비하지 않는다", async () => {
		const { run, prepared } = fakeBinance();
		const r = await run({ action: "transfer", from: "EARN", to: "SPOT", asset: "USDT", amount: "999" });
		assert.equal(r.details.ok, false);
		assert.equal(prepared.length, 0);
		assert.ok(r.details.errors.some((e) => e.includes("100.71309226")));
	});

	it("현물의 LDUSDT 는 USDT 가 아니다 — 현물 → 펀딩 USDT 는 없다고 거절", async () => {
		const { run, prepared } = fakeBinance();
		const r = await run({ action: "transfer", from: "SPOT", to: "FUNDING", asset: "USDT", amount: "10" });
		assert.equal(r.details.ok, false);
		assert.equal(prepared.length, 0);
		assert.ok(r.details.errors.some((e) => e.includes("옮길 수 있는 USDT")));
	});

	it("같은 지갑·잘못된 수량·자산 이름은 거절", async () => {
		const { run, prepared } = fakeBinance();
		for (const p of [
			{ from: "SPOT", to: "SPOT", asset: "ETH", amount: "0.00001" },
			{ from: "EARN", to: "SPOT", asset: "USDT", amount: "1e2" },
			{ from: "EARN", to: "SPOT", asset: "US DT", amount: "1" },
			{ from: "EARN", to: "SPOT", asset: "USDT" },
		]) {
			const r = await run({ action: "transfer", ...p });
			assert.equal(r.details.ok, false, JSON.stringify(p));
		}
		assert.equal(prepared.length, 0);
	});

	it("Earn → 펀딩은 준비하지 않는다 — 현물을 거쳐 두 번 옮기라고 안내", async () => {
		const { run, prepared, calls } = fakeBinance();
		const r = await run({ action: "transfer", from: "EARN", to: "FUNDING", asset: "USDT", all: true });
		assert.equal(r.details.ok, false);
		assert.equal(prepared.length, 0);
		assert.ok(r.details.errors.some((e) => e.includes("현물로만")));
		assert.equal(calls.length, 0, "지갑 조회도 하지 않는다");
	});

	it("펀딩 → Earn — 예치 상품·최소 수량은 상품 목록에서", async () => {
		const { run, prepared } = fakeBinance();
		const tooSmall = await run({ action: "transfer", from: "FUNDING", to: "EARN", asset: "USDC", all: true });
		assert.equal(tooSmall.details.ok, false);
		assert.ok(tooSmall.details.errors.some((e) => e.includes("최소 수량은 1")));
		assert.equal(prepared.length, 0);
	});

	it("prepareOrder 가 없으면 이동을 준비하지 않는다", async () => {
		fakeBinance();
		const tool = createBinanceWalletTool({ brokers: { binance: () => CREDS } });
		await assert.rejects(tool.execute("id", { action: "transfer", from: "EARN", to: "SPOT", asset: "USDT", amount: "1" } as never, undefined, undefined, undefined as never), /비활성/);
	});
});

describe("실행 (확인 카드 [확인] 뒤 서버만 부른다)", () => {
	it("Earn 환매 — 서명된 POST 한 번, 재시도 없음", async () => {
		const { calls } = fakeBinance();
		const a: BinanceTransferAction = { ...base, from: "EARN", to: "SPOT", amount: "50", all: false, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" };
		const r = await executeOrderAction(a, "afNONCE", { binance: () => CREDS });
		assert.equal(r.orderId, "40607");
		assert.match(r.message, /Earn 유연 예치 → 현물\(Spot\) 50 USDT 이동이 접수/);
		assert.equal(calls.length, 1);
		const c = calls[0]!;
		assert.equal(c.method, "POST");
		assert.equal(c.path, "/sapi/v1/simple-earn/flexible/redeem");
		assert.equal(c.q.get("productId"), "USDT001");
		assert.equal(c.q.get("amount"), "50");
		assert.equal(c.q.get("destAccount"), "SPOT");
		assert.ok(c.q.get("signature"), "서명");
	});

	it("토큰 값이 이상하면 요청 전에 멈춘다", async () => {
		const { calls } = fakeBinance();
		const bad: BinanceTransferAction = { ...base, from: "EARN", to: "SPOT", amount: "-5", all: false, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" };
		await assert.rejects(executeOrderAction(bad, "n", { binance: () => CREDS }), /이동 수량이 올바르지 않습니다/);
		assert.equal(calls.length, 0);
	});

	it("Binance 가 success=false 면 실패로", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ redeemId: 1, success: false }))) as typeof fetch;
		const a: BinanceTransferAction = { ...base, from: "EARN", to: "SPOT", amount: "1", all: false, route: { kind: "redeem", destAccount: "SPOT" }, productId: "USDT001" };
		await assert.rejects(executeOrderAction(a, "n", { binance: () => CREDS }), /거절/);
	});
});
