/**
 * 사용자별 에이전트 런타임 관리.
 *
 * 왜 필요한가: 런타임이 하나뿐이면 두 사람이 접속했을 때 세션과 이벤트가 섞인다
 * (한쪽 대화가 다른 쪽 화면에 그대로 뜬다). 사용자마다 독립 런타임·세션 디렉터리를 쓴다.
 *
 * 생성은 지연(첫 접속 시)이고, 접속이 없고 유휴 시간이 지나면 정리한다.
 * 사용자 수가 적은 전제(가족)라 상한을 두지 않지만, 유휴 정리로 메모리는 회수한다.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildSystemPrompt, createAlphaFolioRuntime, type AlphaFolioRuntime } from "@alphafolio/agent";
import { createLedgerTools, type D1Provider } from "@alphafolio/ledger/tools";
import { createBrokerTools } from "@alphafolio/broker/tools";
import type { BrokerAccess, NaverCredentials } from "@alphafolio/broker";

export interface RuntimeManagerOptions {
	dataDir: string;
	agentDir: string;
	model: string | undefined;
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
	/**
	 * 주문 확인 토큰 발급기. 툴은 이걸로 **준비만** 하고, 실행은 사람이
	 * /api/orders/execute 를 호출해야 한다.
	 */
	prepareOrder: (user: string) => NonNullable<Parameters<typeof createBrokerTools>[0]["prepareOrder"]>;
	/** 유휴 정리 기준(분). 0이면 정리하지 않는다. */
	idleMinutes: number;
}

interface Entry {
	runtime: AlphaFolioRuntime;
	/** 현재 붙어 있는 클라이언트 수 — 0이어야 정리 대상 */
	refCount: number;
	lastActive: number;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

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
	private readonly entries = new Map<string, Entry>();
	/** 동시 접속 시 같은 사용자의 런타임이 두 번 만들어지지 않게 한다 */
	private readonly pending = new Map<string, Promise<AlphaFolioRuntime>>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(opts: RuntimeManagerOptions) {
		this.opts = opts;
		if (opts.idleMinutes > 0) {
			this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
			this.sweeper.unref();
		}
	}

	async get(user: string): Promise<AlphaFolioRuntime> {
		const existing = this.entries.get(user);
		if (existing) {
			existing.lastActive = Date.now();
			return existing.runtime;
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

	private async create(user: string): Promise<AlphaFolioRuntime> {
		// 사용자별 디렉터리 — 세션 파일이 섞이지 않게 한다
		const cwd = join(this.opts.dataDir, "workspace", user);
		const sessionsDir = join(this.opts.dataDir, "sessions", user);
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionsDir, { recursive: true });

		const runtime = await createAlphaFolioRuntime({
			cwd,
			agentDir: this.opts.agentDir,
			sessionsDir,
			model: this.opts.model,
			authPath: this.opts.authPath,
			excludeTools: EXCLUDED_TOOLS,
			customTools: [
				// 가계부는 공유(한 D1)지만 기록자는 사용자별로 박힌다
				...createLedgerTools(this.opts.ledgerConfig, user),
				// 증권 자격증명은 사용자별 — 컨텍스트를 user 로 바인딩한다
				...createBrokerTools({
					brokers: this.opts.brokerAccess(user),
					ledger: this.opts.ledgerConfig,
					member: user,
					naver: () => this.opts.naverCreds(user),
					prepareOrder: this.opts.prepareOrder(user),
				}),
			],
			systemPrompt: buildSystemPrompt({ ledgerEnabled: true, member: user }),
		});

		this.entries.set(user, { runtime, refCount: 0, lastActive: Date.now() });
		console.log(`[runtime] 생성 — user=${user} sessions=${sessionsDir}`);
		return runtime;
	}

	/** 클라이언트 연결 시작 — 유휴 정리 대상에서 제외한다. */
	acquire(user: string): void {
		const entry = this.entries.get(user);
		if (!entry) return;
		entry.refCount += 1;
		entry.lastActive = Date.now();
	}

	/** 클라이언트 연결 종료. */
	release(user: string): void {
		const entry = this.entries.get(user);
		if (!entry) return;
		entry.refCount = Math.max(0, entry.refCount - 1);
		entry.lastActive = Date.now();
	}

	touch(user: string): void {
		const entry = this.entries.get(user);
		if (entry) entry.lastActive = Date.now();
	}

	private async sweep(): Promise<void> {
		const cutoff = Date.now() - this.opts.idleMinutes * 60_000;
		for (const [user, entry] of this.entries) {
			if (entry.refCount > 0 || entry.lastActive > cutoff) continue;
			this.entries.delete(user);
			try {
				await entry.runtime.dispose();
				console.log(`[runtime] 유휴 정리 — user=${user}`);
			} catch (err) {
				console.warn(`[runtime] 정리 실패 — user=${user}:`, err);
			}
		}
	}

	async disposeAll(): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		const all = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(all.map((e) => e.runtime.dispose()));
	}

	get activeUsers(): string[] {
		return [...this.entries.keys()];
	}
}
