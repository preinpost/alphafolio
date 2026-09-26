/**
 * 감시 트리거 — 저장·켜기·감시기·권한 (PLAN §40). 실제 SQL(인메모리 SQLite) + 가짜 봉.
 *
 * 핵심: ① 켜기는 확인 토큰으로만, 한 번만 ② 켜기 전의 봉으로 울리지 않는다 ③ 봉이 닫힐 때 한 번 평가, 같은 봉을 두 번 보지 않는다
 * ④ 재기동 뒤 놓친 발동은 하나로 묶는다 ⑤ 에이전트는 삭제·비상 정지·다시 켜기를 못 한다 ⑥ 비활성 계정은 끈다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import type { TriggerSpec, WatchBar } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { OrderTokenGuard } from "../src/order-tokens.ts";
import { TriggerStore } from "../src/triggers.ts";
import { Watcher, type WatchEvent } from "../src/watcher.ts";
import { watchConfirmSecret, WatchOps, type WatchTokenPayload } from "../src/watch-api.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-09-26T00:00:00Z");

let d1: FakeD1;
let clock: number;
let closes: number[];
let fetches: number;
let delivered: Array<{ ev: WatchEvent; channels: boolean }>;
let active: Set<string>;
let store: TriggerStore;
let ops: WatchOps;
let watcher: Watcher;

/** closes[i] = T0 + i시간 봉의 종가. 지금 시각 기준 닫힌 봉만 */
const fakeBars = async (_user: string, _c: unknown, limit: number, at: number): Promise<WatchBar[]> => {
	fetches++;
	const all = closes.map((c, i) => ({ t: T0 + i * H, open: c, high: c, low: c - 50, close: c, volume: 1 })).filter((b) => b.t + H <= at);
	return all.slice(-limit);
};

const spec = (over: Partial<TriggerSpec> = {}): TriggerSpec => ({
	name: "ETH 2,600 이탈",
	condition: { market: { venue: "binance", symbol: "ETHUSDT" }, interval: "1h", when: "bar_close", all: [{ left: "close", op: "<", right: 2600 }], confirmBars: 1, fire: "on_enter" },
	action: { kind: "notify" },
	limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(T0 + 30 * 86_400_000).toISOString() },
	conversationId: "conv-1",
	...over,
});

/** 봉 i 가 닫히고 10초 뒤로 시계를 옮겨 평가 */
async function closeBar(i: number, close: number): Promise<void> {
	closes[i] = close;
	clock = T0 + (i + 1) * H + 10_000;
	await watcher.tick();
}

const fired = () => delivered.filter((d) => d.ev.kind === "fired" || d.ev.kind === "missed");

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = T0 + 100 * H + 10_000;
	closes = Array(100).fill(2700);
	fetches = 0;
	delivered = [];
	active = new Set(["ms", "kim"]);
	store = new TriggerStore(() => d1.cfg, () => clock);
	await store.load();
	const deliver = async (ev: WatchEvent, o: { channels?: boolean } = {}) => (delivered.push({ ev, channels: o.channels !== false }), []);
	ops = new WatchOps({ store, confirm: { secret: watchConfirmSecret("s"), guard: new OrderTokenGuard<WatchTokenPayload>() }, deliver, channels: () => ["telegram"], now: () => clock });
	watcher = new Watcher({ store, deliver, isActive: (u) => active.has(u), fetchBars: fakeBars, now: () => clock });
});
afterEach(() => d1.restore());

async function arm(user = "ms", s = spec()): Promise<string> {
	const { token } = ops.prepare(user, s);
	return (await ops.arm(user, token)).id;
}

describe("켜기", () => {
	it("확인 토큰으로만, 한 번만. 다른 사용자·변조 토큰 거절", async () => {
		const { token } = ops.prepare("ms", spec());
		await assert.rejects(ops.arm("kim", token), /다른 사용자/);
		const [body, mac] = token.split(".");
		const p = JSON.parse(Buffer.from(body as string, "base64url").toString()) as WatchTokenPayload;
		p.watch.condition.all[0]!.right = 9999;
		await assert.rejects(ops.arm("ms", `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${mac}`), /올바르지 않습니다/);
		const w = await ops.arm("ms", token);
		assert.equal(w.state, "armed");
		await assert.rejects(ops.arm("ms", token), /이미 켠/);
		assert.equal(store.list("ms").length, 1);
		// 10분 넘으면 만료
		const late = ops.prepare("ms", spec());
		clock += 11 * 60_000;
		await assert.rejects(ops.arm("ms", late.token), /10분/);
	});

	it("켜기 전의 봉으로는 울리지 않는다 — 이미 2,600 아래여도 거짓 → 참이 될 때만", async () => {
		closes = Array(100).fill(2500);
		await arm();
		await closeBar(100, 2500);
		assert.equal(fired().length, 0);
		await closeBar(101, 2700);
		await closeBar(102, 2590);
		assert.equal(fired().length, 1);
	});
});

describe("감시기", () => {
	it("봉이 닫힐 때 한 번 평가, 같은 봉을 두 번 보지 않는다. 조건이 유지되면 다시 울리지 않는다", async () => {
		await arm();
		await closeBar(100, 2590);
		assert.equal(fired().length, 1);
		const f = fired()[0]!.ev;
		assert.equal(f.message.path, "/c/conv-1");
		assert.match(f.message.lines?.[0] ?? "", /09\/30 14:00 마감 · 종가 2,590/);
		assert.equal(fired()[0]!.channels, true);
		const n = fetches;
		await watcher.tick(); // 같은 봉 — 조회도 안 한다
		assert.equal(fetches, n);
		await closeBar(101, 2580); // 계속 참
		assert.equal(fired().length, 1);
		const [w] = ops.list("ms");
		assert.equal(w?.fires, 1);
		const ev = await store.events("ms");
		assert.deepEqual(ev.map((e) => e.kind), ["fired", "armed"]);
		assert.deepEqual(ev[0]?.detail.values, { close: 2590 });
	});

	it("꼬리만 뚫은 봉(저가 2,550 · 종가 2,650)은 무시", async () => {
		await arm();
		await closeBar(100, 2650); // fakeBars 의 low = close - 50 = 2,600
		closes[101] = 2640;
		await closeBar(101, 2640); // low 2,590 — 종가 기준이라 무시
		assert.equal(fired().length, 0);
	});

	it("같은 종목·간격의 트리거는 한 번만 조회한다", async () => {
		await arm("ms");
		await arm("kim");
		await arm("ms", spec({ name: "b", condition: { ...spec().condition, all: [{ left: "close", op: ">", right: 3000 }] } }));
		await closeBar(100, 2590);
		assert.equal(fetches, 1);
		assert.deepEqual(fired().map((d) => d.ev.user).sort(), ["kim", "ms"]);
	});

	it("재기동으로 놓친 발동은 \"늦은 알림\" 하나로 묶는다", async () => {
		await arm();
		// 3번 들어갔다 나왔다 한 뒤에야 서버가 돌아왔다
		for (const [i, c] of [2590, 2700, 2590, 2700, 2590, 2700].entries()) closes[100 + i] = c;
		clock = T0 + 107 * H + 10_000;
		await watcher.tick();
		assert.equal(fired().length, 1);
		assert.equal(fired()[0]!.ev.kind, "missed");
		assert.match(fired()[0]!.ev.message.lines?.join("\n") ?? "", /3번 충족/);
	});

	it("최대 발동을 채우면 끝, 쿨다운 안은 무시, 만료되면 알리고 끈다", async () => {
		const id = await arm("ms", spec({ limits: { maxFires: 2, cooldownSec: 3 * 3600, expiresAt: new Date(T0 + 110 * H).toISOString() } }));
		await closeBar(100, 2590);
		await closeBar(101, 2700);
		await closeBar(102, 2590); // 첫 발동 2시간 뒤 — 쿨다운 3시간 안
		assert.equal(fired().length, 1);
		await closeBar(103, 2700);
		await closeBar(104, 2590);
		assert.equal(fired().length, 2);
		assert.equal(store.get("ms", id)?.state, "done");
		assert.match(fired()[1]!.ev.message.lines?.join("\n") ?? "", /최대 발동 2회/);

		const id2 = await arm("ms", spec({ limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(T0 + 106 * H).toISOString() } }));
		clock = T0 + 107 * H;
		await watcher.tick();
		assert.equal(store.get("ms", id2)?.state, "expired");
		assert.ok(delivered.some((d) => d.ev.kind === "expired" && d.channels));
	});

	it("비활성 계정의 감시는 끈다", async () => {
		const id = await arm("kim");
		active.delete("kim");
		await closeBar(100, 2590);
		assert.equal(store.get("kim", id)?.state, "off");
		assert.equal(fired().length, 0);
	});

	it("봉 조회 실패는 오류로 남기고 봉을 넘기지 않는다 (다음 점검에서 같은 봉을 다시)", async () => {
		const id = await arm();
		const w = new Watcher({ store, deliver: async () => [], isActive: () => true, fetchBars: (async () => { throw new Error("boom"); }) as never, now: () => clock });
		closes[100] = 2590;
		clock = T0 + 101 * H + 10_000;
		await w.tick();
		const rec = store.get("ms", id)!;
		assert.match(rec.lastError ?? "", /boom/);
		assert.equal(rec.lastBarT, T0 + 99 * H);
		await watcher.tick();
		assert.equal(fired().length, 1);
	});
});

describe("권한", () => {
	it("에이전트: 일시정지만. 삭제·비상 정지·다시 켜기는 거절", async () => {
		const id = await arm();
		await assert.rejects(ops.remove("ms", id, "agent"), /앱·텔레그램/);
		await assert.rejects(ops.stopAll("ms", "agent"), /앱·텔레그램/);
		await ops.pause("ms", id, "agent");
		await assert.rejects(ops.resume("ms", id, "agent"), /앱 화면에서만/);
		await assert.rejects(ops.resume("ms", id, "telegram"), /앱 화면에서만/);
		assert.equal((await ops.resume("ms", id, "app")).state, "armed");
	});

	it("남의 감시는 없는 것과 같다", async () => {
		const id = await arm("ms");
		await assert.rejects(ops.pause("kim", id, "app"), /없는 감시/);
		await assert.rejects(ops.remove("kim", id, "telegram"), /없는 감시/);
		assert.equal(store.list("ms").length, 1);
	});

	it("일시정지 동안의 봉으로는 다시 켤 때 울리지 않는다", async () => {
		const id = await arm();
		await ops.pause("ms", id, "telegram");
		await closeBar(100, 2590);
		await closeBar(101, 2700);
		await closeBar(102, 2590);
		assert.equal(fired().length, 0);
		await ops.resume("ms", id, "app");
		await closeBar(103, 2580); // 계속 참 — 다시 켠 뒤 거짓 → 참이 아니다
		assert.equal(fired().length, 0);
	});

	it("비상 정지: 켜진 것만 일시정지, 텔레그램에서 했으면 텔레그램에 다시 보내지 않는다", async () => {
		await arm();
		await arm("ms", spec({ name: "b" }));
		assert.equal(await ops.stopAll("ms", "telegram"), 2);
		assert.ok(store.list("ms").every((t) => t.state === "paused"));
		const stop = delivered.find((d) => d.ev.kind === "stopped");
		assert.equal(stop?.channels, false);
		// 상태 변경 알림은 화면에만
		assert.ok(delivered.filter((d) => d.ev.kind === "armed").every((d) => !d.channels));
	});

	it("재기동: D1 에서 다시 읽어 이어 간다", async () => {
		const id = await arm();
		const again = new TriggerStore(() => d1.cfg, () => clock);
		await again.load();
		assert.deepEqual(again.get("ms", id)?.source, store.get("ms", id)?.source);
		assert.equal(again.armed().length, 1);
	});
});

describe("주식 일봉 감시", () => {
	const KST = (s: string) => Date.parse(`${s}+09:00`);
	/** 국장 일봉: ymd → [종가, 거래량]. 휴장일은 넣지 않는다 */
	let daily: Record<string, [number, number]>;
	const calls: string[] = [];
	const stockBars = async (user: string, _c: unknown, limit: number, at: number): Promise<WatchBar[]> => {
		calls.push(user);
		return Object.entries(daily)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([d, [close, volume]]) => ({ t: KST(`${d}T09:00:00`), open: close, high: close, low: close, close, volume }))
			.filter((b) => b.t + 6.5 * H <= at)
			.slice(-limit);
	};
	const stockSpec = (): TriggerSpec => ({
		...spec(),
		name: "삼성 거래량 급증",
		condition: { market: { venue: "krx", symbol: "005930" }, interval: "1d", when: "bar_close", all: [{ left: "vol_chg_pct", op: ">=", right: 40 }], confirmBars: 1, fire: "on_enter" },
		limits: { maxFires: null, cooldownSec: 0, expiresAt: "2026-12-31T00:00:00Z" },
	});
	let w: Watcher;

	beforeEach(() => {
		daily = { "2026-09-16": [253500, 11_757_106], "2026-09-17": [252500, 11_827_514] };
		calls.length = 0;
		clock = KST("2026-09-17T16:00:00");
		w = new Watcher({ store, deliver: async (ev) => (delivered.push({ ev, channels: true }), []), isActive: () => true, fetchBars: stockBars, now: () => clock });
	});

	it("장 마감 + 10분 뒤 평가 — 실제 삼성전자 09/18 거래량 +47.9% 에서 발동", async () => {
		await arm("ms", stockSpec());
		daily["2026-09-18"] = [261000, 17_489_615];
		clock = KST("2026-09-18T15:35:00"); // 마감 5분 뒤 — 아직
		await w.tick();
		assert.equal(fired().length, 0);
		clock = KST("2026-09-18T15:41:00");
		await w.tick();
		assert.equal(fired().length, 1);
		assert.match(fired()[0]!.ev.message.lines?.[0] ?? "", /09\/18 15:30 마감 · 종가 261,000 · 거래량 증가율\(직전 봉 대비 %\) 47\.87/);
	});

	it("휴장일: 닫혔어야 할 봉이 안 오면 10분 동안 다시 조회하지 않는다", async () => {
		await arm("ms", stockSpec());
		clock = KST("2026-09-18T15:41:00"); // 18일 봉이 없다 (휴장이라 치자)
		await w.tick();
		await w.tick();
		clock += 5 * 60_000;
		await w.tick();
		assert.equal(calls.length, 1);
		clock += 6 * 60_000;
		await w.tick();
		assert.equal(calls.length, 2);
	});

	it("주식은 사용자별 키로 — 같은 종목도 사람마다 따로 조회", async () => {
		await arm("ms", stockSpec());
		await arm("kim", stockSpec());
		daily["2026-09-18"] = [261000, 17_489_615];
		clock = KST("2026-09-18T15:41:00");
		await w.tick();
		assert.deepEqual([...calls].sort(), ["kim", "ms"]);
	});

	it("다음 날 아침에야 평가했으면 늦은 알림", async () => {
		await arm("ms", stockSpec());
		daily["2026-09-18"] = [261000, 17_489_615];
		clock = KST("2026-09-19T09:00:00"); // 마감 17.5시간 뒤 (12시간 넘음)
		await w.tick();
		assert.equal(fired()[0]?.ev.kind, "missed");
	});
});
