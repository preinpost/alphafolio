/**
 * AlphaFolio 서버 부트스트랩.
 *
 *   node:http + ws  ─┬─ /api/*      REST (인증 필요, /api/health·/api/auth/login 제외)
 *                    ├─ /ws         에이전트 이벤트 스트림
 *                    └─ 그 외        apps/web/dist 정적 서빙 (SPA fallback)
 *
 * 컨테이너는 리버스 프록시 뒤에 둔다 (TLS·도메인은 프록시 담당).
 */
import { copyFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { mkdir } from "node:fs/promises";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { d1ConfigFromEnv, d1Ping, ensureMigrated, LedgerAccessError, type D1Config } from "@alphafolio/ledger";
import {
	fetchPortfolio,
	fetchQuote,
	KisCredentialsMissingError,
	NoBrokerConfiguredError,
	parseAccount,
	TossCredentialsMissingError,
	cancelOrder,
	defaultAccountSeq,
	listOrders,
	NaverCredentialsMissingError,
	QuoteNotFoundError,
	type BrokerAccess,
	type KisContext,
	type NaverCredentials,
	type TossContext,
	describeAction,
	executeOrderAction,
	type OrderAction,
	type DataCreds,
} from "@alphafolio/broker";
import { createBrokerTokenStore } from "./broker-tokens.ts";
import { createOrderToken, failureMessage, OrderTokenGuard } from "./order-tokens.ts";
import { kstParts, SnapshotScheduler, SnapshotStore } from "./snapshots.ts";
import { bearerFrom, createToken, verifyToken } from "./auth.ts";
import { APP_VERSION, loadConfig, loadDotEnv } from "./config.ts";
import { corsFor } from "./cors.ts";
import { handleLedger, handleLedgerAdmin, HttpError, readJson, setLedgerConfigProvider } from "./ledger-api.ts";
import { clientIp, LoginRateLimiter } from "./ratelimit.ts";
import { RuntimeManager } from "./runtimes.ts";
import { SECRET_CATALOG, SecretStore, specFor, LLM_SECRET_PROVIDERS } from "./secrets.ts";
import { AccountError, AccountStore } from "./accounts.ts";
import { handleAccounts } from "./accounts-api.ts";
import { attachWebSocket, type WsHub } from "./ws.ts";
import { TriggerError, TriggerStore } from "./triggers.ts";
import { Watcher, type WatchEvent } from "./watcher.ts";
import { TelegramBots } from "./notify/telegram-bot.ts";
import { handleWatch, watchConfirmSecret, WatchOps, type WatchTokenPayload } from "./watch-api.ts";
import { createSafeFetch } from "@alphafolio/mcp";
import { McpStore } from "./mcp-store.ts";
import { CALLBACK_PATH, McpAuthManager } from "./mcp-auth.ts";
import { Notifier, TELEGRAM_CHAT, TELEGRAM_TOKEN } from "./notify/index.ts";
import { botIdOf, findPrivateChat, getBotName, isBotToken, sendMessage, TelegramError } from "./notify/telegram.ts";
import { handleMcp, handleMcpCallback, mcpConfirmSecret, mcpHandles, prepareMcpWrite, type McpApiDeps, type McpWritePayload } from "./mcp-api.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

/**
 * 바깥 연결의 주소당 대기 시간 — Node 기본 250ms 는 먼 서버에 짧다.
 * Node 는 IPv6·IPv4 주소를 번갈아 시도(happy eyeballs)하며 주소마다 이만큼만 기다린다. 한국 → 텔레그램(유럽) TCP 연결이
 * 287ms 라 매번 직전에 포기하고 "fetch failed" 가 났다 (IPv6 는 경로 없음, 실측 2026-09-26 — curl 은 됐다).
 * 늘려도 가까운 서버는 영향이 없다 (연결되는 즉시 끝난다).
 */
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

async function main(): Promise<void> {
	const envFile = loadDotEnv();
	const cfg = loadConfig();

	// 확장은 자기 설정을 PI_CODING_AGENT_DIR 기준으로 찾는다 (pi-web-access 의 web-search.json 등).
	// ResourceLoader 에 넘기는 agentDir 과 별개 경로라, 여기서 맞춰주지 않으면
	// 확장이 사용자 홈(~/.pi)을 보거나 설정을 못 찾는다.
	process.env.PI_CODING_AGENT_DIR ??= cfg.agent.agentDir;

	// 에이전트 디렉터리 준비 — 세션은 컨테이너 볼륨에 보존한다.
	for (const dir of [cfg.agent.cwd, cfg.agent.agentDir, cfg.agent.sessionsDir]) {
		await mkdir(dir, { recursive: true });
	}

	// pi 자격증명 스토어는 auth.json 옆에 락 디렉터리를 만든다 → 읽기 전용 마운트로는 쓸 수 없다
	// (EACCES: mkdir '/secrets/auth.json.lock'). 받은 파일을 쓰기 가능한 데이터 디렉터리로
	// 복사해 사본을 쓴다. env 키를 쓰는 경우에는 이 경로를 타지 않는다.
	let authPath = cfg.agent.authPath;
	if (authPath && existsSync(authPath)) {
		const copy = join(cfg.dataDir, "auth.json");
		try {
			copyFileSync(authPath, copy);
			authPath = copy;
		} catch (err) {
			console.warn("[auth] auth.json 복사 실패 — 원본 경로를 그대로 사용합니다:", err);
		}
	}

	/**
	 * D1 설정은 **서버 env 전용**이다.
	 * 앱에서 입력받는 구조는 "DB가 있어야 앱이 도는데 그 DB 설정을 앱에서 넣는" 닭-달걀이 된다.
	 * 이 하나의 D1에 가계부와 사용자별 credential 이 함께 들어간다.
	 */
	const ledgerConfig = (): D1Config => {
		try {
			return d1ConfigFromEnv();
		} catch (err) {
			throw new HttpError(503, err instanceof Error ? err.message : String(err));
		}
	};

	// 사용자별 시크릿 — 같은 D1의 user_secrets 테이블에 암호화 보관
	const secrets = new SecretStore(ledgerConfig, cfg.auth.secret, cfg.auth.ephemeralSecret);

	// 사용자별 원격 MCP 서버 (PLAN §38) — 사용자 입력 URL 로 서버가 요청하므로 SSRF 방어 fetch 만 쓴다
	const mcpPolicy = { allowPrivate: cfg.mcpAllowPrivate };
	const mcpFetch = createSafeFetch(mcpPolicy);
	const mcpStore = new McpStore(ledgerConfig, cfg.auth.secret, mcpPolicy);
	const mcpDeps: McpApiDeps = {
		store: mcpStore,
		auth: new McpAuthManager({ store: mcpStore, publicUrl: cfg.publicUrl, fetch: mcpFetch, policy: mcpPolicy }),
		fetch: mcpFetch,
		publicUrl: cfg.publicUrl,
		// 쓰기 확인 카드 — 주문과 같은 구조, 서명 키만 분리 (PLAN §39)
		confirm: { secret: mcpConfirmSecret(cfg.auth.secret), guard: new OrderTokenGuard<McpWritePayload>() },
	};

	setLedgerConfigProvider(ledgerConfig);

	// 알림 (PLAN §40) — 트리거·체결 결과를 사용자 채널로. 지금은 텔레그램
	const notifier = new Notifier({ secrets, publicUrl: cfg.publicUrl });

	// 감시 트리거 (PLAN §40) — 알림은 떠 있는 화면(WebSocket) + 사용자 채널(텔레그램)
	const triggerStore = new TriggerStore(ledgerConfig);
	let wsHub: WsHub | null = null;
	const deliverWatch = async (ev: WatchEvent, opts: { channels?: boolean } = {}): Promise<unknown> => {
		wsHub?.toUser(ev.user, {
			type: "watch_event",
			triggerId: ev.triggerId,
			name: ev.name,
			kind: ev.kind,
			title: ev.message.title,
			lines: ev.message.lines ?? [],
			path: ev.message.path ?? null,
			at: ev.at,
		});
		return opts.channels === false ? [] : notifier.notify(ev.user, ev.message);
	};
	const watchOps: WatchOps = new WatchOps({
		store: triggerStore,
		confirm: { secret: watchConfirmSecret(cfg.auth.secret), guard: new OrderTokenGuard<WatchTokenPayload>() },
		deliver: deliverWatch,
		channels: (user) => notifier.channels(user),
		commandStatus: (user) => telegramBots.status(user),
	});
	// 텔레그램에서 감시 보기·멈추기·지우기 — 사용자 봇마다 롱 폴링 (PLAN §40)
	const telegramBots: TelegramBots = new TelegramBots({
		ops: watchOps,
		creds: (user) => {
			const token = notifier.userSecret(TELEGRAM_TOKEN, user);
			const chatId = notifier.userSecret(TELEGRAM_CHAT, user);
			return token && chatId ? { token, chatId } : null;
		},
		users: () => accounts.names(),
		publicUrl: cfg.publicUrl,
	});
	/** 에이전트 툴 — 저장소 오류는 모델이 읽을 문장으로 */
	const agentOp = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (err) {
			throw new Error(err instanceof TriggerError ? err.message : String(err));
		}
	};

	/** D1 설정이 갖춰져 있는지. */
	const ledgerReady = (): boolean => {
		try {
			ledgerConfig();
			return true;
		} catch {
			return false;
		}
	};

	// D1이 설정돼 있으면 스키마를 맞추고 시크릿을 메모리에 적재한다.
	// (브로커 툴이 동기로 값을 읽어야 하므로 캐시가 필요하다)
	if (ledgerReady()) {
		try {
			const m = await ensureMigrated(ledgerConfig());
			if (m.applied.length > 0) console.log(`[ledger] 마이그레이션 적용: ${m.applied.join(", ")}`);
			await secrets.load();
			await mcpStore.load();
			await triggerStore.load();
		} catch (err) {
			console.warn("[secrets] 초기 적재 실패 — 설정 화면에서 D1 연결을 확인하세요:", err);
		}
	} else {
		console.warn("[ledger] AF_D1_* 미설정 — 가계부와 사용자별 키 저장이 비활성 상태입니다");
	}

	// KIS 토큰 캐시 — 발급이 SMS 를 유발하므로 D1 에 보존한다
	const brokerTokens = createBrokerTokenStore(ledgerConfig, cfg.auth.secret);

	/**
	 * 사용자별 KIS 컨텍스트.
	 * 자격증명은 **사용자별 시크릿 저장소**에서 호출 시점에 읽는다 —
	 * process.env 로 전역 주입하면 여러 사람이 한 컨테이너를 쓸 수 없다.
	 * 시세 조회는 계좌번호 없이도 되므로 계좌는 선택이다.
	 */
	const kisContext = (user: string): KisContext => {
		const appKey = secrets.get("KIS_APP_KEY", user);
		const appSecret = secrets.get("KIS_APP_SECRET", user);
		const missing = [!appKey && "KIS_APP_KEY", !appSecret && "KIS_APP_SECRET"].filter(Boolean) as string[];
		if (missing.length > 0) throw new KisCredentialsMissingError(missing);

		const account = parseAccount(secrets.get("KIS_ACCOUNT_NO", user));
		return {
			creds: {
				appKey: appKey as string,
				appSecret: appSecret as string,
				cano: account.cano,
				prdtCd: account.prdtCd,
				env: cfg.kisEnv,
			},
			store: brokerTokens,
			owner: user,
		};
	};

	/** 토스증권 컨텍스트 — KIS 와 마찬가지로 자격증명은 사용자별이다. */
	const tossContext = (user: string): TossContext => {
		const clientId = secrets.get("TOSS_CLIENT_ID", user);
		const clientSecret = secrets.get("TOSS_CLIENT_SECRET", user);
		const missing = [!clientId && "TOSS_CLIENT_ID", !clientSecret && "TOSS_CLIENT_SECRET"].filter(
			Boolean,
		) as string[];
		if (missing.length > 0) throw new TossCredentialsMissingError(missing);

		return {
			creds: { clientId: clientId as string, clientSecret: clientSecret as string },
			store: brokerTokens,
			owner: user,
		};
	};

	/**
	 * 사용자가 쓰는 증권사 묶음. 두 곳을 다 넣어두고, 설정되지 않은 쪽은
	 * 컨텍스트 생성에서 throw 되어 자동으로 제외된다 (안 쓰는 브로커를 매번 경고하지 않는다).
	 */
	const brokerAccess = (user: string): BrokerAccess => ({
		kis: () => kisContext(user),
		toss: () => tossContext(user),
		// Binance 거래 — 키가 없으면 throw (= 미연결). 시세·조회는 data_call 이 키 없이도 한다
		binance: () => {
			const b = dataCreds(user).binance;
			if (!b) throw new Error("Binance 키가 없습니다 — 설정 → 코인 (Binance)");
			return b;
		},
	});

	/** 네이버 뉴스 자격증명 — 다른 키와 마찬가지로 사용자별이다. */
	/** 해외·코인 데이터 제공자 키 — 호출 시점에 읽는다 (설정에서 넣으면 재시작 없이) */
	const dataCreds = (user: string): DataCreds => {
		const get = (n: string): string | undefined => secrets.get(n, user) || undefined;
		const bKey = get("BINANCE_API_KEY");
		const bSecret = get("BINANCE_API_SECRET");
		return {
			finnhub: get("FINNHUB_API_KEY"),
			twelve: get("TWELVE_API_KEY"),
			coingecko: get("COINGECKO_API_KEY"),
			...(bKey && bSecret ? { binance: { key: bKey, secret: bSecret, testnet: get("BINANCE_ENV")?.toLowerCase() === "testnet" } } : {}),
		};
	};

	const naverCreds = (user: string): NaverCredentials => {
		const clientId = secrets.get("NCP_APIGW_API_KEY_ID", user);
		const clientSecret = secrets.get("NCP_APIGW_API_KEY", user);
		if (!clientId || !clientSecret) throw new NaverCredentialsMissingError();
		return { clientId, clientSecret, mode: "hub" };
	};

	/**
	 * 주문 확인 토큰.
	 *
	 * 에이전트는 `order_prepare` 로 토큰을 받을 수만 있고, 실행은 사람이
	 * `/api/orders/execute` 를 호출(화면 버튼)해야 한다. 에이전트는 사용자의 인증
	 * 토큰을 모르므로 이 엔드포인트를 스스로 부를 수 없다.
	 */
	const orderGuard = new OrderTokenGuard();
	const prepareOrder = (user: string) => (action: OrderAction) => {
		const { token, payload } = createOrderToken({ u: user, action }, cfg.auth.secret);
		console.log(`[order] 준비 user=${user} ${describeAction(action)} nonce=${payload.nonce}`);
		return { token, expiresAt: payload.exp };
	};

	/**
	 * 사용자가 **직접 저장한** LLM 키만 런타임에 넘긴다. env 값까지 넘기면
	 * auth.json 의 OAuth 로그인을 env 키가 덮어버릴 수 있다 (pi 의 원래 우선순위를 존중).
	 */
	const llmKeys = (user: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [name, providerId] of Object.entries(LLM_SECRET_PROVIDERS)) {
			if (secrets.sourceOf(name, user) !== "user") continue;
			const key = secrets.get(name, user);
			if (key) out[providerId] = key;
		}
		return out;
	};

	// 사용자별 런타임 — 하나를 공유하면 두 사람의 대화와 세션이 섞인다.
	const runtimes = new RuntimeManager({
		thinking: cfg.agent.thinking,
		dataDir: cfg.dataDir,
		agentDir: cfg.agent.agentDir,
		model: cfg.agent.model,
		authPath,
		ledgerConfig,
		brokerAccess,
		naverCreds,
		dataCreds,
		prepareOrder,
		llmKeys,
		mcpServers: (user) => mcpHandles(mcpDeps, user),
		mcpFetch,
		prepareMcpWrite: (user) => prepareMcpWrite(mcpDeps, user),
		watch: (user) => ({
			prepareWatch: (spec) => watchOps.prepare(user, spec),
			listWatches: async () => watchOps.list(user),
			pauseWatch: (id) => agentOp(() => watchOps.pause(user, id, "agent")),
			channels: () => notifier.channels(user),
		}),
		idleMinutes: cfg.idleMinutes,
	});

	// 계정 — env 계정(슈퍼관리자) + 초대 코드로 가입한 D1 계정 (PLAN §25)
	const accounts = new AccountStore(ledgerConfig, { name: cfg.auth.admin, password: cfg.auth.adminPassword }, cfg.auth.secret);
	if (ledgerReady()) {
		try {
			await accounts.load();
		} catch (err) {
			console.warn("[accounts] D1 계정을 읽지 못했습니다 — env 계정만 로그인됩니다:", err instanceof Error ? err.message : err);
		}
	}
	const issueToken = (name: string): string => createToken(name, cfg.auth.secret, accounts.tokenVersion(name));

	// 일별 포트폴리오 스냅샷 — 과거 평가금액은 브로커가 주지 않으므로 직접 쌓는다
	const snapshots = new SnapshotStore(ledgerConfig);
	const snapshotScheduler = new SnapshotScheduler({
		store: snapshots,
		users: () => accounts.names(),
		brokerAccess,
	});

	const watcher = new Watcher({ store: triggerStore, deliver: (ev) => deliverWatch(ev), isActive: (u) => accounts.has(u) });

	const loginLimiter = new LoginRateLimiter(cfg.login);
	// 초대 코드 추측 방지 — 로그인과 따로 센다 (가입 실패가 로그인을 막지 않게)
	const signupLimiter = new LoginRateLimiter(cfg.login);

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((err: unknown) => {
			// 자격증명 미설정은 서버 오류가 아니라 "설정이 필요함"이다
			const needsSetup =
				err instanceof KisCredentialsMissingError ||
				err instanceof TossCredentialsMissingError ||
				err instanceof NaverCredentialsMissingError ||
				err instanceof NoBrokerConfiguredError;
			// 없는 종목은 잘못된 입력이다 — 500 으로 내면 서버 장애처럼 보인다
			const notFound = err instanceof QuoteNotFoundError;
			const status =
				err instanceof HttpError || err instanceof LedgerAccessError || err instanceof AccountError
					? err.status
					: needsSetup
						? 503
						: notFound
							? 404
							: 500;
			const message = err instanceof Error ? err.message : String(err);
			if (status === 500) console.error("[server]", err);
			if (!res.headersSent) json(res, status, { error: message });
		});
	});

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname;

		// iOS 앱은 capacitor://localhost 에서 부른다 — API 에만 CORS 를 붙인다 (정적 파일은 앱 번들에 있다)
		if (path.startsWith("/api/")) {
			const cors = corsFor(req.headers.origin, req.method, cfg.corsOrigins);
			for (const [k, v] of Object.entries(cors.headers)) res.setHeader(k, v);
			if (cors.preflight) {
				res.writeHead(204);
				res.end();
				return;
			}
		}

		// ── 공개 엔드포인트 ────────────────────────────────────────
		if (path === "/api/health") {
			json(res, 200, { ok: true, version: APP_VERSION, ledger: ledgerReady(), model: cfg.agent.model ?? "(기본)" });
			return;
		}

		if (path === "/api/auth/login" && req.method === "POST") {
			const body = await readJson(req);
			const user = String(body.user ?? "");

			// IP와 계정 두 축으로 센다 — 한 곳에서 여러 계정을 훑는 경우와
			// 여러 곳에서 한 계정을 노리는 경우를 모두 막는다.
			const ip = clientIp(req.headers, req.socket.remoteAddress, cfg.login.trustProxy);
			const keys = [`ip:${ip}`, `user:${user}`];

			const verdict = loginLimiter.check(keys);
			if (!verdict.allowed) {
				res.setHeader("retry-after", String(verdict.retryAfterSec));
				json(res, 429, {
					error: `로그인 시도가 너무 많습니다. ${verdict.retryAfterSec}초 뒤에 다시 시도하세요.`,
					retryAfterSec: verdict.retryAfterSec,
				});
				return;
			}

			const authedName = accounts.authenticate(user, String(body.password ?? ""));
			if (!authedName) {
				loginLimiter.recordFailure(keys);
				json(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다" });
				return;
			}

			loginLimiter.recordSuccess(keys);
			json(res, 200, { token: issueToken(authedName), user: authedName });
			return;
		}

		// 초대 코드로 가입 → 바로 로그인 (PLAN §25)
		if (path === "/api/auth/signup" && req.method === "POST") {
			if (!accounts.ready) {
				json(res, 503, { error: "지금은 가입할 수 없습니다 (서버 DB 미설정)" });
				return;
			}
			const ip = clientIp(req.headers, req.socket.remoteAddress, cfg.login.trustProxy);
			const keys = [`ip:${ip}`];
			const verdict = signupLimiter.check(keys);
			if (!verdict.allowed) {
				res.setHeader("retry-after", String(verdict.retryAfterSec));
				json(res, 429, { error: `시도가 너무 많습니다. ${verdict.retryAfterSec}초 뒤에 다시 시도하세요.` });
				return;
			}
			const body = await readJson(req);
			try {
				const name = await accounts.signup({
					code: String(body.code ?? ""),
					name: String(body.user ?? ""),
					password: String(body.password ?? ""),
				});
				signupLimiter.recordSuccess(keys);
				json(res, 200, { token: issueToken(name), user: name });
			} catch (err) {
				// 코드가 틀린 경우만 센다 — ID 중복·비밀번호 길이 같은 입력 실수로 잠기지 않게
				if (err instanceof AccountError && err.status === 403) signupLimiter.recordFailure(keys);
				throw err;
			}
			return;
		}

		// MCP OAuth 콜백 — 인가 서버가 브라우저를 돌려보낸다 (Bearer 없음). 1회용 state 가 사용자를 가리킨다
		if (path === CALLBACK_PATH && req.method === "GET") {
			await handleMcpCallback(url, res, mcpDeps);
			return;
		}

		// ── 인증 필요 ─────────────────────────────────────────────
		if (path.startsWith("/api/")) {
			const verified = verifyToken(bearerFrom(req.headers.authorization), cfg.auth.secret);
			// 서명이 맞아도 계정이 비활성화됐거나 비밀번호가 바뀌었을 수 있다 (토큰 버전)
			const user = verified && accounts.accepts(verified.user, verified.version) ? verified.user : null;
			if (!user) {
				json(res, 401, { error: "인증이 필요합니다" });
				return;
			}

			// 가계부 관리·초대 — /api/ledger 보다 먼저 (접두사가 겹친다)
			if (path.startsWith("/api/ledgers") || path.startsWith("/api/invites")) {
				const result = await handleLedgerAdmin(req, path, user, (name) => accounts.has(name));
				if (result === undefined) throw new HttpError(404, `없는 경로: ${path}`);
				json(res, 200, result);
				return;
			}

			if (path === "/api/ledger" || path.startsWith("/api/ledger/")) {
				const result = await handleLedger(req, url, path.slice("/api/ledger".length), user);
				if (result === undefined) throw new HttpError(404, `없는 경로: ${path}`);
				json(res, 200, result);
				return;
			}

			// ── 시크릿 ────────────────────────────────────────
			// 원문은 어떤 경우에도 내보내지 않는다 (설정 여부 + 마스킹만).
			if (path === "/api/secrets" && req.method === "GET") {
				json(res, 200, {
					items: secrets.status(user),
					ephemeralMaster: secrets.ephemeralMaster,
					storageReady: secrets.ready,
					undecryptable: secrets.failedCount,
				});
				return;
			}

			if (path === "/api/secrets" && req.method === "PUT") {
				const body = await readJson(req);
				const name = String(body.name ?? "");
				const value = String(body.value ?? "");
				if (!specFor(name)) throw new HttpError(400, `저장할 수 없는 키입니다: ${name}`);
				try {
					await secrets.set(name, value, user);
				} catch (err) {
					throw new HttpError(400, err instanceof Error ? err.message : String(err));
				}
				// LLM 키는 떠 있는 런타임에 바로 반영 (재시작·재로그인 불필요)
				const llmProvider = LLM_SECRET_PROVIDERS[name];
				if (llmProvider) await runtimes.applyLlmKey(user, llmProvider, secrets.get(name, user) ?? null);
				if (name.startsWith("TELEGRAM_")) telegramBots.refresh(user);
				json(res, 200, { items: secrets.status(user) });
				return;
			}

			if (path.startsWith("/api/secrets/") && req.method === "DELETE") {
				const name = decodeURIComponent(path.slice("/api/secrets/".length));
				if (!specFor(name)) throw new HttpError(400, `알 수 없는 키입니다: ${name}`);
				await secrets.remove(name, user);
				// 제거하면 서버 기본(auth.json·env)으로 되돌아간다
				const llmProvider = LLM_SECRET_PROVIDERS[name];
				if (llmProvider) await runtimes.applyLlmKey(user, llmProvider, null);
				if (name.startsWith("TELEGRAM_")) telegramBots.refresh(user);
				json(res, 200, { items: secrets.status(user) });
				return;
			}

			// 연결 테스트 — 저장된 값으로 실제 호출을 한 번 해본다
			if (path === "/api/secrets/test/d1" && req.method === "POST") {
				try {
					const ms = await d1Ping(ledgerConfig());
					json(res, 200, { ok: true, message: `연결 성공 (${ms}ms)` });
				} catch (err) {
					json(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
				}
				return;
			}

			// ── 감시 트리거 (PLAN §40) ─────────────────────────
			if (path === "/api/watch" || path.startsWith("/api/watch/")) {
				const result = await handleWatch(req, path, user, watchOps);
				if (result === undefined) throw new HttpError(404, `없는 경로: ${path}`);
				json(res, 200, result);
				return;
			}

			// ── MCP 서버 (설정 화면 전용 — 에이전트 툴 없음) ─────────
			if (path.startsWith("/api/mcp/")) {
				const result = await handleMcp(req, path, user, mcpDeps);
				if (result === undefined) throw new HttpError(404, `없는 경로: ${path}`);
				json(res, 200, result);
				return;
			}

			// 텔레그램 연결 테스트 — 채팅 id 가 없으면 봇에게 온 최근 개인 메시지에서 찾아 저장하고, 테스트 메시지를 보낸다
			if (path === "/api/notify/telegram/test" && req.method === "POST") {
				const token = notifier.userSecret(TELEGRAM_TOKEN, user);
				if (!token) {
					json(res, 200, { ok: false, message: "봇 토큰을 먼저 저장하세요 (@BotFather → /newbot)" });
					return;
				}
				if (!isBotToken(token)) {
					json(res, 200, { ok: false, message: "봇 토큰 모양이 아닙니다 — 숫자:영문 형태의 토큰 전체를 붙여 넣으세요" });
					return;
				}
				// 명령 수신(getUpdates 롱 폴링)과 채팅 찾기가 겹치면 409 — 테스트 동안 멈췄다가 끝나면 다시
				telegramBots.refresh(user, { suspend: true });
				try {
					const bot = await getBotName(token);
					let chat = notifier.userSecret(TELEGRAM_CHAT, user);
					let found = "";
					// 봇 자신의 id 를 넣은 경우 (웹 텔레그램 주소창의 숫자가 봇 id 다) — 무시하고 다시 찾는다
					const wrongChat = chat === botIdOf(token);
					if (!chat || wrongChat) {
						const hit = await findPrivateChat(token);
						if (!hit) {
							const why = wrongChat ? "채팅 id 칸에 봇 자신의 id 가 들어 있습니다. " : "";
							json(res, 200, {
								ok: false,
								message:
									`${why}텔레그램에서 ${bot} 에게 아무 메시지나 보낸 뒤 다시 눌러 주세요. ` +
									"그래도 안 되면 이 봇을 다른 프로그램이 읽고 있는 것입니다 — 채팅 id 에 내 계정 id(@userinfobot 이 알려 준다)를 직접 넣으세요.",
							});
							return;
						}
						await secrets.set(TELEGRAM_CHAT, hit.id, user);
						chat = hit.id;
						found = ` → ${hit.name}`;
					}
					await sendMessage(token, chat, "✅ <b>AlphaFolio 알림이 연결됐습니다</b>\n감시·체결 결과를 여기로 보냅니다.");
					json(res, 200, { ok: true, message: `연결됨 · ${bot}${found}`, items: secrets.status(user) });
				} catch (err) {
					json(res, 200, { ok: false, message: err instanceof TelegramError ? err.message : String(err) });
				} finally {
					telegramBots.refresh(user);
				}
				return;
			}

			// ── 증권 ──────────────────────────────────────────
			// 에이전트를 거치지 않는 조회 경로 (가계부 REST 와 같은 구조).
			// 스냅샷 수동 촬영 — 시간 조건을 무시하고 지금 값으로 오늘자를 덮어쓴다 (확인·테스트용)
			if (path === "/api/portfolio/snapshot" && req.method === "POST") {
				json(res, 200, await snapshotScheduler.takeNow(user));
				return;
			}

			if (path === "/api/portfolio/history" && req.method === "GET") {
				const today = kstParts(new Date()).date;
				const from = url.searchParams.get("from") ?? `${today.slice(0, 7)}-01`;
				const to = url.searchParams.get("to") ?? today;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
					throw new HttpError(400, "from/to 는 YYYY-MM-DD 형식이어야 합니다");
				}
				json(res, 200, { items: await snapshots.range(user, from, to) });
				return;
			}

			if (path === "/api/portfolio" && req.method === "GET") {
				json(res, 200, await fetchPortfolio(brokerAccess(user)));
				return;
			}

			if (path === "/api/quote" && req.method === "GET") {
				const symbol = url.searchParams.get("symbol");
				if (!symbol) throw new HttpError(400, "symbol 이 필요합니다");
				json(res, 200, await fetchQuote(brokerAccess(user), symbol));
				return;
			}

			// ── 주문 ──────────────────────────────────────────
			// ⚠️ 실제 체결로 이어지는 유일한 경로. 에이전트는 여기에 도달할 수 없다
			//    (사용자 인증 토큰을 갖고 있지 않다).
			if (path === "/api/orders/execute" && req.method === "POST") {
				const body = await readJson(req);
				const verified = orderGuard.verify(String(body.token ?? ""), cfg.auth.secret, user);
				if (!verified.ok) throw new HttpError(400, failureMessage(verified.reason));

				const { action, nonce } = verified.payload;
				// 주문을 보내기 **전에** 소비한다 — 더블클릭·재전송이 두 번 나가지 않게.
				// 실패해도 재사용을 허용하지 않는 쪽이 안전하다 (재요청은 새 확인을 받는다).
				orderGuard.consume(nonce);
				console.log(`[order] 실행 user=${user} ${describeAction(action)} nonce=${nonce}`);

				// 동작 종류·증권사는 토큰 값만 본다 (execute.ts)
				const result = await executeOrderAction(action, nonce, brokerAccess(user));
				json(res, 200, { ok: true, ...result });
				return;
			}

			if (path === "/api/orders" && req.method === "GET") {
				const ctx = tossContext(user);
				const accountSeq = await defaultAccountSeq(ctx);
				const status = url.searchParams.get("status") === "CLOSED" ? "CLOSED" : "OPEN";
				json(res, 200, await listOrders(ctx, accountSeq, { status }));
				return;
			}

			if (path.startsWith("/api/orders/") && path.endsWith("/cancel") && req.method === "POST") {
				const orderId = decodeURIComponent(path.slice("/api/orders/".length, -"/cancel".length));
				if (!orderId) throw new HttpError(400, "orderId 가 필요합니다");
				const ctx = tossContext(user);
				const accountSeq = await defaultAccountSeq(ctx);
				console.log(`[order] 취소 user=${user} orderId=${orderId.slice(0, 12)}…`);
				await cancelOrder(ctx, accountSeq, orderId);
				json(res, 200, { ok: true });
				return;
			}

			if (path === "/api/me") {
				json(res, 200, {
					user,
					groups: [...new Set(SECRET_CATALOG.map((x) => x.group))],
					admin: accounts.isAdmin(user),
					/** env = 서버 설정 계정(비밀번호를 앱에서 못 바꾼다), db = 가입 계정 */
					source: accounts.sourceOf(user),
				});
				return;
			}

			if (path.startsWith("/api/me/") || path.startsWith("/api/admin/")) {
				const result = await handleAccounts(req, path, user, accounts, issueToken);
				if (result === undefined) throw new HttpError(404, `없는 경로: ${path}`);
				json(res, 200, result);
				return;
			}

			// 대화 목록 — 사이드바. 응답 중인 대화(앱을 꺼도 도는 것) 표시 포함
			if (path === "/api/sessions" && req.method === "GET") {
				json(res, 200, await runtimes.listConversations(user));
				return;
			}

			// 대화 삭제 — 앱 화면에서만 (에이전트 툴 없음). 응답 중이어도 멈추고 지운다
			const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
			if (sessionMatch && req.method === "DELETE") {
				const ok = await runtimes.deleteConversation(user, sessionMatch[1] ?? "");
				if (!ok) throw new HttpError(404, "없는 대화입니다");
				json(res, 200, { deleted: true });
				return;
			}

			if (path === "/api/state") {
				json(res, 200, { user, ...(await runtimes.describe(user)) });
				return;
			}

			throw new HttpError(404, `없는 경로: ${path}`);
		}

		// ── 정적 서빙 (SPA) ───────────────────────────────────────
		serveStatic(res, cfg.webDir, path);
	}

	wsHub = attachWebSocket(server, {
		secret: cfg.auth.secret,
		accounts,
		runtimes,
		ledgerEnabled: ledgerReady,
	});

	server.listen(cfg.port, cfg.host, () => {
		console.log(`\n  AlphaFolio v${APP_VERSION}  http://${cfg.host}:${cfg.port}`);
		console.log(`  ├ env      ${envFile ?? "(없음 — process.env만 사용)"}`);
		console.log(`  ├ model    ${cfg.agent.model ?? "(기본)"} · thinking ${cfg.agent.thinking}`);
		console.log(
			`  ├ users    ${cfg.auth.admin} (관리자)` +
				(accounts.ready ? ` + 가입 ${accounts.names().length - 1}명` : " — 가입 비활성 (D1 미설정)"),
		);
		console.log(`  ├ auth     ${cfg.agent.authPath ?? "(env API 키 사용)"}`);
		console.log(`  ├ agent    ${cfg.agent.agentDir}`);
		console.log(`  ├ cors     ${cfg.corsOrigins.join(", ")}`);
		console.log(`  ├ ledger   ${ledgerReady() ? "설정됨" : "미설정 — AF_D1_* 필요 (가계부·가입·개인 키 저장 비활성)"}`);
		console.log(`  ├ sessions ${cfg.agent.sessionsDir}`);
		console.log(
			`  ├ mcp      ${cfg.publicUrl ? `OAuth 콜백 ${cfg.publicUrl}${CALLBACK_PATH}` : "AF_PUBLIC_URL 미설정 — OAuth 연결 비활성 (헤더 인증 서버만)"}` +
				(cfg.mcpAllowPrivate ? " · ⚠️ 사설 주소 허용(개발용)" : ""),
		);
		console.log(`  └ web      ${existsSync(cfg.webDir) ? cfg.webDir : "(미빌드 — API만 제공)"}`);
		if (cfg.auth.generatedPassword) {
			console.log(`\n  ⚠️  AF_ADMIN_PASSWORD 미설정 — 이번 실행의 임시 비밀번호: ${cfg.auth.adminPassword}`);
			console.log(`      재시작하면 바뀐다. 고정하려면 AF_ADMIN_PASSWORD 를 설정하세요.`);
		}
		if (cfg.auth.ephemeralSecret) {
			console.log(`  ⚠️  AF_AUTH_SECRET 미설정 — 재시작하면 모든 로그인이 끊기고 저장된 개인 키를 읽을 수 없게 됩니다`);
		}
		console.log(
			`  시도제한 ${cfg.login.maxAttempts}회/${cfg.login.windowSec}초 → ${cfg.login.lockoutSec}초 잠금` +
				(cfg.login.trustProxy ? " (X-Forwarded-For 신뢰)" : " (소켓 IP 기준)"),
		);
		console.log("");
		// D1 이 없으면 스냅샷을 저장할 곳이 없다 — 가계부와 같은 조건
		if (process.env.AF_SNAPSHOT_DISABLED === "1") console.log("  스냅샷 비활성 (AF_SNAPSHOT_DISABLED=1)");
		else snapshotScheduler.start();
		// 감시 — 저장소가 적재됐을 때만 (D1 미설정이면 켤 트리거도 없다)
		if (process.env.AF_WATCH_DISABLED === "1") console.log("  감시 비활성 (AF_WATCH_DISABLED=1)");
		else if (triggerStore.ready) {
			watcher.start();
			telegramBots.start();
		}
	});

	const shutdown = (): void => {
		console.log("\n종료 중…");
		snapshotScheduler.stop();
		watcher.stop();
		telegramBots.stopAll();
		void runtimes.disposeAll();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

function serveStatic(res: ServerResponse, webDir: string, path: string): void {
	if (!existsSync(webDir)) {
		res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
		res.end("웹 UI가 아직 빌드되지 않았습니다 (apps/web). API는 /api/health 로 확인하세요.\n");
		return;
	}

	// 경로 탈출 방지
	const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
	let file = join(webDir, safePath);

	if (!file.startsWith(webDir) || !existsSync(file) || statSync(file).isDirectory()) {
		file = join(webDir, "index.html"); // SPA fallback
	}
	if (!existsSync(file)) {
		res.writeHead(404);
		res.end("not found");
		return;
	}

	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(res);
}

main().catch((err: unknown) => {
	console.error("기동 실패:", err instanceof Error ? err.message : err);
	process.exit(1);
});
