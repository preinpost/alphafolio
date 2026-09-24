/**
 * 사용자별 에이전트 + 대화 관리.
 *
 * 사용자마다 에이전트(모델·자격증명·툴) 하나, 그 아래 **대화마다 pi 세션 하나** (PLAN §24).
 *   - 사용자 사이: 세션 디렉터리·툴 자격증명이 분리된다 (대화가 남의 화면에 뜨지 않는다)
 *   - 대화 사이: 탭·기기마다 다른 대화를 봐도 서로 끌어가지 않는다
 *   - 클라이언트가 끊겨도 응답 중인 대화는 끝까지 돈다 (ConversationPool.sweep)
 *
 * 생성은 지연(첫 접속 시)이고, 유휴 대화는 메모리에서 내린다 (파일은 남아 다시 열면 이어진다).
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
	buildSystemPrompt,
	createAlphaFolioAgent,
	type AlphaFolioAgent,
	type AlphaFolioConversation,
	type ThinkingLevel,
} from "@alphafolio/agent";
import { createLedgerTools, type D1Provider } from "@alphafolio/ledger/tools";
import { createBrokerTools } from "@alphafolio/broker/tools";
import { createOrderTools } from "@alphafolio/broker/order-tools";
import { createDataTools } from "@alphafolio/broker/data-tools";
import type { DataCreds } from "@alphafolio/broker";
import type { BrokerAccess, NaverCredentials } from "@alphafolio/broker";
import type { ConversationListItem } from "@alphafolio/protocol";
import { ConversationPool, SESSION_ID_RE } from "./conversations.ts";

export interface RuntimeManagerOptions {
	dataDir: string;
	agentDir: string;
	model: string | undefined;
	thinking: ThinkingLevel;
	authPath: string | undefined;
	/**
	 * 가계부 D1 설정 공급자. 호출 시점에 조회하므로 앱에서 키를 나중에 넣어도
	 * 재시작 없이 동작한다 (미설정이면 툴 실행 시 안내 메시지로 실패).
	 */
	ledgerConfig: D1Provider;
	/**
	 * 사용자별 증권사 접근자 (KIS·토스). 자격증명이 사람마다 다르므로 user 를 받는다.
	 * 미설정 브로커는 호출 시점에 걸러지고, 아무것도 없으면 툴이 설정 안내로 실패한다.
	 */
	brokerAccess: (user: string) => BrokerAccess;
	/** 사용자별 네이버 뉴스 자격증명. 미설정이면 툴 실행 시 설정 안내로 실패한다. */
	naverCreds: (user: string) => NaverCredentials;
	/** 해외·코인 데이터 제공자 키 (finnhub·Twelve·CoinGecko·Binance) */
	dataCreds: (user: string) => DataCreds;
	/**
	 * 주문 확인 토큰 발급기. 툴은 이걸로 **준비만** 하고, 실행은 사람이
	 * /api/orders/execute 를 호출해야 한다.
	 */
	prepareOrder: (user: string) => NonNullable<Parameters<typeof createBrokerTools>[0]["prepareOrder"]>;
	/** 사용자가 직접 저장한 LLM 키 (providerId → key). env 값은 넣지 않는다 — pi 가 알아서 읽는다. */
	llmKeys: (user: string) => Record<string, string>;
	/** 유휴 대화 정리 기준(분). 0이면 정리하지 않는다. 응답 중인 대화는 기준과 무관하게 남는다. */
	idleMinutes: number;
}

/** 대화 이벤트 수신자 — ws.ts 가 등록한다. 클라이언트가 없는 대화의 이벤트도 온다. */
export type ConversationListener = (user: string, sessionId: string, event: unknown) => void;

interface UserEntry {
	agent: AlphaFolioAgent;
	pool: ConversationPool<AlphaFolioConversation>;
	lastActive: number;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;
const TITLE_MAX = 40;

/**
 * 모델에 노출하지 않을 내장 툴.
 *
 * 금융 앱에 파일시스템·셸이 필요 없다. 허용목록 대신 거부목록을 쓰는 이유는
 * 확장(pi-web-access 등)이 등록하는 툴을 매번 목록에 추가하지 않아도 되게 하기 위함이다
 * (허용목록이면 확장 툴이 조용히 사라진다).
 */
const EXCLUDED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"];

export class RuntimeManager {
	private readonly opts: RuntimeManagerOptions;
	private readonly users = new Map<string, UserEntry>();
	/** 동시 접속 시 같은 사용자의 에이전트가 두 번 만들어지지 않게 한다 */
	private readonly pending = new Map<string, Promise<UserEntry>>();
	private readonly listeners = new Set<ConversationListener>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(opts: RuntimeManagerOptions) {
		this.opts = opts;
		if (opts.idleMinutes > 0) {
			this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
			this.sweeper.unref();
		}
	}

	onEvent(listener: ConversationListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async user(user: string): Promise<UserEntry> {
		const existing = this.users.get(user);
		if (existing) {
			existing.lastActive = Date.now();
			return existing;
		}
		const inFlight = this.pending.get(user);
		if (inFlight) return inFlight;

		const promise = this.create(user);
		this.pending.set(user, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(user);
		}
	}

	private async create(user: string): Promise<UserEntry> {
		// 사용자별 디렉터리 — 세션 파일이 섞이지 않게 한다
		const cwd = join(this.opts.dataDir, "workspace", user);
		const sessionsDir = join(this.opts.dataDir, "sessions", user);
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionsDir, { recursive: true });

		const agent = await createAlphaFolioAgent({
			cwd,
			agentDir: this.opts.agentDir,
			sessionsDir,
			model: this.opts.model,
			thinkingLevel: this.opts.thinking,
			authPath: this.opts.authPath,
			apiKeys: this.opts.llmKeys(user),
			excludeTools: EXCLUDED_TOOLS,
			customTools: [
				// 가계부는 멤버끼리 공유되지만 기록자는 사용자별로 박힌다
				...createLedgerTools(this.opts.ledgerConfig, user),
				// 증권 자격증명은 사용자별 — 컨텍스트를 user 로 바인딩한다
				...createBrokerTools({
					brokers: this.opts.brokerAccess(user),
					ledger: this.opts.ledgerConfig,
					member: user,
					naver: () => this.opts.naverCreds(user),
					prepareOrder: this.opts.prepareOrder(user),
				}),
				// 정정·취소·조건주문 — 역시 준비만 (확인 카드)
				...createOrderTools({ brokers: this.opts.brokerAccess(user), prepareOrder: this.opts.prepareOrder(user) }),
				// 해외·코인 데이터 — 조회만
				...createDataTools({ creds: () => this.opts.dataCreds(user) }),
			],
			systemPrompt: buildSystemPrompt({ ledgerEnabled: true, member: user }),
		});

		const pool = new ConversationPool<AlphaFolioConversation>(
			{
				create: () => agent.create(),
				// id 로 경로를 조립하지 않는다 — 이 사용자의 세션 목록에서만 찾는다 (남의 대화·경로 조작 차단)
				open: async (sessionId) => {
					const found = (await agent.listSessions()).find((s) => s.id === sessionId);
					return found ? agent.open(found.path) : null;
				},
			},
			(sessionId, event) => {
				for (const l of this.listeners) l(user, sessionId, event);
			},
		);

		const entry: UserEntry = { agent, pool, lastActive: Date.now() };
		this.users.set(user, entry);
		console.log(`[runtime] 생성 — user=${user} sessions=${sessionsDir}`);
		return entry;
	}

	/**
	 * 대화 가져오기. sessionId 가 null 이면 새 대화.
	 * 이 사용자의 대화가 아니거나 없으면 null.
	 */
	async conversation(user: string, sessionId: string | null): Promise<AlphaFolioConversation | null> {
		return (await this.user(user)).pool.get(sessionId);
	}

	/** 이미 떠 있는 대화만 — 없으면 undefined (열지 않는다) */
	peek(user: string, sessionId: string): AlphaFolioConversation | undefined {
		return this.users.get(user)?.pool.peek(sessionId);
	}

	/** 클라이언트가 대화를 보기 시작 — 유휴 정리 대상에서 빠진다 */
	attach(user: string, sessionId: string): void {
		this.users.get(user)?.pool.attach(sessionId);
	}

	/** 클라이언트가 떠남. 대화는 계속 돈다. */
	detach(user: string, sessionId: string): void {
		this.users.get(user)?.pool.detach(sessionId);
	}

	touch(user: string, sessionId: string): void {
		const u = this.users.get(user);
		if (!u) return;
		u.lastActive = Date.now();
		u.pool.touch(sessionId);
	}

	/** 사이드바용 대화 목록 — 최근 순, 응답 중 표시 포함 */
	async listConversations(user: string): Promise<ConversationListItem[]> {
		const u = await this.user(user);
		const running = new Set(u.pool.running());
		const saved = await u.agent.listSessions();
		return saved.map((s) => ({
			id: s.id,
			title: titleOf(s.name || s.firstMessage),
			modified: s.modified,
			messageCount: s.messageCount,
			streaming: running.has(s.id),
		}));
	}

	/**
	 * 대화 삭제 — 되돌릴 수 없다. 이 사용자의 목록에 없으면 false (남의 대화도 "없음").
	 * 응답 중이면 멈추고 닫은 뒤 파일을 지운다. 보고 있던 소켓에는 ws.ts 가 알린다 (conversation_deleted).
	 */
	async deleteConversation(user: string, sessionId: string): Promise<boolean> {
		if (!SESSION_ID_RE.test(sessionId)) return false;
		const u = await this.user(user);
		const find = async () => (await u.agent.listSessions()).find((s) => s.id === sessionId);
		// 이 사용자의 대화인가 — 파일이 있거나 이 사용자의 풀에 떠 있어야 한다
		if (!u.pool.peek(sessionId) && !(await find())) return false;
		await u.pool.remove(sessionId);
		// 파일은 닫은 **뒤에** 찾는다. pi 는 첫 답이 끝나야 파일을 만들어서, 첫 답 도중에 지우면
		// 멈추는 순간 기록되며 파일이 처음 생긴다 (먼저 찾으면 "파일 없음" 으로 보고 남겨 둔다).
		const found = await find();
		if (found) await u.agent.deleteSession(found.path);
		for (const l of this.listeners) l(user, sessionId, { type: "conversation_deleted" });
		console.log(`[runtime] 대화 삭제 — user=${user} session=${sessionId}`);
		return true;
	}

	/** 대화와 무관한 정보(툴 목록·모델) — 열린 대화가 없으면 하나 만든다 (유휴 정리로 회수된다) */
	async describe(user: string): Promise<{ tools: string[]; model: string }> {
		const u = await this.user(user);
		const conv = u.pool.any() ?? (await u.pool.get(null));
		return { tools: conv?.toolNames ?? [], model: conv?.modelLabel ?? "(미설정)" };
	}

	/**
	 * 설정 화면에서 LLM 키가 바뀌었을 때 떠 있는 에이전트에 반영한다 (열린 대화 전부).
	 * 에이전트가 없으면 할 일이 없다 — 다음 생성 때 llmKeys 로 읽힌다.
	 */
	async applyLlmKey(user: string, providerId: string, key: string | null): Promise<void> {
		const entry = this.users.get(user);
		if (entry) await entry.agent.setApiKey(providerId, key);
	}

	private async sweep(): Promise<void> {
		const idleMs = this.opts.idleMinutes * 60_000;
		for (const [user, entry] of this.users) {
			try {
				const closed = await entry.pool.sweep(idleMs);
				if (closed.length > 0) console.log(`[runtime] 유휴 대화 정리 — user=${user} ${closed.length}개`);
			} catch (err) {
				console.warn(`[runtime] 정리 실패 — user=${user}:`, err);
			}
			// 열린 대화가 없고 오래 안 쓴 사용자는 에이전트도 내린다
			if (entry.pool.size === 0 && entry.lastActive < Date.now() - idleMs) this.users.delete(user);
		}
	}

	async disposeAll(): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		const all = [...this.users.values()];
		this.users.clear();
		await Promise.allSettled(all.map((e) => e.pool.disposeAll()));
	}

	get activeUsers(): string[] {
		return [...this.users.keys()];
	}
}

/** 첫 메시지를 한 줄 제목으로 */
function titleOf(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return "새 대화";
	return [...line].length > TITLE_MAX ? `${[...line].slice(0, TITLE_MAX).join("")}…` : line;
}
