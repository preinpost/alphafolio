/**
 * 토스증권 Open API 클라이언트 — 자격증명 주입식.
 *
 * KIS 와 같은 규칙: **process.env 를 읽지 않는다.** 사람마다 다른 계정을 쓴다.
 *
 * 인증: OAuth 2.0 client_credentials (form-urlencoded) → Bearer 토큰.
 * 응답: 성공은 전부 `{ result: ... }` 래퍼, 실패는 `{ error: { code, message } }`.
 * 계좌·자산 API 는 `X-Tossinvest-Account: <accountSeq>` 헤더가 필요하다
 * (계좌번호가 아니라 정수 식별 키 — /api/v1/accounts 에서 얻는다).
 */
import { issueOnce, type TokenStore } from "../tokens.ts";

export const TOSS_BASE = "https://openapi.tossinvest.com";

export interface TossCredentials {
	clientId: string;
	clientSecret: string;
}

export interface TossContext {
	creds: TossCredentials;
	store: TokenStore;
	/** 토큰 캐시 소유자 — 보통 사용자 이름. */
	owner: string;
}

export class TossError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, opts: { status: number; code?: string }) {
		super(message);
		this.name = "TossError";
		this.status = opts.status;
		this.code = opts.code;
	}
}

export class TossCredentialsMissingError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		super(
			`토스증권 설정이 없습니다 (${missing.join(", ")}). ` +
				`설정 화면의 '증권 (토스)' 에서 입력하세요. 키는 사용자별로 저장됩니다.`,
		);
		this.name = "TossCredentialsMissingError";
		this.missing = missing;
	}
}

// ── 토큰 ────────────────────────────────────────────────────────────────

function tokenKey(owner: string, clientId: string): string {
	return `toss:${owner}:${clientId}`;
}

async function issueToken(ctx: TossContext, key: string): Promise<string> {
	const res = await fetch(`${TOSS_BASE}/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: ctx.creds.clientId,
			client_secret: ctx.creds.clientSecret,
		}).toString(),
	});

	const text = await res.text();
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new TossError(`토스 토큰 발급 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status });
	}

	const token = json.access_token;
	if (typeof token !== "string" || !token) {
		const desc = json.error_description ?? json.error ?? text.slice(0, 200);
		throw new TossError(`토스 토큰 발급 실패: ${String(desc)}`, { status: res.status });
	}

	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
	await ctx.store.set(key, { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
	return token;
}

async function getToken(ctx: TossContext): Promise<string> {
	const key = tokenKey(ctx.owner, ctx.creds.clientId);
	const cached = await ctx.store.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.token;
	return issueOnce(key, () => issueToken(ctx, key));
}

// ── 레이트 리밋 ─────────────────────────────────────────────────────────

/**
 * 토스는 엔드포인트 그룹별로 한도가 다르다 (시세 10/s, 차트 5/s, 계좌 1/s …).
 * 가장 빡빡한 계좌 조회에 맞춰 보수적으로 잡되, 클라이언트 단위로 직렬화한다.
 */
/**
 * 그룹별 최소 호출 간격 (ms). 그룹 이름은 규격의 "Rate Limits Group" (catalog.json 의 group).
 * 규격에 초당 한도가 없어 옛 pi-toss 의 표(5/s·10/s 등)를 따르고, 거기 없던 새 그룹은 보수적으로 잡는다.
 */
const RATE_MS: Record<string, number> = {
	MARKET_DATA: 120,
	MARKET_DATA_CHART: 220,
	MARKET_INFO: 350,
	ACCOUNT: 1100,
	ASSET: 220,
	ORDER_INFO: 180,
	STOCK: 250,
	STOCK_ALL: 1100, // 새 그룹 — 전체 종목 목록(응답이 크다)
	STOCK_TRADING_TREND: 300, // 새 그룹 — 종목별 투자자·공매도·신용·대차·프로그램
	RANKING: 250,
	MARKET_INDICATOR: 150,
	MARKET_INDICATOR_CHART: 250,
	ORDER: 120,
	ORDER_HISTORY: 250,
	CONDITIONAL_ORDER: 250,
	CONDITIONAL_ORDER_HISTORY: 150,
};

const lanes = new Map<string, { tail: Promise<void>; lastStartAt: number }>();

async function throttled<T>(laneKey: string, intervalMs: number, fn: () => Promise<T>): Promise<T> {
	const lane = lanes.get(laneKey) ?? { tail: Promise.resolve(), lastStartAt: 0 };
	lanes.set(laneKey, lane);

	const run = lane.tail.then(async () => {
		const wait = lane.lastStartAt + intervalMs - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lane.lastStartAt = Date.now();
	});
	lane.tail = run.catch(() => {});
	await run;
	return fn();
}

// ── 요청 ────────────────────────────────────────────────────────────────

export interface TossRequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	/** X-Tossinvest-Account 값 (계좌·자산 API). */
	accountSeq?: number;
	/** 레이트 리밋 그룹 (기본 MARKET_DATA). 규격의 그룹 이름 — 모르는 그룹은 300ms */
	group?: string;
}

export interface TossWriteOptions {
	accountSeq: number;
	body?: unknown;
	group?: string;
}

/** `{ result: ... }` 래퍼 해제. */
function unwrap(json: unknown): unknown {
	if (json && typeof json === "object" && "result" in (json as Record<string, unknown>)) {
		return (json as { result: unknown }).result;
	}
	return json;
}

interface CallSpec {
	method: "GET" | "POST";
	path: string;
	query?: TossRequestOptions["query"];
	accountSeq?: number;
	body?: unknown;
}

async function callOnce<T>(
	ctx: TossContext,
	spec: CallSpec,
	token: string,
): Promise<{ ok: true; data: T } | { ok: false; err: TossError }> {
	const url = new URL(spec.path, TOSS_BASE);
	for (const [k, v] of Object.entries(spec.query ?? {})) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}

	const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
	if (spec.accountSeq !== undefined) headers["X-Tossinvest-Account"] = String(spec.accountSeq);
	if (spec.method === "POST") headers["content-type"] = "application/json";

	const res = await fetch(url, {
		method: spec.method,
		headers,
		...(spec.method === "POST" ? { body: JSON.stringify(spec.body ?? {}) } : {}),
	});
	const text = await res.text();

	let json: unknown;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		return {
			ok: false,
			err: new TossError(`토스 응답을 파싱할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`, {
				status: res.status,
			}),
		};
	}

	if (!res.ok) {
		const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
		return {
			ok: false,
			err: new TossError(`토스 ${spec.path} 실패: ${e?.message ?? text.slice(0, 200)}`, {
				status: res.status,
				code: e?.code,
			}),
		};
	}

	return { ok: true, data: unwrap(json) as T };
}

/**
 * 토스 GET 요청 (조회).
 * 401 expired/invalid-token 이면 캐시를 버리고 한 번만 재시도한다 — 조회는 재시도해도 안전하다.
 */
export async function tossGet<T>(ctx: TossContext, path: string, opts: TossRequestOptions = {}): Promise<T> {
	const group = opts.group ?? "MARKET_DATA";
	const lane = `${ctx.creds.clientId}:${group}`;
	const spec: CallSpec = { method: "GET", path, query: opts.query, accountSeq: opts.accountSeq };

	return throttled(lane, RATE_MS[group] ?? 300, async () => {
		const first = await callOnce<T>(ctx, spec, await getToken(ctx));
		if (first.ok) return first.data;
		if (first.err.status !== 401) throw first.err;

		await ctx.store.delete(tokenKey(ctx.owner, ctx.creds.clientId));
		const retry = await callOnce<T>(ctx, spec, await getToken(ctx));
		if (retry.ok) return retry.data;
		throw retry.err;
	});
}

/**
 * 토스 POST 요청 (주문·취소 등 **상태를 바꾸는** 호출).
 *
 * ⚠️ GET 과 달리 **자동 재시도를 하지 않는다.** 응답을 못 받았을 때 재시도하면
 *    중복 주문이 될 수 있기 때문이다. 토큰 만료(401)만 1회 재시도하는데, 이때도
 *    호출부가 clientOrderId(멱등성 키)를 실어 보내므로 중복이 생기지 않는다.
 */
export async function tossPost<T>(ctx: TossContext, path: string, opts: TossWriteOptions): Promise<T> {
	const group = opts.group ?? "ORDER_INFO";
	const lane = `${ctx.creds.clientId}:${group}`;
	const spec: CallSpec = { method: "POST", path, accountSeq: opts.accountSeq, body: opts.body };

	return throttled(lane, RATE_MS[group] ?? 300, async () => {
		const first = await callOnce<T>(ctx, spec, await getToken(ctx));
		if (first.ok) return first.data;
		if (first.err.status !== 401) throw first.err;

		await ctx.store.delete(tokenKey(ctx.owner, ctx.creds.clientId));
		const retry = await callOnce<T>(ctx, spec, await getToken(ctx));
		if (retry.ok) return retry.data;
		throw retry.err;
	});
}
