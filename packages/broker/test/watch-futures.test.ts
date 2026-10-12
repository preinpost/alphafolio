/**
 * Binance 선물 감시 — 알림 전용.
 *
 * 실측 사고 (2026-10-12): KORUUSDT(미국 주식 기반 TradFi 무기한)는 선물에만 있는데 감시·지표가 현물만 봐서
 * "바이낸스에 없는 심볼"이라고 답했다. 선물 봉으로 감시하되 주문은 붙이지 않는다 (선물 주문은 binance_futures 확인 카드로만).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BarsError, fetchWatchBars } from "../src/triggers/bars.ts";
import { validateCondition } from "../src/triggers/condition.ts";
import { conditionText } from "../src/triggers/describe.ts";
import { createWatchTools, type WatchSummary } from "../src/triggers/tool.ts";
import type { Condition, TriggerSpec, WatchBar } from "../src/triggers/types.ts";

type WatchConfirmCard = WatchSummary & { kind: string };

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

function bars(closes: number[]): WatchBar[] {
	return closes.map((c, i) => ({ t: T0 + i * H, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }));
}

const cond = (over: Partial<Condition["market"]> = {}): Condition => ({
	market: { venue: "binance", symbol: "KORUUSDT", contract: "futures", ...over },
	interval: "1h",
	when: "bar_close",
	all: [{ left: "close", op: "<", right: 16.95 }],
	confirmBars: 1,
	fire: "on_enter",
});

describe("선물 조건", () => {
	it("봉은 fapi 에서 받는다", async () => {
		const urls: string[] = [];
		const raw = Array.from({ length: 5 }, (_, i) => [T0 + i * H, "17", "18", "16", "17", "100", 0]);
		await fetchWatchBars(cond(), 3, { now: T0 + 10 * H, fetch: async (u) => (urls.push(u), new Response(JSON.stringify(raw))) });
		assert.match(urls[0] as string, /^https:\/\/fapi\.binance\.com\/fapi\/v1\/klines\?symbol=KORUUSDT&interval=1h/);
		const spot: string[] = [];
		await fetchWatchBars(cond({ contract: undefined }), 3, { now: T0 + 10 * H, fetch: async (u) => (spot.push(u), new Response(JSON.stringify(raw))) });
		assert.match(spot[0] as string, /^https:\/\/api\.binance\.com\/api\/v3\/klines/);
	});

	it("검증 — 선물은 Binance 만, 값은 futures 만", () => {
		assert.deepEqual(validateCondition(cond()), []);
		assert.match(validateCondition(cond({ venue: "us", symbol: "KORU" })).join(), /선물 봉\(contract: futures\)은 Binance 만/);
		assert.match(validateCondition(cond({ contract: "perp" as never })).join(), /contract 는 futures 만/);
	});

	it("조건 문장에 선물을 붙인다", () => {
		assert.match(conditionText(cond()), /^KORUUSDT 선물 · 1시간봉 마감/);
		assert.match(conditionText(cond({ contract: undefined, symbol: "ETHUSDT" })), /^ETHUSDT · 1시간봉 마감/);
	});
});

describe("watch_alert — 선물", () => {
	const setup = (spotHas: (symbol: string) => boolean) => {
		const prepared: TriggerSpec[] = [];
		const seen: Condition[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "t", expiresAt: 1 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("x");
			},
			channels: () => ["telegram"],
			bStock: async () => null,
			fetchBars: async (c, limit) => {
				seen.push({ ...c, market: { ...c.market } }); // 조건 객체는 준비 중에 바뀔 수 있다 — 부른 때의 값
				if (c.market.contract !== "futures" && !spotHas(c.market.symbol)) throw new BarsError(`Binance 에 없는 종목입니다: ${c.market.symbol}`, true);
				return bars(Array.from({ length: 900 }, (_, i) => 17 + (i % 5) * 0.1)).slice(-limit);
			},
			now: () => T0 + 1000 * H,
		});
		const run = (p: Record<string, unknown>) =>
			tool!.execute("id", { action: "prepare", interval: "1h", all: [{ left: "close", op: "<", right: 16.95 }], ...p } as never, undefined, undefined, undefined as never) as Promise<{
				content: Array<{ text: string }>;
				details: WatchConfirmCard;
			}>;
		return { run, prepared, seen };
	};

	it("현물에 없으면 선물 봉으로 — 카드에 선물·알림 전용 표시", async () => {
		const { run, prepared, seen } = setup(() => false);
		const r = await run({ symbol: "KORUUSDT" });
		assert.equal(prepared[0]?.condition.market.contract, "futures");
		assert.deepEqual(prepared[0]?.action, { kind: "notify" });
		assert.deepEqual(
			seen.map((c) => c.market.contract ?? "spot"),
			["spot", "futures"],
		);
		assert.equal(r.details.venue, "Binance 선물");
		assert.match(r.details.name, /^KORUUSDT 선물/);
		assert.ok(r.details.warnings.some((w) => /알림만 가고 주문은 나가지 않습니다/.test(w)));
	});

	it("무기한 표기(koruusdtp · .P)는 바로 선물 — 미장 티커로 오해하지 않는다", async () => {
		const { run, prepared, seen } = setup(() => false);
		await run({ symbol: "koruusdtp" });
		await run({ symbol: "KORUUSDT.P" });
		assert.deepEqual(
			prepared.map((s) => [s.condition.market.venue, s.condition.market.symbol, s.condition.market.contract]),
			[
				["binance", "KORUUSDT", "futures"],
				["binance", "KORUUSDT", "futures"],
			],
		);
		assert.ok(seen.every((c) => c.market.contract === "futures"));
	});

	it("둘 다 있는 심볼은 현물 — contract: futures 로 고를 수 있다", async () => {
		const { run, prepared } = setup(() => true);
		await run({ symbol: "ETHUSDT" });
		await run({ symbol: "ETHUSDT", contract: "futures" });
		assert.equal(prepared[0]?.condition.market.contract, undefined);
		assert.equal(prepared[1]?.condition.market.contract, "futures");
	});

	it("현물이라고 정했으면 선물로 넘어가지 않는다", async () => {
		const { run } = setup(() => false);
		await assert.rejects(run({ symbol: "KORUUSDT", contract: "spot" }), /Binance 에 없는 종목입니다: KORUUSDT/);
	});

	it("선물 감시에는 주문을 붙이지 않는다 (자동 감지여도)", async () => {
		const { run, prepared } = setup(() => false);
		const order = { side: "SELL", amount: 100 };
		await assert.rejects(run({ symbol: "KORUUSDT", contract: "futures", order }), /선물 감시는 알림만 됩니다 — 선물 주문·익절·손절은 binance_futures/);
		await assert.rejects(run({ symbol: "KORUUSDT", order }), /KORUUSDT 은\(는\) Binance 선물에만 있습니다\. 선물 감시는 알림만/);
		await assert.rejects(run({ symbol: "KORUUSDT.P", action: "protect", protect: { stopPct: 5 } }), /binance_futures \(action: tpsl\)/);
		assert.equal(prepared.length, 0);
	});

	it("주식 시장에 contract 를 주면 거절", async () => {
		const { run } = setup(() => true);
		await assert.rejects(run({ symbol: "KORU", market: "us", contract: "futures" }), /Binance\(market: binance\)만/);
	});
});
