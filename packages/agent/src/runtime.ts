/**
 * 세션 런타임 — pi SDK 접촉면을 이 파일에 가둔다.
 *
 * 서버는 AlphaFolioRuntime만 알고 pi SDK 타입을 직접 import 하지 않는다.
 * SDK 업그레이드로 깨지는 범위를 여기로 국한시키기 위함 (PLAN.md §11-2).
 *
 * SDK 0.84.4 기준 확인 사항 (docs/sdk.md와 실제 타입이 다른 부분이 있어 d.ts로 검증):
 *   - modelRuntime / resourceLoaderOptions 는 createAgentSessionServices 의 옵션이다
 *     (createAgentSessionFromServices 가 아님)
 *   - 시스템 프롬프트는 resourceLoaderOptions.systemPrompt 로 넘긴다
 *   - customTools 타입은 ToolDefinition[]
 *   - agentDir 를 명시하지 않으면 사용자의 전역 확장(~/.pi/agent)이 딸려온다
 *   - 세션 교체(newSession/switchSession) 후에는 반드시 재구독해야 한다
 */
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface RuntimeOptions {
	/** 에이전트 작업 디렉터리 (세션 이름·툴 경로 해석 기준). */
	cwd: string;
	/** 확장·스킬 탐색 경로. 사용자 홈이 아닌 앱 전용 경로를 준다. */
	agentDir: string;
	/** 세션 파일 저장 위치. 컨테이너에서는 볼륨에 둔다 (대화 이력 보존). */
	sessionsDir: string;
	/** "provider/model:thinking" 형식. 미지정 시 SDK 기본 해석. */
	model?: string;
	/**
	 * pi 자격증명 파일 경로 (auth.json). 미지정 시 pi 기본 경로.
	 * 컨테이너에서 호스트의 OAuth 로그인을 재사용하려면 이 파일을 마운트하고 경로를 지정한다
	 * (env 키를 쓰는 경우에는 필요 없다).
	 */
	authPath?: string;
	/**
	 * 사용자가 설정 화면에서 넣은 LLM API 키 (providerId → key).
	 * auth.json·env 보다 우선하며 **메모리에만** 올린다 — pi 의 setRuntimeApiKey 는
	 * 파일에 쓰지 않으므로 공유 auth.json 에 남의 키가 섞이지 않는다.
	 */
	apiKeys?: Record<string, string>;
	/**
	 * 비활성화할 툴 이름 (거부목록).
	 *
	 * 허용목록(`tools`)을 쓰면 **확장이 등록한 툴까지 전부 막힌다** — pi-web-access 같은
	 * 패키지를 붙여도 모델에 노출되지 않는다. 그래서 코딩 툴만 명시적으로 빼고
	 * 나머지(우리 customTools + 확장 툴)는 허용한다.
	 */
	excludeTools: string[];
	customTools: ToolDefinition[];
	systemPrompt: string;
}

export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	modified: string;
}

export interface AlphaFolioRuntime {
	/** 현재 세션에 구독한다. 세션이 교체돼도 구독이 유지된다. */
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(sessionPath: string): Promise<void>;
	listSessions(): Promise<SessionSummary[]>;
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly messages: unknown[];
	readonly modelLabel: string;
	/** 현재 모델에 노출된 툴 이름 — 확장 로딩 확인·진단용. */
	readonly toolNames: string[];
	/** 사용자 LLM 키 교체/제거 (null = 제거 → auth.json·env 로 되돌아간다). 재시작 불필요. */
	setApiKey(providerId: string, key: string | null): Promise<void>;
	dispose(): Promise<void>;
}

export async function createAlphaFolioRuntime(opts: RuntimeOptions): Promise<AlphaFolioRuntime> {
	// modelsPath 를 명시하지 않으면 ModelRuntime 이 pi 기본 경로를 보므로
	// agentDir 의 models.json(OpenRouter 라우팅 가드)이 무시된다.
	const modelRuntime = await ModelRuntime.create({
		modelsPath: join(opts.agentDir, "models.json"),
		...(opts.authPath ? { authPath: opts.authPath } : {}),
	});
	// 모델 해석 전에 넣어야 해당 프로바이더가 "인증됨"으로 잡힌다
	for (const [providerId, key] of Object.entries(opts.apiKeys ?? {})) {
		await modelRuntime.setRuntimeApiKey(providerId, key);
	}

	const resolved = opts.model ? resolveCliModel({ cliModel: opts.model, modelRuntime }) : undefined;
	if (resolved?.error) throw new Error(`모델 해석 실패 (${opts.model}): ${resolved.error}`);
	if (resolved?.warning) console.warn(`[agent] ${resolved.warning}`);

	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: opts.agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				systemPrompt: opts.systemPrompt,
				// 스킬을 쓰지 않는다 — 절차는 툴로 만든다 (PLAN.md §21).
				// pi 스킬은 read 툴로 SKILL.md 를 읽는 구조인데 read 는 파일시스템 전체를 열기 때문에
				// 빼두었다. 명시적으로 꺼서 확장 패키지가 싣는 스킬도 조용히 들어오지 않게 한다.
				noSkills: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: resolved?.model,
				thinkingLevel: "off",
				excludeTools: opts.excludeTools,
				customTools: opts.customTools,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(factory, {
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		sessionManager: SessionManager.create(opts.cwd, opts.sessionsDir),
	});

	for (const d of runtime.diagnostics) {
		console.log(`[agent:${d.type}] ${d.message}`);
	}

	// 세션이 교체돼도 구독이 유지되도록 리스너는 우리가 소유한다.
	const listeners = new Set<(event: unknown) => void>();
	const fanout = (event: unknown): void => {
		for (const l of listeners) l(event);
	};
	let unsubscribe = runtime.session.subscribe(fanout);
	const rebind = (): void => {
		unsubscribe();
		unsubscribe = runtime.session.subscribe(fanout);
	};

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: (text) => runtime.session.prompt(text),
		steer: (text) => runtime.session.steer(text),
		followUp: (text) => runtime.session.followUp(text),
		abort: () => runtime.session.abort(),
		async newSession() {
			await runtime.newSession();
			rebind();
		},
		async switchSession(sessionPath) {
			await runtime.switchSession(sessionPath);
			rebind();
		},
		async listSessions() {
			const sessions = await SessionManager.list(opts.cwd, opts.sessionsDir);
			return sessions.map((s) => ({
				path: s.path,
				id: s.id,
				name: s.name,
				modified: s.modified.toISOString(),
			}));
		},
		get sessionId() {
			return runtime.session.sessionId;
		},
		get isStreaming() {
			return runtime.session.isStreaming;
		},
		get messages() {
			return runtime.session.messages;
		},
		async setApiKey(providerId, key) {
			if (key) await modelRuntime.setRuntimeApiKey(providerId, key);
			else await modelRuntime.removeRuntimeApiKey(providerId);
		},
		get modelLabel() {
			const m = runtime.session.model;
			return m ? `${m.provider}/${m.id}` : "(미설정)";
		},
		get toolNames() {
			const tools = (runtime.session.agent as { state?: { tools?: Array<{ name?: string }> } } | undefined)?.state
				?.tools;
			return Array.isArray(tools) ? tools.map((t) => String(t.name ?? "")).filter(Boolean) : [];
		},
		async dispose() {
			unsubscribe();
			listeners.clear();
			await runtime.dispose();
		},
	};
}
