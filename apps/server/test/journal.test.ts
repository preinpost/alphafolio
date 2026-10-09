/**
 * 매매일지 (PLAN §42) — 실제 SQL(인메모리 SQLite) + 가짜 체결 출처.
 *
 * 핵심: ① 남의 일지는 보이지도 고쳐지지도 않는다 ② 증권사·앱에서 온 숫자는 고칠 수 없고 메모만 고친다
 * ③ 같은 체결을 두 번 가져오지 않고, 지운 기록이 다시 살아나지 않는다 ④ 앱이 낸 주문은 접수 때 pending → 가져오기가 채운다
 * ⑤ 자동 매매는 체결기 결과로 한 줄 — 같은 주문이 가져오기로 또 들어오지 않는다 ⑥ 한 계좌가 실패해도 나머지는 간다
 */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import type { BrokerFill, ExecReport, FillSource, JournalEntry, OrderAction } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { HttpError } from "../src/ledger-api.ts";
import { handleJournal, JournalRecorder, JournalStore, JournalSync, parseOrderNote, SYNC_THROTTLE_MS } from "../src/journal.ts";
import { TradeStore, type ExecPlan } from "../src/trade-store.ts";

// 2026-10-08 10:00 KST
const T0 = Date.parse("2026-10-08T10:00:00+09:00");
let d1: FakeD1;
let clock: number;
let store: JournalStore;
let fills: BrokerFill[];
let failKis: string | null;
let sync: JournalSync;
let recorder: JournalRecorder;

const fill = (over: Partial<BrokerFill>): BrokerFill => ({
	ref: "toss:T-1",
	parentRef: null,
	broker: "toss",
	symbol: "005930",
	name: null,
	side: "BUY",
	ordered: 10,
	filled: 10,
	price: 71_000,
	currency: "KRW",
	fee: 70,
	at: T0 - 3_600_000,
	open: false,
	...over,
});

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = T0;
	store = new JournalStore(() => d1.cfg, () => clock);
	fills = [];
	failKis = null;
	const sources = (): FillSource[] => [
		{ broker: "toss", label: "토스", run: async () => ({ fills: fills.filter((f) => f.broker === "toss"), warnings: [] }) },
		{
			broker: "kis",
			label: "한국투자 국장",
			run: async () => {
				if (failKis) throw new Error(failKis);
				return { fills: fills.filter((f) => f.broker === "kis"), warnings: [] };
			},
		},
	];
	const names = async (_u: string, symbols: string[]) => new Map(symbols.filter((s) => s === "005930").map((s) => [s, "삼성전자"]));
	sync = new JournalSync({ store, sources, names, now: () => clock });
	recorder = new JournalRecorder({ store, names, now: () => clock });
});
afterEach(() => {
	d1.restore();
	d1.db.close();
});

async function call(member: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
	req.method = method;
	const url = new URL(`http://x${path}`);
	return handleJournal(req, url, url.pathname, member, { store, sync, now: () => clock });
}
async function status(p: Promise<unknown>, code: number, re?: RegExp): Promise<void> {
	await assert.rejects(p, (err: unknown) => {
		assert.ok(err instanceof HttpError, String(err));
		assert.equal(err.status, code, err.message);
		if (re) assert.match(err.message, re);
		return true;
	});
}
const items = async (member: string, q = ""): Promise<JournalEntry[]> => ((await call(member, "GET", `/api/journal${q}`)) as { items: JournalEntry[] }).items;

const manual = { date: "2026-10-07", symbol: "aapl", side: "BUY", quantity: 2, price: 229.5, thesis: "실적 전 분할", tags: "#실적", emotion: "차분" };

describe("일지 REST", () => {
	it("직접 기록 → 목록 → 메모·매매 고치기 → 지우기", async () => {
		const made = (await call("ms", "POST", "/api/journal", manual)) as JournalEntry;
		assert.equal(made.symbol, "AAPL");
		assert.equal(made.currency, "USD");
		assert.equal(made.source, "manual");
		assert.equal(made.status, "filled");
		assert.equal(made.date, "2026-10-07");
		assert.deepEqual(made.tags, ["실적"]);

		const fixed = (await call("ms", "PATCH", `/api/journal/${made.id}`, { review: "손절가를 지켰다", price: 230, stopPrice: null })) as JournalEntry;
		assert.equal(fixed.review, "손절가를 지켰다");
		assert.equal(fixed.price, 230, "직접 기록은 매매 칸도 고친다");
		assert.equal(fixed.thesis, "실적 전 분할", "안 보낸 칸은 그대로");

		assert.deepEqual((await items("ms")).map((e) => e.id), [made.id]);
		assert.deepEqual(await items("ms", "?from=2026-10-08"), [], "기간 밖");
		assert.equal((await items("ms", "?missing=1")).length, 0, "근거가 있다");

		await call("ms", "DELETE", `/api/journal/${made.id}`);
		assert.deepEqual(await items("ms"), []);
	});

	it("남의 일지는 보이지도 고쳐지지도 지워지지도 않는다 (404)", async () => {
		const mine = (await call("ms", "POST", "/api/journal", manual)) as JournalEntry;
		assert.deepEqual(await items("eve"), []);
		await status(call("eve", "PATCH", `/api/journal/${mine.id}`, { thesis: "x" }), 404);
		await status(call("eve", "DELETE", `/api/journal/${mine.id}`), 404);
		assert.equal((await store.get("ms", mine.id))?.thesis, "실적 전 분할");
	});

	it("잘못된 입력은 400 — 저장하지 않는다", async () => {
		for (const bad of [
			{ ...manual, side: "buy" },
			{ ...manual, quantity: 0 },
			{ ...manual, date: "2026-10-09" },
			{ ...manual, emotion: "행복" },
			{ ...manual, symbol: "" },
			{ ...manual, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
		]) {
			await status(call("ms", "POST", "/api/journal", bad), 400);
		}
		assert.deepEqual(await items("ms"), []);
		await status(call("ms", "GET", "/api/journal?from=10-01"), 400);
		assert.equal(await call("ms", "PATCH", "/api/journal/not-an-id", {}), undefined, "라우트가 아니다");
	});

	it("증권사·앱에서 온 매매는 메모만 고친다", async () => {
		fills = [fill({})];
		await sync.run("ms", { force: true });
		const [imported] = await items("ms");
		assert.equal(imported!.source, "import");
		await status(call("ms", "PATCH", `/api/journal/${imported!.id}`, { quantity: 1 }), 400, /메모만/);
		const ok = (await call("ms", "PATCH", `/api/journal/${imported!.id}`, { thesis: "돌파", tags: ["돌파"] })) as JournalEntry;
		assert.equal(ok.thesis, "돌파");
		assert.equal(ok.quantity, 10);
	});
});

describe("체결 가져오기", () => {
	it("앱 밖 매매는 새 줄로, 종목명을 채운다 — 두 번 가져와도 한 줄", async () => {
		fills = [fill({}), fill({ ref: "kis:20261008:5", broker: "kis", symbol: "035720", name: "카카오", side: "SELL", price: 41_000 })];
		const r = await sync.run("ms", { force: true });
		assert.equal(r.added, 2);
		assert.deepEqual(r.sources.map((s) => [s.label, s.fills, s.error]), [["토스", 1, null], ["한국투자 국장", 1, null]]);
		const list = await items("ms");
		assert.deepEqual(list.map((e) => [e.symbol, e.name, e.source, e.status]).sort(), [["005930", "삼성전자", "import", "filled"], ["035720", "카카오", "import", "filled"]]);

		const again = await sync.run("ms", { force: true });
		assert.deepEqual([again.added, again.updated], [0, 0]);
		assert.equal((await items("ms")).length, 2);
	});

	it("지운 기록은 다음 가져오기에서 다시 들어오지 않는다", async () => {
		fills = [fill({})];
		await sync.run("ms", { force: true });
		const [e] = await items("ms");
		await call("ms", "DELETE", `/api/journal/${e!.id}`);
		assert.equal((await sync.run("ms", { force: true })).added, 0);
		assert.deepEqual(await items("ms"), []);
	});

	it("한 계좌가 실패해도 나머지는 가져오고, 실패를 알린다", async () => {
		fills = [fill({})];
		failKis = "토큰 발급 실패";
		const r = await sync.run("ms", { force: true });
		assert.equal(r.added, 1);
		assert.deepEqual(r.sources.find((s) => s.label === "한국투자 국장")?.error, "토큰 발급 실패");
	});

	it("화면 열 때의 가져오기는 10분에 한 번 — 버튼(force)은 바로", async () => {
		fills = [fill({})];
		assert.equal((await call("ms", "POST", "/api/journal/sync", {}) as { added: number }).added, 1);
		fills.push(fill({ ref: "toss:T-2" }));
		assert.equal(((await call("ms", "POST", "/api/journal/sync", {})) as { skipped?: boolean }).skipped, true);
		clock += SYNC_THROTTLE_MS;
		assert.equal(((await call("ms", "POST", "/api/journal/sync", {})) as { added: number }).added, 1);
		fills.push(fill({ ref: "toss:T-3" }));
		assert.equal(((await call("ms", "POST", "/api/journal/sync", { force: true })) as { added: number }).added, 1);
	});
});

describe("앱이 낸 주문", () => {
	const place: OrderAction = { kind: "place", broker: "toss", symbol: "005930", market: "KR", currency: "KRW", side: "BUY", orderType: "LIMIT", quantity: 10, price: 71_000, estimatedAmount: 710_000 };

	it("접수 때 pending + 근거 한 줄 + 대화 → 가져오기가 체결로 채운다 (새 줄이 생기지 않는다)", async () => {
		const e = (await recorder.recordOrder("ms", place, { message: "주문이 접수되었습니다", orderId: "T-1" }, { note: parseOrderNote("  20일선 지지  "), conversationId: "conv-1" }))!;
		assert.equal(e.status, "pending");
		assert.equal(e.thesis, "20일선 지지");
		assert.equal(e.name, "삼성전자");
		assert.equal(e.conversationId, "conv-1");
		assert.deepEqual(e.context, { orderType: "LIMIT", ordered: 10, limitPrice: 71_000 });

		fills = [fill({ filled: 6, price: 70_950, fee: 42 })];
		const r = await sync.run("ms", { force: true });
		assert.deepEqual([r.added, r.updated], [0, 1]);
		const [after] = await items("ms");
		assert.deepEqual([after!.id, after!.status, after!.quantity, after!.price, after!.fee, after!.thesis], [e.id, "filled", 6, 70_950, 42, "20일선 지지"]);
	});

	it("체결 없이 취소되면 canceled — 주문 수량은 남긴다", async () => {
		await recorder.recordOrder("ms", place, { message: "", orderId: "T-1" }, { note: null, conversationId: null });
		fills = [fill({ filled: 0, price: null, fee: null })];
		await sync.run("ms", { force: true });
		const [after] = await items("ms");
		assert.deepEqual([after!.status, after!.quantity, after!.price], ["canceled", 10, 71_000]);
	});

	it("정정으로 번호가 바뀌면 원주문 기록에 잇는다 — 새 번호의 체결이 그 기록을 채운다", async () => {
		const kis: OrderAction = { ...place, broker: "kis" } as OrderAction;
		const e = (await recorder.recordOrder("ms", kis, { message: "", orderId: "0000000201" }, { note: null, conversationId: null }))!;
		const modify: OrderAction = {
			kind: "modify",
			broker: "kis",
			symbol: "005930",
			market: "KR",
			currency: "KRW",
			original: { orderId: "0000000201", side: "BUY", orderType: "LIMIT", openQuantity: 10, price: 71_000, orderedAt: null },
			orderType: "LIMIT",
			quantity: 10,
			price: 70_500,
		};
		assert.equal(await recorder.recordOrder("ms", modify, { message: "", orderId: "0000000202" }, { note: null, conversationId: null }), null);
		fills = [fill({ ref: "kis:20261008:201", broker: "kis", filled: 0, price: null, fee: null }), fill({ ref: "kis:20261008:202", broker: "kis", filled: 10, price: 70_500, fee: null })];
		await sync.run("ms", { force: true });
		const list = await items("ms");
		assert.equal(list.length, 1, "정정 주문이 새 줄로 들어오지 않는다");
		assert.deepEqual([list[0]!.id, list[0]!.status, list[0]!.price], [e.id, "filled", 70_500]);
	});

	it("정정·취소·조건주문은 새 줄을 만들지 않는다", async () => {
		const cancel = { kind: "cancel", broker: "toss", symbol: "005930", market: "KR", currency: "KRW", original: { orderId: "T-1", side: "BUY", orderType: "LIMIT", openQuantity: 1, price: 1, orderedAt: null } } as OrderAction;
		assert.equal(await recorder.recordOrder("ms", cancel, { message: "", orderId: "T-1" }, { note: null, conversationId: null }), null);
		assert.deepEqual(await items("ms"), []);
	});
});

describe("자동 매매", () => {
	const plan: ExecPlan = {
		side: "BUY",
		quantity: 14,
		worstPrice: 71_700,
		urgency: "immediate",
		deadlineMs: 30_000,
		nonce: "x1",
		target: { broker: "kis", account: "a", accountLabel: "한국투자" },
		symbol: "005930",
		ref: 71_000,
		maxAmount: 1_000_000,
	};
	const report: ExecReport = {
		status: "filled",
		filledQty: 14,
		avgPrice: 71_050,
		arrivalPrice: 71_000,
		slippageBps: 7,
		reason: null,
		children: [
			{ n: 0, clientId: "c0", orderId: "0000000301", ref: "91252|20261008", price: 71_000, quantity: 14, ioc: false, state: "done", filledQty: 10, avgPrice: 71_000, reason: null },
			{ n: 1, clientId: "c1", orderId: "0000000302", ref: "91252|20261008", price: 71_200, quantity: 4, ioc: false, state: "done", filledQty: 4, avgPrice: 71_175, reason: null },
		],
	};

	it("체결이 끝나면 TradeStore 가 알리고 한 줄이 생긴다 — 자식 주문이 가져오기로 또 들어오지 않는다", async () => {
		const trades = new TradeStore(() => d1.cfg, () => clock);
		const done: Array<Promise<unknown>> = [];
		trades.onFilled = (rec) => {
			const p = recorder.recordExec(rec, null);
			done.push(p);
			return p;
		};
		assert.ok(await trades.begin({ id: "x1", triggerId: "w1", member: "ms", barT: 1, currency: "KRW", day: "2026-10-08", plan }));
		await trades.finish("x1", report);
		// onFilled 는 기다리지 않는다 — 다 돌 때까지
		for (let i = 0; i < 50 && done.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		await Promise.all(done);

		const [e] = await items("ms");
		assert.deepEqual([e!.source, e!.status, e!.quantity, e!.price, e!.name, e!.context?.slippageBps, e!.context?.leg], ["auto", "filled", 14, 71_050, "삼성전자", 7, "normal"]);

		fills = [
			fill({ ref: "kis:20261008:301", broker: "kis", filled: 10, price: 71_000 }),
			fill({ ref: "kis:20261008:302", broker: "kis", filled: 4, price: 71_175 }),
		];
		const r = await sync.run("ms", { force: true });
		assert.equal(r.added, 0);
		assert.equal((await items("ms")).length, 1);
	});

	it("체결이 없으면 알리지 않는다", async () => {
		const trades = new TradeStore(() => d1.cfg, () => clock);
		let called = 0;
		trades.onFilled = async () => void called++;
		await trades.begin({ id: "x2", triggerId: "w1", member: "ms", barT: 2, currency: "KRW", day: "2026-10-08", plan });
		await trades.finish("x2", { ...report, status: "none", filledQty: 0, avgPrice: null, children: [] });
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(called, 0);
		assert.equal(await recorder.recordExec({ report: { ...report, filledQty: 0 } } as never, null), null);
	});
});
