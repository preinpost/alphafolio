/**
 * 확인 카드 결과를 에이전트에게 알리는 규칙 — index.ts 의 결과 리스너가 쓴다 (테스트를 위해 따로 뺐다).
 *
 * - done·failed: 에이전트가 이어 판단해야 하므로 쉬고 있으면 새 턴을 연다 (wake)
 * - dismissed(닫기): 기록만 — 모델이 알 필요만 있고 응답할 일은 없다
 * - 응답 중이면 어떤 경우든 끼워 넣기(steer)는 runtime.note 가 맡는다
 */
import type { CardOutcome } from "@alphafolio/protocol";

export function wakeForOutcome(state: CardOutcome["state"]): boolean {
	return state === "done" || state === "failed";
}

/** 알림을 받을 대화 — runtime 의 AlphaFolioConversation 중 필요한 부분만 */
export interface OutcomeTarget {
	readonly isStreaming: boolean;
	note(customType: string, text: string, details?: unknown, opts?: { wake?: boolean }): Promise<void>;
}

export interface OutcomeLog {
	info(msg: string): void;
	warn(msg: string): void;
}

export type OutcomeBranch = "missing" | "steer" | "record" | "wake";

/**
 * 결과 한 건을 대화에 알린다.
 * details 는 { state, nonce } — runtime 이 같은 카드·같은 상태의 결과가 이미 기록됐는지 이걸로 본다.
 * @returns 탄 경로: "missing" 대화 없음 · "steer" 응답 중 · "record" 기록만 · "wake" 새 턴
 */
export async function announceCardOutcome(
	conv: OutcomeTarget | null | undefined,
	origin: { sessionId: string; noteText: string },
	outcome: { state: CardOutcome["state"]; nonce?: string },
	who: string,
	log: OutcomeLog,
): Promise<OutcomeBranch> {
	if (!conv) {
		log.warn(`[card] 결과 알림 — 대화를 찾지 못함 (session=${origin.sessionId}) ${who}`);
		return "missing";
	}
	const wake = wakeForOutcome(outcome.state);
	const branch: OutcomeBranch = conv.isStreaming ? "steer" : wake ? "wake" : "record";
	const label = { steer: "streaming steer", wake: "idle 새 턴", record: "기록만" }[branch as "steer" | "wake" | "record"];
	log.info(`[card] 결과 알림 — ${label} session=${origin.sessionId.slice(0, 8)} ${who}`);
	await conv.note("card-outcome", origin.noteText, { state: outcome.state, nonce: outcome.nonce }, { wake });
	return branch;
}
