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
import { d1ConfigFromEnv, d1Ping, ensureMigrated, type D1Config } from "@alphafolio/ledger";
import {
	fetchPortfolio,
	fetchQuote,
	KisCredentialsMissingError,
	NoBrokerConfiguredError,
	parseAccount,
	TossCredentialsMissingError,
	cancelOrder,
	createOrder,
	defaultAccountSeq,
	listOrders,
	NaverCredentialsMissingError,
	type BrokerAccess,
	type KisContext,
	type NaverCredentials,
	type TossContext,
} from "@alphafolio/broker";
import { createBrokerTokenStore } from "./broker-tokens.ts";
import { createOrderToken, failureMessage, OrderTokenGuard } from "./order-tokens.ts";
import { bearerFrom, createToken, verifyToken } from "./auth.ts";
import { loadConfig, loadDotEnv } from "./config.ts";
import { handleLedger, HttpError, readJson, setLedgerConfigProvider } from "./ledger-api.ts";
import { clientIp, LoginRateLimiter } from "./ratelimit.ts";
import { RuntimeManager } from "./runtimes.ts";
import { SECRET_CATALOG, SecretStore, specFor, LLM_SECRET_PROVIDERS } from "./secrets.ts";
import { serializeMessages } from "./serialize.ts";
import { authenticate, hasUser, loadUsers } from "./users.ts";
import { attachWebSocket } from "./ws.ts";

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

async function main(): Promise<void> {
	const envFile = loadDotEnv();
	const cfg = loadConfig();
	const users = loadUsers();

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

	setLedgerConfigProvider(ledgerConfig);

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
	});

	/** 네이버 뉴스 자격증명 — 다른 키와 마찬가지로 사용자별이다. */
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
	const prepareOrder = (user: string) => (p: Parameters<typeof createOrderToken>[0] extends never ? never : Omit<Parameters<typeof createOrderToken>[0], "u">) => {
		const { token, payload } = createOrderToken({ ...p, u: user }, cfg.auth.secret);
		console.log(
			`[order] 준비 user=${user} ${p.symbol} ${p.side} ${p.quantity}주 ${p.orderType} nonce=${payload.nonce}`,
		);
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
		dataDir: cfg.dataDir,
		agentDir: cfg.agent.agentDir,
		model: cfg.agent.model,
		authPath,
		ledgerConfig,
		brokerAccess,
		naverCreds,
		prepareOrder,
		llmKeys,
		idleMinutes: cfg.idleMinutes,
	});

	const loginLimiter = new LoginRateLimiter(cfg.login);

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((err: unknown) => {
			// 자격증명 미설정은 서버 오류가 아니라 "설정이 필요함"이다
			const needsSetup =
				err instanceof KisCredentialsMissingError ||
				err instanceof TossCredentialsMissingError ||
				err instanceof NaverCredentialsMissingError ||
				err instanceof NoBrokerConfiguredError;
			const status = err instanceof HttpError ? err.status : needsSetup ? 503 : 500;
			const message = err instanceof Error ? err.message : String(err);
			if (status === 500) console.error("[server]", err);
			if (!res.headersSent) json(res, status, { error: message });
		});
	});

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname;

		// ── 공개 엔드포인트 ────────────────────────────────────────
		if (path === "/api/health") {
			json(res, 200, { ok: true, ledger: ledgerReady(), model: cfg.agent.model ?? "(기본)" });
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

			const authedName = authenticate(users, user, String(body.password ?? ""));
			if (!authedName) {
				loginLimiter.recordFailure(keys);
				json(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다" });
				return;
			}

			loginLimiter.recordSuccess(keys);
			json(res, 200, { token: createToken(authedName, cfg.auth.secret), user: authedName });
			return;
		}

		// ── 인증 필요 ─────────────────────────────────────────────
		if (path.startsWith("/api/")) {
			const user = verifyToken(bearerFrom(req.headers.authorization), cfg.auth.secret);
			// 토큰이 유효해도 계정이 삭제됐을 수 있으므로 현재 목록과 대조한다
			if (!user || !hasUser(users, user)) {
				json(res, 401, { error: "인증이 필요합니다" });
				return;
			}

			if (path.startsWith("/api/ledger")) {
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

			// ── 증권 ──────────────────────────────────────────
			// 에이전트를 거치지 않는 조회 경로 (가계부 REST 와 같은 구조).
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

				const order = verified.payload;
				// 주문을 보내기 **전에** 소비한다 — 더블클릭·재전송이 두 번 나가지 않게.
				// 실패해도 재사용을 허용하지 않는 쪽이 안전하다 (재요청은 새 확인을 받는다).
				orderGuard.consume(order.nonce);

				const ctx = tossContext(user);
				const accountSeq = await defaultAccountSeq(ctx);
				console.log(`[order] 실행 user=${user} ${order.symbol} ${order.side} ${order.quantity} nonce=${order.nonce}`);

				const created = await createOrder(ctx, accountSeq, {
					symbol: order.symbol,
					side: order.side,
					orderType: order.orderType,
					quantity: String(order.quantity),
					...(order.orderType === "LIMIT" && order.price !== undefined ? { price: String(order.price) } : {}),
					// nonce 를 멱등성 키로 — 브로커 레벨에서도 중복 주문이 막힌다
					clientOrderId: order.nonce,
				});

				json(res, 200, { ok: true, orderId: created.orderId, symbol: order.symbol });
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
				json(res, 200, { user, groups: [...new Set(SECRET_CATALOG.map((x) => x.group))] });
				return;
			}

			if (path === "/api/sessions" && req.method === "GET") {
				const runtime = await runtimes.get(user);
				json(res, 200, await runtime.listSessions());
				return;
			}

			if (path === "/api/state") {
				const runtime = await runtimes.get(user);
				json(res, 200, {
					user,
					tools: runtime.toolNames,
					sessionId: runtime.sessionId,
					model: runtime.modelLabel,
					isStreaming: runtime.isStreaming,
					messages: serializeMessages(runtime.messages),
				});
				return;
			}

			throw new HttpError(404, `없는 경로: ${path}`);
		}

		// ── 정적 서빙 (SPA) ───────────────────────────────────────
		serveStatic(res, cfg.webDir, path);
	}

	attachWebSocket(server, {
		secret: cfg.auth.secret,
		users,
		runtimes,
		ledgerEnabled: ledgerReady,
	});

	server.listen(cfg.port, cfg.host, () => {
		console.log(`\n  AlphaFolio  http://${cfg.host}:${cfg.port}`);
		console.log(`  ├ env      ${envFile ?? "(없음 — process.env만 사용)"}`);
		console.log(`  ├ model    ${cfg.agent.model ?? "(기본)"}`);
		console.log(`  ├ users    ${users.users.map((u) => u.name).join(", ")}`);
		console.log(`  ├ auth     ${cfg.agent.authPath ?? "(env API 키 사용)"}`);
		console.log(`  ├ agent    ${cfg.agent.agentDir}`);
		console.log(`  ├ ledger   ${ledgerReady() ? "설정됨" : "미설정 — 앱 설정 화면에서 입력"}`);
		console.log(`  ├ sessions ${cfg.agent.sessionsDir}`);
		console.log(`  └ web      ${existsSync(cfg.webDir) ? cfg.webDir : "(미빌드 — API만 제공)"}`);
		if (users.generatedPassword) {
			console.log(`\n  ⚠️  비밀번호 미설정 — 임시 비밀번호: ${users.generatedPassword}`);
		}
		if (users.legacyPlaintext) {
			console.log(`  ⚠️  단일 사용자 평문 모드 — 여러 명이 쓰려면 AF_USERS 를 설정하세요`);
			console.log(`      해시 생성: node apps/server/scripts/hash-password.mjs '비밀번호'`);
		}
		if (cfg.auth.ephemeralSecret) {
			console.log(`  ⚠️  AF_AUTH_SECRET 미설정 — 재시작하면 기존 토큰이 무효화됩니다`);
		}
		console.log(
			`  시도제한 ${cfg.login.maxAttempts}회/${cfg.login.windowSec}초 → ${cfg.login.lockoutSec}초 잠금` +
				(cfg.login.trustProxy ? " (X-Forwarded-For 신뢰)" : " (소켓 IP 기준)"),
		);
		console.log("");
	});

	const shutdown = (): void => {
		console.log("\n종료 중…");
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
