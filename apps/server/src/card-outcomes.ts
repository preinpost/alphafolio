/**
 * 확인 카드 결과 — 대화를 다시 열어도 카드가 어떻게 끝났는지 보이게.
 *
 * 카드는 툴 결과(세션 파일)라 바꾸지 않고, 버튼을 누른 결과는 화면 상태에만 있었다 →
 * 다시 열면 실행한 주문·이동도 모두 "확인이 취소되었습니다" 로 보였다 (실측 2026-10-08).
 * 토큰의 nonce 로 결과를 묶어 dataDir 에 남긴다 (세션 파일과 같은 곳). 한 줄 = 결과 하나 — 덧붙이기만 한다.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CardOutcome } from "@alphafolio/protocol";
import { parseCard } from "./serialize.ts";

/** 서명 토큰의 nonce — 서명은 보지 않는다 (사용자별로 묶어 기록·조회만 하므로 위조해도 자기 화면만 바뀐다) */
export function tokenNonce(token: unknown): string | null {
	if (typeof token !== "string") return null;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	try {
		const p = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")) as { nonce?: unknown };
		return typeof p.nonce === "string" ? p.nonce : null;
	} catch {
		return null;
	}
}

interface Line extends CardOutcome {
	u: string;
	n: string;
}

export type OutcomeListener = (user: string, token: unknown, outcome: CardOutcome) => void;

export class CardOutcomeStore {
	private readonly byKey = new Map<string, CardOutcome>();
	/** null 이면 메모리에만 (테스트) */
	private readonly file: string | null;
	/** 새로 남긴 결과 — 에이전트에게 알린다 (무시한 기록은 부르지 않는다) */
	private readonly onRecord: OutcomeListener | undefined;

	constructor(file: string | null, onRecord?: OutcomeListener) {
		this.file = file;
		this.onRecord = onRecord;
		if (!file) return;
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return; // 아직 없다
		}
		for (const raw of text.split("\n")) {
			if (!raw) continue;
			try {
				const { u, n, ...outcome } = JSON.parse(raw) as Line;
				this.byKey.set(`${u}\0${n}`, outcome);
			} catch {
				// 쓰다 끊긴 마지막 줄 — 버린다
			}
		}
	}

	get(user: string, token: unknown): CardOutcome | undefined {
		const nonce = tokenNonce(token);
		return nonce ? this.byKey.get(`${user}\0${nonce}`) : undefined;
	}

	record(user: string, token: unknown, outcome: Omit<CardOutcome, "at">, now = Date.now()): void {
		const nonce = tokenNonce(token);
		if (!nonce) return;
		const key = `${user}\0${nonce}`;
		const prev = this.byKey.get(key);
		// 실행 결과가 남는다 — 실행 뒤의 재클릭("이미 처리된 주문")·닫기가 덮지 않는다.
		// 실패 뒤 같은 카드로 다시 시도해 성공하면(감시 켜기의 한도 확인) 덮는다
		if (prev && (prev.state === "done" || outcome.state === "dismissed")) return;
		const full: CardOutcome = { ...outcome, at: now };
		this.byKey.set(key, full);
		this.onRecord?.(user, token, full);
		if (!this.file) return;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, `${JSON.stringify({ u: user, n: nonce, ...full } satisfies Line)}\n`);
		} catch (err) {
			// 기록 실패로 실행 결과 응답을 막지 않는다 — 이번 실행 동안은 메모리에 있다
			console.warn(`[card] 결과 기록 실패: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 실행하며 결과를 남긴다 — 던진 오류도 실패로 남기고 그대로 던진다 */
	async run<T>(user: string, token: unknown, exec: () => Promise<T>, describe: (r: T) => Omit<CardOutcome, "at">): Promise<T> {
		try {
			const r = await exec();
			this.record(user, token, describe(r));
			return r;
		} catch (err) {
			this.record(user, token, { state: "failed", message: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}
}

// ── 에이전트에게 알리기 ─────────────────────────────────────────────────
// 카드를 연쇄로 띄울 때(매수 → Earn 이동 → 손절) 에이전트가 앞 카드를 눌렀는지 몰라 대화가 끊겼다.
// 버튼 결과를 그 카드가 나온 대화에 모델만 보는 메시지로 넣는다 (새 답을 시작하지는 않는다).

/** 버튼은 토큰 수명(주문 2분·감시 10분) 안에만 눌린다 — 여유를 두고 잊는다 */
const ORIGIN_TTL_MS = 30 * 60_000;

interface Origin {
	sessionId: string;
	/** 모델이 어느 카드인지 알아볼 한 줄 (툴 결과 첫 줄) */
	label: string;
	until: number;
}

/** 카드가 어느 대화에서 나왔는가 — 토큰에는 대화가 없다 (툴은 사용자 단위로 만들어져 대화를 모른다) */
export class CardOrigins {
	private readonly byKey = new Map<string, Origin>();

	/** tool_execution_end 마다 — 확인 카드면 기억한다 */
	remember(user: string, sessionId: string, toolName: string, result: unknown, now = Date.now()): void {
		const r = result as { details?: unknown; content?: unknown } | null;
		const card = parseCard(r?.details);
		const nonce = tokenNonce(card?.token);
		if (!nonce) return;
		for (const [k, o] of this.byKey) if (o.until < now) this.byKey.delete(k);
		this.byKey.set(`${user}\0${nonce}`, { sessionId, label: cardLabel(toolName, r?.content), until: now + ORIGIN_TTL_MS });
	}

	get(user: string, token: unknown): Omit<Origin, "until"> | undefined {
		const nonce = tokenNonce(token);
		return nonce ? this.byKey.get(`${user}\0${nonce}`) : undefined;
	}
}

function cardLabel(toolName: string, content: unknown): string {
	const text = Array.isArray(content)
		? content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
		: "";
	const line = (text.split("\n")[0] ?? "").replace(/^확인이 필요합니다\s*[—-]\s*/, "").trim();
	const short = line.length > 160 ? `${line.slice(0, 160)}…` : line;
	return short ? `${toolName} — ${short}` : toolName;
}

/** 모델에게 가는 문장 — persona 가 "[확인 카드 결과]" 를 서버 메시지로 읽게 안내한다 */
export function outcomeNote(label: string, o: Pick<CardOutcome, "state" | "message">): string {
	const head = `[확인 카드 결과] ${label}`;
	switch (o.state) {
		case "done":
			return `${head}\n→ 사용자가 확인을 눌러 실행됐습니다.${o.message ? ` 결과: ${o.message}` : ""}`;
		case "failed":
			return `${head}\n→ 사용자가 확인을 눌렀지만 실패했습니다.${o.message ? ` 사유: ${o.message}` : ""}`;
		case "dismissed":
			return `${head}\n→ 사용자가 [닫기]를 눌렀습니다. 실행하지 않았습니다.`;
	}
}
