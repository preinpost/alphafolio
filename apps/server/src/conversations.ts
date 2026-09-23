/**
 * 대화 풀 — 사용자 한 명의 열린 대화들 (PLAN §24).
 *
 * 대화마다 pi 세션을 따로 띄운다. 그래서
 *   - 탭 A 가 대화 X, 탭 B 가 대화 Y 를 봐도 서로 끌어가지 않는다
 *   - 클라이언트가 끊겨도(앱 종료·백그라운드) 대화는 서버에서 끝까지 돈다 — 응답 중인 대화는 정리하지 않는다
 *
 * pi 의존이 없는 순수 로직이라 가짜 대화로 테스트한다 (test/conversations.test.ts).
 */

export interface PooledConversation {
	readonly sessionId: string;
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	dispose(): Promise<void>;
}

export interface ConversationSource<C extends PooledConversation> {
	create(): Promise<C>;
	/** 저장된 대화 열기. 없으면 null — 다른 사용자의 대화도 이 사용자에게는 "없음" 이다. */
	open(sessionId: string): Promise<C | null>;
}

interface Entry<C> {
	conv: C;
	/** 붙어 있는 클라이언트 수 */
	refs: number;
	lastActive: number;
	unsubscribe: () => void;
}

/** pi 세션 id 형식 (UUID 계열). 이상한 값은 파일 목록을 뒤지기 전에 거른다. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export class ConversationPool<C extends PooledConversation> {
	private readonly entries = new Map<string, Entry<C>>();
	/** 같은 대화를 동시에 두 번 열지 않게 (탭 두 개가 같은 URL 로 동시에 붙는 경우) */
	private readonly opening = new Map<string, Promise<C | null>>();

	private readonly source: ConversationSource<C>;
	/** 모든 대화의 이벤트 — 클라이언트가 없어도 흐른다 (활동 표시·로그용) */
	private readonly onEvent: (sessionId: string, event: unknown) => void;
	private readonly now: () => number;

	constructor(
		source: ConversationSource<C>,
		onEvent: (sessionId: string, event: unknown) => void,
		now: () => number = Date.now,
	) {
		this.source = source;
		this.onEvent = onEvent;
		this.now = now;
	}

	/**
	 * 대화 가져오기. null 이면 새 대화를 만든다.
	 * 저장된 대화가 없으면 null (클라이언트는 새 대화로 돌아간다).
	 */
	async get(sessionId: string | null): Promise<C | null> {
		if (sessionId === null) return this.register(await this.source.create());

		const existing = this.entries.get(sessionId);
		if (existing) {
			existing.lastActive = this.now();
			return existing.conv;
		}
		if (!SESSION_ID_RE.test(sessionId)) return null;

		let pending = this.opening.get(sessionId);
		if (!pending) {
			pending = this.source.open(sessionId).then((conv) => (conv ? this.register(conv) : null));
			this.opening.set(sessionId, pending);
			void pending.finally(() => this.opening.delete(sessionId)).catch(() => {});
		}
		return pending;
	}

	private register(conv: C): C {
		const id = conv.sessionId;
		const already = this.entries.get(id);
		if (already) {
			// 경합으로 같은 대화가 두 번 열렸다 — 먼저 등록된 것을 쓰고 나중 것은 닫는다
			void conv.dispose();
			return already.conv;
		}
		const unsubscribe = conv.subscribe((event) => this.onEvent(id, event));
		this.entries.set(id, { conv, refs: 0, lastActive: this.now(), unsubscribe });
		return conv;
	}

	/** 이미 떠 있는 대화만 (열지 않는다) — 이벤트 처리 중 메시지 목록을 읽을 때 */
	peek(sessionId: string): C | undefined {
		return this.entries.get(sessionId)?.conv;
	}

	/** 클라이언트가 이 대화를 보기 시작 */
	attach(sessionId: string): void {
		const e = this.entries.get(sessionId);
		if (!e) return;
		e.refs += 1;
		e.lastActive = this.now();
	}

	/** 클라이언트가 떠남 (다른 대화로 이동·연결 종료). 대화는 계속 돈다. */
	detach(sessionId: string): void {
		const e = this.entries.get(sessionId);
		if (!e) return;
		e.refs = Math.max(0, e.refs - 1);
		e.lastActive = this.now();
	}

	touch(sessionId: string): void {
		const e = this.entries.get(sessionId);
		if (e) e.lastActive = this.now();
	}

	/** 지금 응답 중인 대화 id */
	running(): string[] {
		return [...this.entries.values()].filter((e) => e.conv.isStreaming).map((e) => e.conv.sessionId);
	}

	/** 열린 대화 아무거나 — 툴 목록 등 대화와 무관한 정보를 읽을 때 */
	any(): C | undefined {
		return this.entries.values().next().value?.conv;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * 유휴 대화를 메모리에서 내린다 (파일은 남는다 — 다시 열면 이어진다).
	 * **응답 중인 대화는 절대 내리지 않는다** — 사용자가 앱을 꺼도 답은 끝까지 만들어져야 한다.
	 */
	async sweep(idleMs: number): Promise<string[]> {
		const cutoff = this.now() - idleMs;
		const victims: Entry<C>[] = [];
		for (const [id, e] of this.entries) {
			if (e.refs > 0 || e.conv.isStreaming || e.lastActive > cutoff) continue;
			this.entries.delete(id);
			victims.push(e);
		}
		await Promise.allSettled(
			victims.map(async (e) => {
				e.unsubscribe();
				await e.conv.dispose();
			}),
		);
		return victims.map((e) => e.conv.sessionId);
	}

	async disposeAll(): Promise<void> {
		const all = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(
			all.map(async (e) => {
				e.unsubscribe();
				await e.conv.dispose();
			}),
		);
	}
}
