/**
 * 통합 자산 현황 — 계좌 어댑터(KIS·토스·Binance)를 합치는 집계.
 *
 * 지켜야 할 것:
 * - 환율은 하나만 (토스 실시간 우선) — 코인·해외 주식·달러 예수금이 같은 환율로 원화가 된다
 * - 기존 필드(주식·원화 예수금·달러 예수금)의 뜻은 그대로, 환산 합계는 netWorthKrw 에만
 * - 한 계좌·한 지갑이 실패해도 나머지는 보여 주고 무엇이 빠졌는지 알린다
 * - 주식만 보는 곳(STOCK_SOURCES)은 코인 거래소를 부르지 않는다
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { allocationOf, currencySplit, fetchPortfolio, NoBrokerConfiguredError, pickUsdKrw, STOCK_SOURCES } from "../src/portfolio.ts";
import { clearBStockCache } from "../src/binance/bstocks.ts";
import { toOverseasHoldings, type ManualAsset } from "../src/normalize.ts";
import { clearEquityRulesCache } from "../src/binance/stocks.ts";
import { clearCoinCostCache, clearPublicFxCache, coinCostBasis, equityHolding, equityPositions, equityTicker, mergeCrypto, usdPrice, withCost } from "../src/sources/index.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearBStockCache();
	clearEquityRulesCache();
	clearCoinCostCache();
	clearPublicFxCache();
});

const CREDS = { key: "BINKEY000111", secret: "BINSECRET222333" };

describe("코인 가격 (순수)", () => {
	const prices = new Map([
		["BTCUSDT", 100_000],
		["WLDUSDC", 2],
		["USDCUSDT", 0.9998],
	]);

	it("USDT 는 1, 그 외는 USDT → USDC → FDUSD 마켓 순", () => {
		assert.equal(usdPrice("USDT", prices), 1);
		assert.equal(usdPrice("BTC", prices), 100_000);
		assert.equal(usdPrice("WLD", prices), 2);
		assert.equal(usdPrice("USDC", prices), 0.9998);
	});

	it("스테이블은 마켓이 없어도 1, 그 외는 null (0으로 만들지 않는다)", () => {
		assert.equal(usdPrice("FDUSD", prices), 1);
		assert.equal(usdPrice("NOPE", prices), null);
	});
});

describe("지갑 합치기 (순수)", () => {
	it("자산별로 합치고 free + locked 를 모두 센다, 평가금액 순", () => {
		const out = mergeCrypto(
			[
				{ wallet: "SPOT", assets: [{ asset: "BTC", free: "0.1", locked: "0.05" }, { asset: "USDT", free: "10" }] },
				{ wallet: "EARN", assets: [{ asset: "USDT", free: "90" }, { asset: "BTC", free: "0.05" }] },
			],
			new Map([["BTCUSDT", 100_000]]),
		);
		assert.deepEqual(
			out.map((c) => [c.asset, c.quantity, c.valueUsd, c.stable]),
			[
				["BTC", 0.2, 20_000, false],
				["USDT", 100, 100, true],
			],
		);
		assert.deepEqual(out[0]!.wallets, [
			{ wallet: "SPOT", quantity: 0.15000000000000002 },
			{ wallet: "EARN", quantity: 0.05 },
		]);
	});

	it("시세가 없으면 수량만 (평가 null)", () => {
		const out = mergeCrypto([{ wallet: "SPOT", assets: [{ asset: "BTC", free: "1" }] }], null);
		assert.equal(out[0]!.quantity, 1);
		assert.equal(out[0]!.valueUsd, null);
	});
});

describe("환율·배분 (순수)", () => {
	it("토스 실시간 환율이 KIS 고시 환율보다 먼저", () => {
		assert.equal(pickUsdKrw([{ id: "kis", usdKrw: 1360 }, { id: "toss", usdKrw: 1368 }]), 1368);
		assert.equal(pickUsdKrw([{ id: "kis", usdKrw: 1360 }, { id: "toss", usdKrw: 0 }]), 1360);
		assert.equal(pickUsdKrw([{ id: "binance", usdKrw: 0 }]), 0);
	});

	it("스테이블코인·달러 예수금은 현금성", () => {
		const a = allocationOf({
			holdings: [],
			crypto: [
				{ source: "binance", asset: "BTC", quantity: 1, wallets: [], priceUsd: 1, valueUsd: 1, valueKrw: 1000, stable: false },
				{ source: "binance", asset: "USDT", quantity: 1, wallets: [], priceUsd: 1, valueUsd: 1, valueKrw: 500, stable: true },
			],
			cashKrw: 100,
			cashUsd: 2,
			usdKrw: 1000,
		});
		assert.deepEqual(a, { domesticStock: 0, overseasStock: 0, crypto: 1000, cash: 2600, other: 0 });
	});
});

// ── 집계 (fetch 흉내) ──────────────────────────────────────────

let seq = 0;

interface FakeOpts {
	/** 공개 환율(Frankfurter) 응답 — 없으면 404 */
	publicFx?: number;
	/** 실패시킬 Binance 경로 */
	binanceFail?: string[];
	/** Binance 미국 주식 체결 (NVDA 1.5주 평단 110, TSLA 1주 — TSLA 는 Binance 호가 없음) */
	equity?: boolean;
	/** 펀딩 지갑에 bStock 토큰 AAPLB 2개 */
	bstock?: boolean;
	/** 현물 지갑의 주식 잔고 (EQ_ 자산) — 예 { EQ_NVDA: "1.2" } */
	eqWallet?: Record<string, string>;
	/** 토스 응답을 멈춘다 (제한 시간 확인) */
	tossHang?: boolean;
}

/** 토스 + Binance — 호스트로 나눈다 */
function fake(opts: FakeOpts = {}) {
	const hits: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input));
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		if (url.hostname.includes("binance")) {
			hits.push(`binance${url.pathname}`);
			if (opts.binanceFail?.includes(url.pathname)) return json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401);
			switch (url.pathname) {
				case "/api/v3/account":
					return json({
						balances: [
							{ asset: "BTC", free: "0.01", locked: "0" },
							{ asset: "LDUSDT", free: "50", locked: "0" },
							{ asset: "SHIB", free: "100", locked: "0" },
							...Object.entries(opts.eqWallet ?? {}).map(([asset, free]) => ({ asset, free, locked: "0" })),
						],
					});
				case "/sapi/v1/asset/get-funding-asset":
					return json([
						{ asset: "USDC", free: "20", locked: "0", freeze: "0", withdrawing: "0" },
						...(opts.bstock ? [{ asset: "AAPLB", free: "2", locked: "0", freeze: "0", withdrawing: "0" }] : []),
					]);
				case "/api/v3/referencePrice/calculation":
					// bStock 은 선물 지수(EXTERNAL #2) 기준가
					return json(url.searchParams.get("symbol") === "AAPLBUSDT" ? { calculationType: "EXTERNAL", externalCalculationId: 2 } : { calculationType: "ARITHMETIC_MEAN" });
				case "/sapi/v1/equity/trade/history": {
					const rows = opts.equity
						? [
								{ symbol: "NVDA", side: "BUY", qty: "1", price: "100", executionAt: 1 },
								{ symbol: "NVDA", side: "BUY", qty: "1", price: "120", executionAt: 2 },
								{ symbol: "NVDA", side: "SELL", qty: "0.5", price: "125", executionAt: 3 },
								{ symbol: "TSLA", side: "BUY", qty: "1", price: "200", executionAt: 4 },
							]
						: [];
					return json({ total: rows.length, rows });
				}
				case "/api/v3/myTrades": {
					// BTC: 0.02 를 $50,000 에 사고(수수료 0.0001 BTC) 0.0099 를 팔았다 → 0.0100 남음, 평단 1000 / 0.0199
					if (url.searchParams.get("symbol") !== "BTCUSDT" || url.searchParams.get("fromId") !== "0") return json([]);
					return json([
						{ id: 1, price: "50000", qty: "0.02", quoteQty: "1000", commission: "0.0001", commissionAsset: "BTC", time: 1, isBuyer: true },
						{ id: 2, price: "60000", qty: "0.0099", quoteQty: "594", commission: "0.5", commissionAsset: "USDT", time: 2, isBuyer: false },
					]);
				}
				case "/sapi/v1/equity/market/quote":
					return url.searchParams.get("symbol") === "NVDA" ? json({ bidPrice: "130", askPrice: "132" }) : new Response("");
				case "/sapi/v1/simple-earn/flexible/position":
					return json({ total: 1, rows: [{ asset: "USDT", totalAmount: "50", productId: "USDT001" }] });
				case "/sapi/v1/simple-earn/locked/position":
					return json({ total: 1, rows: [{ asset: "ETH", amount: "0.5" }] });
				case "/api/v3/ticker/price":
					return json([
						{ symbol: "BTCUSDT", price: "100000" },
						{ symbol: "ETHUSDT", price: "4000" },
						{ symbol: "USDCUSDT", price: "1" },
						{ symbol: "AAPLBUSDT", price: "351" },
					]);
			}
			return json({ code: -1, msg: `없는 경로 ${url.pathname}` }, 404);
		}
		if (url.hostname === "api.frankfurter.dev") {
			hits.push("frankfurter");
			return opts.publicFx ? json({ amount: 1, base: "USD", date: "2026-10-02", rates: { KRW: opts.publicFx } }) : json({ message: "not found" }, 404);
		}
		hits.push(`toss${url.pathname}`);
		if (opts.tossHang) return new Promise<Response>(() => {});
		if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json([{ accountSeq: 7 }]);
		if (url.pathname === "/api/v1/holdings") {
			return json({
				items: [
					{ symbol: "AAPL", name: "애플", currency: "USD", marketCountry: "US", quantity: "1", averagePurchasePrice: "300", lastPrice: "350", marketValue: { amount: "350" }, profitLoss: { amount: "50", rate: "0.1667" } },
					{ symbol: "005930", name: "삼성전자", currency: "KRW", marketCountry: "KR", quantity: "10", averagePurchasePrice: "70000", lastPrice: "80000", marketValue: { amount: "800000" }, profitLoss: { amount: "100000", rate: "0.1429" } },
				],
			});
		}
		if (url.pathname === "/api/v1/buying-power") {
			return json({ cashBuyingPower: url.searchParams.get("currency") === "KRW" ? "1000000" : "100" });
		}
		if (url.pathname === "/api/v1/exchange-rate") return json({ rate: "1400", midRate: "1400" });
		if (url.pathname === "/api/v1/prices") return json([{ symbol: url.searchParams.get("symbols"), lastPrice: "250", currency: "USD" }]);
		return json({ error: { message: `없는 경로 ${url.pathname}` } }, 404);
	}) as typeof fetch;
	const toss: TossContext = { creds: { clientId: `src${++seq}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `src${seq}` };
	return { hits, toss: () => toss, binance: () => CREDS };
}

describe("통합 집계", () => {
	it("토스 + Binance — 환율 하나로 환산하고 계좌별 합계를 낸다", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });

		// 기존 필드의 뜻은 그대로 — 주식·원화 예수금·달러 예수금(환산 전)
		assert.equal(p.stockValueKrw, 350 * 1400 + 800_000);
		assert.equal(p.cashKrw, 1_000_000);
		assert.equal(p.cashUsd, 100);
		assert.deepEqual(p.brokers, ["toss"], "brokers 는 증권사만");

		// 코인: BTC 0.01 = $1,000 · ETH(Earn 고정) 0.5 = $2,000 · USDT(Earn 유연) 50 · USDC(펀딩) 20 · SHIB 시세 없음
		const by = Object.fromEntries(p.crypto.map((c) => [c.asset, c]));
		assert.equal(by.BTC?.valueKrw, 1000 * 1400);
		assert.equal(by.ETH?.valueKrw, 2000 * 1400);
		assert.deepEqual(by.ETH?.wallets, [{ wallet: "EARN_LOCKED", quantity: 0.5 }]);
		assert.equal(by.USDT?.stable, true);
		assert.equal(by.SHIB?.valueUsd, null);
		assert.equal(by.LDUSDT, undefined, "Earn 영수증은 빼고 원금(Earn 유연)으로");
		assert.equal(p.cryptoValueKrw, (1000 + 2000 + 50 + 20) * 1400);

		assert.deepEqual(p.allocation, {
			domesticStock: 800_000,
			overseasStock: 350 * 1400,
			crypto: 3000 * 1400,
			cash: 1_000_000 + 100 * 1400 + 70 * 1400,
			other: 0,
		});
		assert.equal(p.netWorthKrw, 800_000 + 350 * 1400 + 3000 * 1400 + 1_000_000 + 170 * 1400);

		assert.deepEqual(
			p.sources.map((s) => [s.id, s.status, s.valueKrw]),
			[
				["toss", "ok", 800_000 + 350 * 1400 + 1_000_000 + 100 * 1400],
				["binance", "partial", 3070 * 1400],
			],
		);
		assert.ok(p.warnings.some((w) => w.includes("SHIB")), "시세 없는 자산은 합계에서 뺐다고 알린다");

		// 화폐별 — 원화(삼성전자·원화 예수금) · 달러(AAPL·달러 예수금) · 코인(USDT 환산, 스테이블 포함)
		assert.deepEqual(p.byCurrency, { krw: 1_800_000, usd: 450, usdt: 3070 });
		assert.deepEqual(p.byCurrencyKrw, { krw: 1_800_000, usd: 450 * 1400, usdt: 3070 * 1400 });
		assert.equal(p.byCurrencyKrw.krw + p.byCurrencyKrw.usd + p.byCurrencyKrw.usdt, p.netWorthKrw, "환산 합계가 총자산");
		assert.deepEqual(
			p.sources.map((s) => [s.id, s.byCurrency]),
			[
				["toss", { krw: 1_800_000, usd: 450, usdt: 0 }],
				["binance", { krw: 0, usd: 0, usdt: 3070 }],
			],
		);
	});

	it("화폐별 (순수) — 달러 직접 입력은 달러로, 환율이 없어도 원래 통화 금액은 남는다", () => {
		const s = currencySplit({
			holdings: [],
			crypto: [],
			manual: [{ id: "m", name: "달러 예금", kind: "deposit", currency: "USD", amount: 1000.5, memo: null, updatedAt: "2026-10-01" }],
			cashKrw: 5000,
			cashUsd: 0.1 + 0.2,
			usdKrw: 0,
		});
		assert.deepEqual(s.amount, { krw: 5000, usd: 1000.8, usdt: 0 });
		assert.deepEqual(s.krw, { krw: 5000, usd: 0, usdt: 0 });
	});

	it("Binance 만 있고 환율이 없으면 — 던지지 않고, 환산 못 한 것을 알린다", async () => {
		const f = fake();
		const p = await fetchPortfolio({ binance: f.binance });
		assert.equal(p.netWorthKrw, 0);
		assert.equal(p.crypto.find((c) => c.asset === "BTC")?.valueUsd, 1000, "달러 평가는 남는다");
		assert.ok(p.warnings.some((w) => w.includes("환율")), p.warnings.join(" / "));
	});

	it("지갑 하나만 실패하면 partial — 나머지 지갑은 그대로", async () => {
		const f = fake({ binanceFail: ["/sapi/v1/simple-earn/flexible/position"] });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		const b = p.sources.find((s) => s.id === "binance")!;
		assert.equal(b.status, "partial");
		assert.ok(b.warnings.some((w) => w.includes("Earn 유연")), b.warnings.join(" / "));
		assert.ok(p.crypto.some((c) => c.asset === "BTC"));
	});

	it("지갑을 하나도 못 읽으면 그 계좌만 failed — 0원으로 보이지 않게 경고", async () => {
		const f = fake({ binanceFail: ["/api/v3/account", "/sapi/v1/asset/get-funding-asset", "/sapi/v1/simple-earn/flexible/position"] });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		const b = p.sources.find((s) => s.id === "binance")!;
		assert.equal(b.status, "failed");
		assert.match(b.error ?? "", /Invalid API-key/);
		assert.ok(p.warnings.some((w) => w.startsWith("Binance 조회 실패")));
		assert.deepEqual(p.crypto, []);
		assert.equal(p.sources.find((s) => s.id === "toss")?.status, "ok");
	});

	it("테스트넷 키는 모의 잔고라 skipped — 요청하지 않는다", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, binance: () => ({ ...CREDS, testnet: true }) });
		assert.equal(p.sources.find((s) => s.id === "binance")?.status, "skipped");
		assert.ok(!f.hits.some((h) => h.startsWith("binance")));
		assert.deepEqual(p.crypto, []);
	});

	it("주식만 보는 곳(STOCK_SOURCES)은 Binance 를 부르지 않는다", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance }, { sources: STOCK_SOURCES });
		assert.ok(!f.hits.some((h) => h.startsWith("binance")));
		assert.equal(p.holdings.length, 2);
		assert.deepEqual(p.sources.map((s) => s.id), ["toss"]);
	});

	it("STOCK_SOURCES 인데 증권사가 없으면 NoBrokerConfiguredError (Binance 만 있어도)", async () => {
		const f = fake();
		await assert.rejects(fetchPortfolio({ binance: f.binance }, { sources: STOCK_SOURCES }), NoBrokerConfiguredError);
	});

	it("자격증명 접근자가 throw 하면 미설정 — 경고 없이 뺀다", async () => {
		const f = fake();
		const p = await fetchPortfolio({
			toss: f.toss,
			binance: () => {
				throw new Error("Binance 키가 없습니다");
			},
		});
		assert.deepEqual(p.sources.map((s) => s.id), ["toss"]);
		assert.deepEqual(p.warnings, []);
	});

	it("응답이 없는 계좌는 제한 시간 뒤 failed — 다른 계좌를 막지 않는다", async () => {
		const f = fake({ tossHang: true });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance }, { timeoutMs: 50 });
		assert.equal(p.sources.find((s) => s.id === "toss")?.status, "failed");
		assert.match(p.sources.find((s) => s.id === "toss")?.error ?? "", /응답이 없어/);
		assert.ok(p.crypto.length > 0);
	});
});

describe("Binance 미국 주식 · bStock", () => {
	it("체결 내역 추정 보유 → 주식 잔고 (순수) — 평단이 있으면 손익, 가격이 없으면 평가 0", () => {
		const h = equityHolding({ symbol: "NVDA", qty: 1.5, avgPrice: 110, fills: 3 }, 131);
		assert.deepEqual(
			[h.broker, h.market, h.currency, h.value, h.profit, h.profitPct, h.note],
			["binance", "overseas", "USD", 196.5, 31.5, 19.09, "체결 내역 추정"],
		);
		const none = equityHolding({ symbol: "TSLA", qty: 1, avgPrice: null, fills: 1 }, null);
		assert.equal(none.value, 0);
		assert.equal(none.avgPrice, 0, "평단 모름 = 0");
	});

	it("미국 주식은 holdings 로 — Binance 호가 중간값, 호가가 없으면 본주 시세(토스)", async () => {
		const f = fake({ equity: true });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		const nvda = p.holdings.find((h) => h.broker === "binance" && h.symbol === "NVDA")!;
		assert.equal(nvda.quantity, 1.5);
		assert.equal(nvda.avgPrice, 110);
		assert.equal(nvda.price, 131);
		assert.equal(nvda.valueKrw, Math.round(196.5 * 1400));
		const tsla = p.holdings.find((h) => h.broker === "binance" && h.symbol === "TSLA")!;
		assert.equal(tsla.price, 250, "Binance 호가가 비면 본주 시세");
		assert.equal(p.allocation.overseasStock, 350 * 1400 + Math.round(196.5 * 1400) + 250 * 1400);
		assert.ok(p.brokers.every((b) => b !== "binance"), "brokers 는 증권사만");
	});

	it("EQ_ 티커 (순수)", () => {
		assert.equal(equityTicker("EQ_PANW"), "PANW");
		assert.equal(equityTicker("PANWB"), null);
		assert.equal(equityTicker("BTC"), null);
	});

	it("지갑 EQ_ 잔고가 있으면 그게 수량 — 체결 내역에만 있는 종목은 뺀다, 평단은 체결 내역에서 (순수)", () => {
		const fills = [
			{ symbol: "NVDA", qty: 1.5, avgPrice: 110, fills: 3 },
			{ symbol: "TSLA", qty: 1, avgPrice: 200, fills: 1 },
		];
		assert.deepEqual(equityPositions(new Map([["NVDA", 1.2], ["PANW", 0.3]]), fills), [
			{ symbol: "NVDA", qty: 1.2, avgPrice: 110, fills: 3, fromWallet: true },
			{ symbol: "PANW", qty: 0.3, avgPrice: null, fills: 0, fromWallet: true },
		]);
		assert.deepEqual(equityPositions(new Map(), fills).map((h) => [h.symbol, h.qty, h.fromWallet]), [["NVDA", 1.5, false], ["TSLA", 1, false]], "EQ_ 가 없으면 체결 내역 추정");
		assert.deepEqual(equityPositions(new Map(), null), []);
	});

	it("현물 지갑의 EQ_NVDA — 코인 목록·'시세 없음' 경고에 없고, 해외주식 NVDA 수량이 된다", async () => {
		const f = fake({ equity: true, eqWallet: { EQ_NVDA: "1.2" } });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		assert.ok(!p.crypto.some((c) => c.asset.startsWith("EQ_")));
		assert.ok(!p.warnings.some((w) => w.includes("EQ_")), p.warnings.join(" / "));
		const nvda = p.holdings.find((h) => h.broker === "binance" && h.symbol === "NVDA")!;
		assert.deepEqual([nvda.quantity, nvda.avgPrice, nvda.price, nvda.value], [1.2, 110, 131, 157.2]);
		assert.match(nvda.note ?? "", /지갑 잔고/);
		assert.ok(!p.holdings.some((h) => h.broker === "binance" && h.symbol === "TSLA"), "지갑에 없는 TSLA 는 체결 내역에만 있어도 뺀다");
	});

	it("EQ_ 잔고가 있는데 체결 내역이 실패하면 — 수량·평가는 그대로, 평단만 빠진다", async () => {
		const f = fake({ eqWallet: { EQ_NVDA: "1" }, binanceFail: ["/sapi/v1/equity/trade/history"] });
		const p = await fetchPortfolio({ binance: f.binance });
		const nvda = p.holdings.find((h) => h.symbol === "NVDA")!;
		assert.deepEqual([nvda.quantity, nvda.value, nvda.avgPrice], [1, 131, 0]);
		assert.ok(p.warnings.some((w) => w.includes("평단이 빠졌습니다")), p.warnings.join(" / "));
	});

	it("주식 시세를 아무 데서도 못 찾으면 평가 0 + 경고", async () => {
		const f = fake({ equity: true });
		const p = await fetchPortfolio({ binance: f.binance });
		const tsla = p.holdings.find((h) => h.symbol === "TSLA")!;
		assert.equal(tsla.value, 0);
		assert.ok(p.warnings.some((w) => w.includes("TSLA")), p.warnings.join(" / "));
	});

	it("bStock 토큰은 코인이 아니라 해외주식 (원래 티커로)", async () => {
		const f = fake({ bstock: true });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		assert.ok(!p.crypto.some((c) => c.asset === "AAPLB"));
		const t = p.holdings.find((h) => h.broker === "binance" && h.symbol === "AAPL")!;
		assert.equal(t.quantity, 2);
		assert.equal(t.value, 702);
		assert.match(t.note ?? "", /bStock 토큰 AAPLB/);
		assert.ok(f.hits.includes("binance/api/v3/referencePrice/calculation"));
	});

	it("미국 주식 조회가 실패해도 코인은 그대로 — partial", async () => {
		const f = fake({ binanceFail: ["/sapi/v1/equity/trade/history"] });
		const p = await fetchPortfolio({ binance: f.binance });
		assert.ok(p.crypto.length > 0);
		assert.ok(p.warnings.some((w) => w.includes("미국 주식")), p.warnings.join(" / "));
	});

	it("STOCK_SOURCES 조회의 holdings 에는 Binance 주식이 없다 (주문·타점이 kis·toss 로만 본다)", async () => {
		const f = fake({ equity: true, bstock: true });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance }, { sources: STOCK_SOURCES });
		assert.ok(p.holdings.every((h) => h.broker === "toss"));
	});
});

describe("코인 평단 추정", () => {
	it("이동평균 — 매도는 평단을 바꾸지 않는다 (순수)", () => {
		const b = coinCostBasis([
			{ isBuyer: true, qty: 1, quote: 100, time: 1 },
			{ isBuyer: true, qty: 1, quote: 300, time: 2 },
			{ isBuyer: false, qty: 1.5, quote: 999, time: 3 },
		]);
		assert.deepEqual(b, { qty: 0.5, avg: 200 });
		assert.deepEqual(coinCostBasis([{ isBuyer: false, qty: 1, quote: 1, time: 1 }]), { qty: 0, avg: null }, "산 기록 없이 판 것만이면 평단 없음");
	});

	it("체결로 설명되는 수량만큼만 손익 — 나머지는 커버리지로 밝힌다 (순수)", () => {
		const h = { source: "binance" as const, asset: "SOL", quantity: 4, wallets: [], priceUsd: 150, valueUsd: 600, valueKrw: 0, stable: false, avgPriceUsd: null, costCoverage: null, profitUsd: null, profitPct: null };
		const out = withCost(h, { qty: 1, avg: 100 });
		assert.deepEqual([out.avgPriceUsd, out.costCoverage, out.profitUsd, out.profitPct], [100, 0.25, 50, 50]);
	});

	it("현물 체결로 BTC 평단 — 수수료(코인·달러)를 반영한다", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		const btc = p.crypto.find((c) => c.asset === "BTC")!;
		// 받은 수량 0.0199 (수수료 0.0001 BTC), 원가 $1000 → 0.0099 매도 → 0.01 남음, 평단 1000/0.0199
		assert.equal(btc.avgPriceUsd, Number((1000 / 0.0199).toPrecision(10)));
		assert.equal(btc.costCoverage, 1);
		assert.equal(btc.profitPct, Math.round(((100_000 - 1000 / 0.0199) / (1000 / 0.0199)) * 10000) / 100);
		const eth = p.crypto.find((c) => c.asset === "ETH")!;
		assert.equal(eth.avgPriceUsd, null, "체결이 없으면 (Earn 으로 받은 것 등) 평단 없음");
		assert.equal(p.crypto.find((c) => c.asset === "USDT")!.avgPriceUsd, null, "스테이블은 보지 않는다");
	});
});

describe("공개 환율", () => {
	it("증권 계좌 환율이 없을 때만 — 출처에 기준일을 밝힌다", async () => {
		const f = fake({ publicFx: 1350 });
		const p = await fetchPortfolio({ binance: f.binance });
		assert.equal(p.usdKrw, 1350);
		assert.equal(p.fxSource, "ECB 2026-10-02");
		assert.equal(p.crypto.find((c) => c.asset === "BTC")?.valueKrw, 1000 * 1350);
		assert.ok(!p.warnings.some((w) => w.includes("환율을 얻지 못해")));
	});

	it("토스 환율이 있으면 부르지 않는다", async () => {
		const f = fake({ publicFx: 1350 });
		const p = await fetchPortfolio({ toss: f.toss, binance: f.binance });
		assert.equal(p.fxSource, "토스");
		assert.ok(!f.hits.includes("frankfurter"));
	});
});

describe("KIS 달러 예수금", () => {
	it("output2 USD 행의 외화출금가능금액 — 외화사용가능금액(통합증거금 원화 포함 가능)은 쓰지 않는다", () => {
		const r = toOverseasHoldings({
			rt_cd: "0",
			output1: [],
			output2: [
				{ crcy_cd: "HKD", frcr_drwg_psbl_amt_1: "50", frst_bltn_exrt: "180" },
				{ crcy_cd: "USD", frcr_drwg_psbl_amt_1: "1,234.56", frcr_dncl_amt_2: "9999", frst_bltn_exrt: "1360.5" },
			],
		} as never);
		assert.equal(r.cashUsd, 1234.56);
		assert.equal(r.usdKrw, 1360.5);
	});
});

describe("직접 입력 자산", () => {
	const asset = (over: Partial<ManualAsset>): ManualAsset => ({
		id: "m1",
		name: "적금",
		kind: "deposit",
		currency: "KRW",
		amount: 5_000_000,
		memo: null,
		updatedAt: "2026-10-04T00:00:00Z",
		...over,
	});

	it("예금은 현금성, 그 외는 기타 — 달러는 같은 환율로", async () => {
		const f = fake();
		const p = await fetchPortfolio({
			toss: f.toss,
			manual: async () => [asset({}), asset({ id: "m2", name: "연금", kind: "pension", amount: 30_000_000 }), asset({ id: "m3", name: "미국 계좌", kind: "investment", currency: "USD", amount: 1000 })],
		});
		assert.equal(p.manual.find((m) => m.id === "m3")?.valueKrw, 1000 * 1400);
		assert.equal(p.allocation.other, 30_000_000 + 1_400_000);
		assert.equal(p.allocation.cash, 1_000_000 + 100 * 1400 + 5_000_000);
		const card = p.sources.find((s) => s.id === "manual")!;
		assert.deepEqual([card.label, card.cashKrw, card.otherKrw, card.valueKrw], ["직접 입력", 5_000_000, 31_400_000, 36_400_000]);
		assert.equal(p.netWorthKrw, p.allocation.domesticStock + p.allocation.overseasStock + p.allocation.crypto + p.allocation.cash + p.allocation.other);
	});

	it("하나도 없으면 카드를 만들지 않는다 (스냅샷 계좌 구성도 그대로)", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, manual: async () => [] });
		assert.deepEqual(p.sources.map((s) => s.id), ["toss"]);
	});

	it("직접 입력만 있어도 총자산을 보여 준다 · 비었으면 계좌 없음", async () => {
		const p = await fetchPortfolio({ manual: async () => [asset({})] });
		assert.equal(p.netWorthKrw, 5_000_000);
		await assert.rejects(fetchPortfolio({ manual: async () => [] }), NoBrokerConfiguredError);
	});

	it("저장소 조회 실패는 그 카드만 failed", async () => {
		const f = fake();
		const p = await fetchPortfolio({ toss: f.toss, manual: async () => { throw new Error("D1 down"); } });
		assert.equal(p.sources.find((s) => s.id === "manual")?.status, "failed");
		assert.ok(p.warnings.some((w) => w.includes("직접 입력 조회 실패")));
	});

	it("주식만 보는 곳(STOCK_SOURCES)은 부르지 않는다", async () => {
		const f = fake();
		let called = false;
		await fetchPortfolio({ toss: f.toss, manual: async () => ((called = true), []) }, { sources: STOCK_SOURCES });
		assert.equal(called, false);
	});
});
