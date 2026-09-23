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
 *     → 우리는 교체하지 않는다. 대화마다 런타임을 따로 띄운다 (AlphaFolioConversation)
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
	/** 첫 사용자 메시지 — 사이드바 제목으로 쓴다 */
	firstMessage: string;
	messageCount: number;
	modified: string;
}

/**
 * 대화 하나 — pi AgentSessionRuntime 하나에 대응한다.
 *
 * 대화마다 따로 띄우는 이유 (PLAN §24): 사용자당 대화를 하나만 열어두면 탭·기기·테스트가
 * 같은 대화를 끌어다 쓴다. 대화별로 두면 한 대화가 응답하는 동안 다른 대화를 읽을 수 있고,
 * 클라이언트가 끊겨도(앱 종료) 그 대화는 서버에서 끝까지 돈다.
 */
/** 첨부 이미지 — base64 (data: 접두사 없음). 검증은 서버(images.ts)가 먼저 한다. */
export interface ImageInput {
	mimeType: string;
	data: string;
}

export interface AlphaFolioConversation {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string, images?: ImageInput[]): Promise<void>;
	steer(text: string, images?: ImageInput[]): Promise<void>;
	followUp(text: string, images?: ImageInput[]): Promise<void>;
	abort(): Promise<void>;
	/** 지금 모델이 이미지를 읽을 수 있는가 — 못 읽는데 보내면 SDK 가 이미지를 조용히 뺄 수 있어 미리 막는다 */
	readonly acceptsImages: boolean;
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly messages: unknown[];
	readonly modelLabel: string;
	/** 현재 모델에 노출된 툴 이름 — 확장 로딩 확인·진단용. */
	readonly toolNames: string[];
	dispose(): Promise<void>;
}

/** 사용자 한 명의 에이전트 — 모델·자격증명을 공유하고, 대화를 여러 개 연다. */
export interface AlphaFolioAgent {
	/** 새 대화. 첫 메시지 전까지는 파일로 남지 않는다 (pi 세션은 지연 저장). */
	create(): Promise<AlphaFolioConversation>;
	/** 저장된 대화 열기 — sessionPath 는 listSessions 가 준 경로만 넘긴다 (id 로 경로를 조립하지 않는다). */
	open(sessionPath: string): Promise<AlphaFolioConversation>;
	listSessions(): Promise<SessionSummary[]>;
	/** 사용자 LLM 키 교체/제거 (null = 제거 → auth.json·env 로 되돌아간다). 열린 대화 전부에 바로 적용된다. */
	setApiKey(providerId: string, key: string | null): Promise<void>;
}

export async function createAlphaFolioAgent(opts: RuntimeOptions): Promise<AlphaFolioAgent> {
	// modelsPath 를 명시하지 않으면 ModelRuntime 이 pi 기본 경로를 보므로
	// agentDir 의 models.json(OpenRouter 라우팅 가드)이 무시된다.
	// 대화들이 이 하나를 공유한다 — 키를 바꾸면 열린 대화 전부에 적용된다.
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

	let diagnosticsLogged = false;

	async function start(sessionManager: SessionManager): Promise<AlphaFolioConversation> {
		const runtime = await createAgentSessionRuntime(factory, {
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			sessionManager,
		});
		// 확장 진단은 대화마다 같으므로 처음 한 번만 찍는다
		if (!diagnosticsLogged) {
			diagnosticsLogged = true;
			for (const d of runtime.diagnostics) console.log(`[agent:${d.type}] ${d.message}`);
		}

		// 대화 안에서 세션을 바꾸지 않으므로 재구독(rebind)이 필요 없다
		const session = runtime.session;
		const listeners = new Set<(event: unknown) => void>();
		const unsubscribe = session.subscribe((event: unknown) => {
			for (const l of listeners) l(event);
		});

		return {
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: (text, images) => session.prompt(text, images?.length ? { images: toContent(images) } : undefined),
			steer: (text, images) => session.steer(text, images?.length ? toContent(images) : undefined),
			followUp: (text, images) => session.followUp(text, images?.length ? toContent(images) : undefined),
			abort: () => session.abort(),
			get acceptsImages() {
				const input = (session.model as { input?: string[] } | undefined)?.input;
				return Array.isArray(input) && input.includes("image");
			},
			get sessionId() {
				return session.sessionId;
			},
			get isStreaming() {
				return session.isStreaming;
			},
			get messages() {
				return session.messages;
			},
			get modelLabel() {
				const m = session.model;
				return m ? `${m.provider}/${m.id}` : "(미설정)";
			},
			get toolNames() {
				const tools = (session.agent as { state?: { tools?: Array<{ name?: string }> } } | undefined)?.state?.tools;
				return Array.isArray(tools) ? tools.map((t) => String(t.name ?? "")).filter(Boolean) : [];
			},
			async dispose() {
				unsubscribe();
				listeners.clear();
				await runtime.dispose();
			},
		};
	}

	return {
		create: () => start(SessionManager.create(opts.cwd, opts.sessionsDir)),
		open: (sessionPath) => start(SessionManager.open(sessionPath, opts.sessionsDir)),
		async listSessions() {
			const sessions = await SessionManager.list(opts.cwd, opts.sessionsDir);
			return sessions
				.map((s) => ({
					path: s.path,
					id: s.id,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.toISOString(),
				}))
				.sort((a, b) => b.modified.localeCompare(a.modified));
		},
		async setApiKey(providerId, key) {
			if (key) await modelRuntime.setRuntimeApiKey(providerId, key);
			else await modelRuntime.removeRuntimeApiKey(providerId);
		},
	};
}

function toContent(images: ImageInput[]): Array<{ type: "image"; mimeType: string; data: string }> {
	return images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }));
}
