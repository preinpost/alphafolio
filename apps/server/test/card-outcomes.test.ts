/**
 * 확인 카드 결과 기록 — 대화를 다시 열어도 실행한 카드가 "취소" 로 보이지 않게.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CardOrigins, CardOutcomeStore, outcomeNote, tokenNonce } from "../src/card-outcomes.ts";
import { createOrderToken } from "../src/order-tokens.ts";
import { serializeMessages } from "../src/serialize.ts";

const token = (u = "alice") => createOrderToken({ u }, "secret").token;

describe("카드 결과 기록", () => {
	const dir = mkdtempSync(join(tmpdir(), "af-card-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("토큰에서 nonce 를 읽는다 — 이상한 값은 null", () => {
		const { token: t, payload } = createOrderToken({ u: "alice" }, "secret");
		assert.equal(tokenNonce(t), payload.nonce);
		assert.equal(tokenNonce("garbage"), null);
		assert.equal(tokenNonce(null), null);
	});

	it("파일에 남아 다시 띄워도 읽힌다 — 사용자별로", () => {
		const file = join(dir, "a.jsonl");
		const t = token();
		new CardOutcomeStore(file).record("alice", t, { state: "done", message: "주문했습니다" }, 1);
		const again = new CardOutcomeStore(file);
		assert.deepEqual(again.get("alice", t), { state: "done", message: "주문했습니다", at: 1 });
		assert.equal(again.get("bob", t), undefined);
		assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
	});

	it("실행 결과는 닫기·재클릭 실패가 덮지 않는다", () => {
		const s = new CardOutcomeStore(null);
		const t = token();
		s.record("alice", t, { state: "done", message: "옮겼습니다" });
		s.record("alice", t, { state: "failed", message: "이미 처리된 주문입니다." });
		s.record("alice", t, { state: "dismissed", message: null });
		assert.equal(s.get("alice", t)?.message, "옮겼습니다");
	});

	it("실패 뒤 다시 시도한 성공은 덮는다 (감시 켜기의 한도 확인)", () => {
		const s = new CardOutcomeStore(null);
		const t = token();
		s.record("alice", t, { state: "failed", message: "한도를 먼저 정해 주세요" });
		s.record("alice", t, { state: "done", message: "켰습니다" });
		assert.equal(s.get("alice", t)?.state, "done");
	});

	it("run — 던진 오류도 실패로 남기고 그대로 던진다", async () => {
		const s = new CardOutcomeStore(null);
		const t = token();
		await assert.rejects(s.run("alice", t, async () => Promise.reject(new Error("거절")), () => ({ state: "done", message: null })), /거절/);
		assert.deepEqual({ ...s.get("alice", t), at: 0 }, { state: "failed", message: "거절", at: 0 });
	});

	it("기록을 직렬화한 카드에 붙인다", () => {
		const s = new CardOutcomeStore(null);
		const t = token();
		s.record("alice", t, { state: "done", message: "옮겼습니다" }, 5);
		const out = serializeMessages(
			[
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "binance_transfer", arguments: {} }] },
				{ role: "toolResult", toolCallId: "c1", content: [], details: { kind: "binance-transfer-card", ok: true, token: t } },
			],
			(tok) => s.get("alice", tok),
		);
		const block = out[0]!.content[0]!;
		assert.equal(block.type, "toolCall");
		assert.deepEqual(block.type === "toolCall" ? block.result?.outcome : null, { state: "done", message: "옮겼습니다", at: 5 });
	});
});

describe("에이전트에게 버튼 결과 알리기", () => {
	const transferResult = (t: string) => ({
		content: [{ type: "text", text: "확인이 필요합니다 — [Binance 지갑 이동] 현물 → Earn 유연 예치 ETH 전량(약 0.37) · 이동 가능 0.37." }],
		details: { kind: "binance-transfer-card", ok: true, token: t },
	});

	it("확인 카드가 나온 대화를 기억한다 — 조회 결과는 무시", () => {
		const o = new CardOrigins();
		const t = token();
		o.remember("alice", "s1", "binance_wallet", transferResult(t));
		o.remember("alice", "s2", "quote", { content: [], details: { kind: "quote-card", token: token() } });
		assert.equal(o.get("alice", t)?.sessionId, "s1");
		assert.match(o.get("alice", t)!.label, /^binance_wallet — \[Binance 지갑 이동\] 현물 → Earn/);
		assert.equal(o.get("bob", t), undefined);
	});

	it("오래된 카드는 잊는다", () => {
		const o = new CardOrigins();
		const old = token();
		o.remember("alice", "s1", "x", transferResult(old), 0);
		o.remember("alice", "s1", "x", transferResult(token()), 31 * 60_000);
		assert.equal(o.get("alice", old), undefined);
	});

	it("새로 남긴 결과만 알린다 — 실행 뒤의 닫기는 알리지 않는다", () => {
		const seen: string[] = [];
		const s = new CardOutcomeStore(null, (_u, _t, o) => seen.push(o.state));
		const t = token();
		s.record("alice", t, { state: "done", message: "옮겼습니다" });
		s.record("alice", t, { state: "dismissed", message: null });
		assert.deepEqual(seen, ["done"]);
	});

	it("문장 — 실행·실패·닫기", () => {
		assert.match(outcomeNote("L", { state: "done", message: "옮겼습니다" }), /^\[확인 카드 결과\] L\n→ 사용자가 확인을 눌러 실행됐습니다\. 결과: 옮겼습니다$/);
		assert.match(outcomeNote("L", { state: "failed", message: "잔고 부족" }), /실패했습니다\. 사유: 잔고 부족/);
		assert.match(outcomeNote("L", { state: "dismissed", message: null }), /\[닫기\]/);
	});
});
