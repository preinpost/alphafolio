/**
 * 텔레그램 명령 테스트 (PLAN §40) — 보기·멈추기·지우기만, 만들기·다시 켜기는 앱.
 *
 * 핵심: ① 저장된 개인 채팅에서 그 사람이 보낸 것만 ② 재기동 뒤 쌓인 옛 명령은 버린다
 * ③ 삭제는 두 번 확인, 오래된 확인 버튼은 다시 묻는다 ④ 텔레그램으로는 다시 켜지 않는다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import type { TriggerSpec } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { renderList, TelegramBots } from "../src/notify/telegram-bot.ts";
import { OrderTokenGuard } from "../src/order-tokens.ts";
import { TriggerStore } from "../src/triggers.ts";
import { watchConfirmSecret, WatchOps, type WatchTokenPayload } from "../src/watch-api.ts";

const CHAT = "4242";
const TOKEN = `123456789:${"x".repeat(35)}`;
const T0 = Date.parse("2026-09-26T10:00:00Z");

let d1: FakeD1;
let clock: number;
let sent: Array<{ method: string; body: Record<string, unknown> }>;
let store: TriggerStore;
let ops: WatchOps;
let bot: ReturnType<typeof TelegramBots.forTest>;
let update = 0;

const spec = (name: string): TriggerSpec => ({
	name,
	condition: { market: { venue: "binance", symbol: "ETHUSDT" }, interval: "1h", when: "bar_close", all: [{ left: "close", op: "<", right: 2600 }], confirmBars: 1, fire: "on_enter" },
	action: { kind: "notify" },
	limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(T0 + 30 * 86_400_000).toISOString() },
	conversationId: null,
});

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = T0;
	sent = [];
	store = new TriggerStore(() => d1.cfg, () => clock);
	await store.load();
	ops = new WatchOps({ store, confirm: { secret: watchConfirmSecret("s"), guard: new OrderTokenGuard<WatchTokenPayload>() }, deliver: async () => [], channels: () => ["telegram"], now: () => clock });
	const fetch = (async (url: string, init: RequestInit) => {
		sent.push({ method: url.split("/").pop() as string, body: JSON.parse(String(init.body)) as Record<string, unknown> });
		return new Response(JSON.stringify({ ok: true, result: {} }));
	}) as unknown as typeof globalThis.fetch;
	bot = TelegramBots.forTest("ms", { token: TOKEN, chatId: CHAT }, { ops, creds: () => null, users: () => [], publicUrl: "https://af.example.com", telegram: { fetch }, now: () => clock });
});
afterEach(() => d1.restore());

async function arm(name: string): Promise<string> {
	return (await ops.arm("ms", ops.prepare("ms", spec(name)).token)).id;
}

const sec = () => Math.floor(clock / 1000);
const text = (t: string, over: { chat?: number; from?: number; type?: string; date?: number } = {}) =>
	bot.handle({ update_id: ++update, message: { message_id: 1, date: over.date ?? sec(), text: t, chat: { id: over.chat ?? Number(CHAT), type: over.type ?? "private" }, from: { id: over.from ?? Number(CHAT) } } });
const press = (data: string, over: { from?: number; date?: number } = {}) =>
	bot.handle({ update_id: ++update, callback_query: { id: "cb", data, from: { id: over.from ?? Number(CHAT) }, message: { message_id: 7, date: over.date ?? sec(), chat: { id: Number(CHAT), type: "private" } } } });
const last = (method: string) => sent.filter((s) => s.method === method).at(-1)?.body;
const buttonData = (body: Record<string, unknown> | undefined) =>
	((body?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

describe("인증", () => {
	it("다른 채팅·다른 사람·그룹·옛 명령은 무시한다", async () => {
		await arm("a");
		await text("/list", { chat: 999, from: 999 });
		await text("/list", { from: 999 }); // 같은 채팅이라도 보낸 사람이 다르면
		await text("/list", { type: "group" });
		await text("/list", { date: sec() - 3600 }); // 재기동 뒤 쌓여 있던 1시간 전 명령
		assert.equal(sent.length, 0);
		await press("p:" + store.list("ms")[0]!.id, { from: 999 });
		assert.equal(sent.length, 0);
		assert.equal(store.list("ms")[0]!.state, "armed");
	});
});

describe("명령", () => {
	it("/list — 목록 + 일시정지·삭제 버튼, 일시정지된 감시엔 일시정지 버튼 없음", async () => {
		const a = await arm("ETH 2,600 이탈");
		const b = await arm("BTC <b>");
		await ops.pause("ms", b, "app");
		await text("/list");
		const body = last("sendMessage");
		assert.match(String(body?.text), /<b>감시 2개<\/b>/);
		assert.match(String(body?.text), /BTC &lt;b&gt;/); // 이름 이스케이프
		assert.match(String(body?.text), /다시 켜기는 AlphaFolio 앱/);
		assert.deepEqual(buttonData(body).sort(), [`d:${a}`, `d:${b}`, `p:${a}`].sort());
		assert.match(renderList([]).html, /감시가 없습니다/);
	});

	it("일시정지 버튼 → 멈추고 목록을 고쳐 쓴다", async () => {
		const id = await arm("a");
		await press(`p:${id}`);
		assert.equal(store.get("ms", id)?.state, "paused");
		assert.equal(last("editMessageText")?.message_id, 7);
		assert.match(String(last("answerCallbackQuery")?.text), /일시정지: a/);
	});

	it("삭제는 두 번 — 첫 버튼은 확인만 묻고, 확인을 눌러야 지운다. 오래된 확인은 다시 묻는다", async () => {
		const id = await arm("손절");
		await press(`d:${id}`);
		assert.equal(store.list("ms").length, 1);
		assert.deepEqual(buttonData(last("sendMessage")), [`D:${id}`, "x"]);
		await press(`D:${id}`, { date: sec() - 3600 });
		assert.equal(store.list("ms").length, 1);
		assert.match(String(last("editMessageText")?.text), /오래됐습니다/);
		await press(`D:${id}`);
		assert.equal(store.list("ms").length, 0);
		assert.match(String(last("editMessageText")?.text), /삭제했습니다 — 손절/);
	});

	it("/stop — 확인 후 전부 일시정지. 켜진 게 없으면 그렇게 말한다", async () => {
		await arm("a");
		await arm("b");
		await text("/stop");
		assert.deepEqual(buttonData(last("sendMessage")), ["S", "x"]);
		assert.ok(store.list("ms").every((t) => t.state === "armed"));
		await press("S");
		assert.ok(store.list("ms").every((t) => t.state === "paused"));
		await text("/stop");
		assert.match(String(last("sendMessage")?.text), /켜진 감시가 없습니다/);
	});

	it("만들기 요청은 앱으로 안내, 텔레그램에는 다시 켜기 버튼이 없다", async () => {
		await text("ETH 2700 알림 걸어줘");
		assert.match(String(last("sendMessage")?.text), /AlphaFolio 에서 합니다/);
		const id = await arm("a");
		await ops.pause("ms", id, "app");
		await press(`r:${id}`); // 없는 버튼
		assert.equal(store.get("ms", id)?.state, "paused");
	});

	it("남의 감시 id 를 눌러도 없는 것으로", async () => {
		const other = (await ops.arm("kim", ops.prepare("kim", spec("kim")).token)).id;
		await press(`D:${other}`);
		assert.equal(store.list("kim").length, 1);
		assert.match(String(last("answerCallbackQuery")?.text), /없는 감시/);
	});
});
