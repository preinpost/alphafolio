/**
 * 대화 풀 테스트 (PLAN §24).
 *
 * 지켜야 할 것: 응답 중인 대화는 클라이언트가 없어도 살아 있어야 하고(앱을 꺼도 답이 끝까지 나온다),
 * 같은 대화는 하나만 열리며, 없는 대화는 "없음" 으로 끝난다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationPool, type ConversationSource, type PooledConversation } from "../src/conversations.ts";

class FakeConv implements PooledConversation {
	isStreaming = false;
	disposed = false;
	readonly sessionId: string;
	private listeners = new Set<(e: unknown) => void>();
	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}
	subscribe(l: (e: unknown) => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	emit(e: unknown): void {
		for (const l of this.listeners) l(e);
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function setup(saved: string[] = []) {
	let clock = 1_000_000;
	let seq = 0;
	let opens = 0;
	const events: Array<[string, unknown]> = [];
	const source: ConversationSource<FakeConv> = {
		create: async () => new FakeConv(`new-session-${++seq}`),
		open: async (id) => {
			opens++;
			await new Promise((r) => setTimeout(r, 5)); // 파일 읽기 흉내 — 동시 호출이 겹치게
			return saved.includes(id) ? new FakeConv(id) : null;
		},
	};
	const pool = new ConversationPool(source, (id, e) => events.push([id, e]), () => clock);
	return {
		pool,
		events,
		opens: () => opens,
		advance: (ms: number) => (clock += ms),
	};
}

const HOUR = 3_600_000;

describe("대화 열기", () => {
	it("null 이면 매번 새 대화", async () => {
		const { pool } = setup();
		const a = await pool.get(null);
		const b = await pool.get(null);
		assert.notEqual(a?.sessionId, b?.sessionId);
		assert.equal(pool.size, 2);
	});

	it("저장된 대화는 열고, 이미 열린 대화는 같은 것을 준다", async () => {
		const { pool, opens } = setup(["saved-session-1"]);
		const a = await pool.get("saved-session-1");
		const b = await pool.get("saved-session-1");
		assert.ok(a);
		assert.equal(a, b);
		assert.equal(opens(), 1);
	});

	it("탭 두 개가 동시에 같은 대화를 열어도 하나만 뜬다", async () => {
		const { pool, opens } = setup(["saved-session-1"]);
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => pool.get("saved-session-1")));
		assert.ok(a);
		assert.equal(a, b);
		assert.equal(b, c);
		assert.equal(opens(), 1);
		assert.equal(pool.size, 1);
	});

	it("없는 대화(다른 사용자 것 포함)는 null", async () => {
		const { pool } = setup(["mine-session-1"]);
		assert.equal(await pool.get("others-session-1"), null);
		assert.equal(pool.size, 0);
	});

	it("이상한 id 는 파일을 뒤지지도 않는다 (경로 조작 등)", async () => {
		const { pool, opens } = setup();
		for (const bad of ["../../etc/passwd", "a", "x".repeat(65), "id with space", "abc/def12345"]) {
			assert.equal(await pool.get(bad), null, bad);
		}
		assert.equal(opens(), 0);
	});

	it("대화 이벤트는 클라이언트가 없어도 대화 id 와 함께 흐른다", async () => {
		const { pool, events } = setup();
		const c = (await pool.get(null)) as FakeConv;
		c.emit({ type: "agent_start" });
		assert.deepEqual(events, [[c.sessionId, { type: "agent_start" }]]);
	});
});

describe("유휴 정리 — 앱을 꺼도 답은 끝까지", () => {
	it("응답 중인 대화는 클라이언트가 없고 오래돼도 내리지 않는다", async () => {
		const { pool, advance } = setup();
		const c = (await pool.get(null)) as FakeConv;
		pool.attach(c.sessionId);
		c.isStreaming = true;
		pool.detach(c.sessionId); // 사용자가 앱을 껐다
		advance(5 * HOUR);

		assert.deepEqual(await pool.sweep(HOUR), []);
		assert.equal(c.disposed, false);
		assert.deepEqual(pool.running(), [c.sessionId]);

		c.isStreaming = false; // 답이 끝났다
		assert.deepEqual(await pool.sweep(HOUR), [c.sessionId]);
		assert.equal(c.disposed, true);
	});

	it("보고 있는 클라이언트가 있으면 내리지 않는다", async () => {
		const { pool, advance } = setup();
		const c = (await pool.get(null)) as FakeConv;
		pool.attach(c.sessionId);
		advance(5 * HOUR);
		assert.deepEqual(await pool.sweep(HOUR), []);
	});

	it("최근에 쓴 대화는 남기고 오래된 것만 내린다", async () => {
		const { pool, advance } = setup();
		const old = (await pool.get(null)) as FakeConv;
		advance(2 * HOUR);
		const fresh = (await pool.get(null)) as FakeConv;
		assert.deepEqual(await pool.sweep(HOUR), [old.sessionId]);
		assert.equal(fresh.disposed, false);
	});

	it("내린 대화는 다시 열 수 있고, 내린 뒤에는 이벤트가 새지 않는다", async () => {
		const { pool, advance, events } = setup(["saved-session-1"]);
		const a = (await pool.get("saved-session-1")) as FakeConv;
		advance(2 * HOUR);
		await pool.sweep(HOUR);
		a.emit({ type: "late" });
		assert.equal(events.length, 0);

		const b = await pool.get("saved-session-1");
		assert.ok(b);
		assert.notEqual(a, b);
	});

	it("detach 를 attach 보다 많이 불러도 음수가 되지 않는다", async () => {
		const { pool, advance } = setup();
		const c = (await pool.get(null)) as FakeConv;
		pool.detach(c.sessionId);
		pool.detach(c.sessionId);
		pool.attach(c.sessionId);
		advance(2 * HOUR);
		assert.deepEqual(await pool.sweep(HOUR), [], "붙어 있는 클라이언트 하나를 잃어버리면 안 된다");
	});
});
