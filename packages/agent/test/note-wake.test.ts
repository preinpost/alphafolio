/**
 * 확인 카드 결과를 대화에 알리기 — 쉬고 있는 대화에 done/failed 결과가 오면 새 턴이 시작되어야 한다.
 *
 * 실제 pi AgentSession 을 쓴다. 모델만 가짜다 (modelRuntime.streamSimple) — 실거래·네트워크 없음.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { deliverNote, promptSession } from "../src/runtime.ts";

const dir = mkdtempSync(join(tmpdir(), "af-note-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const model = {
	id: "fake",
	name: "fake",
	api: "fake-api",
	provider: "fake",
	input: ["text"],
	reasoning: false,
	contextWindow: 1000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 모델 호출 수를 센다. hold 가 켜져 있으면 응답을 gate 가 풀릴 때까지 붙든다 (스트리밍 중 상태 재현). */
function fakeRuntime() {
	const st = { calls: 0, hold: false, gate: Promise.resolve(), open: () => {} };
	const mr: any = new Proxy(
		{},
		{
			get(_t, name) {
				if (name === "streamSimple")
					return () => {
						st.calls++;
						const msg = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "fake-api", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
						const wait = st.hold ? st.gate : Promise.resolve();
						return {
							async *[Symbol.asyncIterator]() {
								yield { type: "start", partial: msg };
								await wait;
								yield { type: "done", reason: "stop", message: msg };
							},
							async result() {
								await wait;
								return msg;
							},
						};
					};
				if (name === "hasConfiguredAuth") return () => true;
				if (name === "getModel" || name === "getPhysicalModel" || name === "resolveModel") return () => model;
				if (name === "getAuth") return async () => ({ ok: true, apiKey: "x" });
				if (name === "checkAuth") return async () => ({ ok: true });
				if (name === "getAvailableSnapshot" || name === "getAvailable" || name === "getModels") return () => [model];
				return () => undefined;
			},
		},
	);
	return { st, mr };
}

async function openSession() {
	const { st, mr } = fakeRuntime();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: mr,
		model: model as any,
		sessionManager: SessionManager.inMemory(dir),
		thinkingLevel: "off",
	} as any);
	return { session, st };
}

const NOTE = { customType: "card-outcome", text: "[확인 카드 결과] 이체\n→ 사용자가 확인을 눌러 실행됐습니다. 결과: 옮겼습니다", details: { state: "done" } };
const customs = (s: any) => s.messages.filter((m: any) => m.role === "custom").map((m: any) => m.content);

describe("확인 카드 결과 알리기", () => {
	it("쉬고 있는 대화에 done 결과 → 새 턴이 시작된다 (모델 호출 1회, 결과가 기록에 남음)", async () => {
		const { session, st } = await openSession();
		await deliverNote(session, NOTE.customType, NOTE.text, NOTE.details, true);
		assert.equal(st.calls, 1, "idle done 결과는 새 턴을 열어야 한다");
		assert.equal(customs(session).length, 1);
		assert.equal(session.isStreaming, false);
	});

	it("쉬고 있는 대화에 failed 결과 → 새 턴이 시작된다", async () => {
		const { session, st } = await openSession();
		await deliverNote(session, NOTE.customType, "[확인 카드 결과] 이체\n→ 실패했습니다. 사유: 잔고 부족", { state: "failed" }, true);
		assert.equal(st.calls, 1);
	});

	it("닫기(dismissed)는 기록만 — 턴을 열지 않는다", async () => {
		const { session, st } = await openSession();
		await deliverNote(session, NOTE.customType, "[확인 카드 결과] 이체\n→ 사용자가 [닫기] 했습니다.", { state: "dismissed" }, false);
		assert.equal(st.calls, 0);
		assert.equal(customs(session).length, 1, "기록은 남는다");
	});

	it("응답 중이면 steer — 같은 턴 안에서 이어진다 (새 턴을 따로 열지 않는다)", async () => {
		const { session, st } = await openSession();
		let release!: () => void;
		st.gate = new Promise<void>((r) => (release = r));
		st.hold = true;
		const run = promptSession(session, "잔고 옮겨줘");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(session.isStreaming, true);
		await deliverNote(session, NOTE.customType, NOTE.text, NOTE.details, true);
		st.hold = false;
		release();
		await run;
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(st.calls, 2, "steer 로 들어간 결과에 대해 한 번 더 응답");
		assert.equal(customs(session).length, 1);
	});

	it("쉬는 중 사용자 메시지와 겹쳐도 결과는 유실되지 않는다 — 사용자 입력은 에러 없이 들어간다", async () => {
		const { session, st } = await openSession();
		// 사용자 입력은 입력 처리 뒤에 시작하므로, 그 사이에 결과 턴이 먼저 시작될 수 있다
		const user = promptSession(session, "고마워");
		await deliverNote(session, NOTE.customType, NOTE.text, NOTE.details, true);
		await user;
		await new Promise((r) => setTimeout(r, 50));
		// 기대: 결과 턴(모델 1회) 다음 사용자 턴(모델 1회) — 결과는 한 번만 기록되고, 사용자 입력은 에러 없이 뒤에 들어간다
		assert.equal(st.calls, 2, "결과 턴 1회 + 사용자 턴 1회");
		assert.equal(customs(session).length, 1, "결과가 정확히 한 번 기록됐다");
		const roles = session.messages.map((m: any) => (m.role === "custom" ? "custom" : m.role === "user" ? "user" : m.role));
		assert.deepEqual(roles.filter((r: string) => r !== "system"), ["custom", "assistant", "user", "assistant"]);
	});

	it("같은 문구의 이전 다른 카드 결과가 있어도, 새 턴 실패 시 새 결과는 기록된다 (유실 금지)", async () => {
		const calls: Array<{ triggerTurn?: boolean }> = [];
		const earlier = { role: "custom", customType: NOTE.customType, content: NOTE.text, display: false, details: { state: "done", nonce: "older-card" } };
		const stub = {
			isStreaming: false,
			messages: [earlier] as any[],
			async sendCustomMessage(m: any, opts?: { triggerTurn?: boolean }) {
				calls.push({ triggerTurn: opts?.triggerTurn });
				if (opts?.triggerTurn) throw new Error("Agent is already processing");
				this.messages.push({ role: "custom", ...m });
			},
		};
		await deliverNote(stub as any, NOTE.customType, NOTE.text, { state: "done", nonce: "new-card" }, true);
		assert.deepEqual(calls, [{ triggerTurn: true }, { triggerTurn: undefined }], "다른 카드의 결과로 판단해 버리면 안 된다");
		assert.equal(stub.messages.filter((m: any) => m.details?.nonce === "new-card").length, 1);
	});

	it("같은 카드·같은 상태의 결과가 이미 기록돼 있으면 폴백이 또 쌓지 않는다", async () => {
		const same = { role: "custom", customType: NOTE.customType, content: NOTE.text, display: false, details: { state: "done", nonce: "card-1" } };
		const stub = {
			isStreaming: false,
			messages: [same] as any[],
			async sendCustomMessage(m: any, opts?: { triggerTurn?: boolean }) {
				if (opts?.triggerTurn) throw new Error("Agent is already processing");
				this.messages.push({ role: "custom", ...m });
			},
		};
		await deliverNote(stub as any, NOTE.customType, NOTE.text, { state: "done", nonce: "card-1" }, true);
		assert.equal(stub.messages.length, 1);
	});

	it("새 턴 시작이 실패하면 기록은 남기고 끼워 넣기로 폴백한다", async () => {
		const calls: Array<{ triggerTurn?: boolean }> = [];
		const stub = {
			isStreaming: false,
			messages: [] as any[],
			async sendCustomMessage(_m: unknown, opts?: { triggerTurn?: boolean }) {
				calls.push({ triggerTurn: opts?.triggerTurn });
				if (opts?.triggerTurn) throw new Error("Agent is already processing");
			},
		};
		await deliverNote(stub as any, NOTE.customType, NOTE.text, NOTE.details, true);
		assert.deepEqual(calls, [{ triggerTurn: true }, { triggerTurn: undefined }]);
	});
});
