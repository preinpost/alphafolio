/**
 * KIS REST 실행기 — 자격증명 주입식.
 *
 * pi-kis 는 338개 API 스펙(apis.json, 3.3MB)을 싣고 동적으로 호출하지만,
 * 여기서는 **실제로 쓰는 API 만 타입으로 고정**한다:
 *   - 이미지에 3.3MB 스펙을 넣지 않는다
 *   - 어떤 API 를 쓰는지 코드에서 바로 보인다
 *   - LLM 이 임의 API 를 호출할 통로를 만들지 않는다 (가계부의 raw SQL 금지와 같은 원칙)
 *
 * 필요한 API 가 늘면 api.ts 에 타입드 래퍼를 추가한다.
 */
import { getToken, invalidateToken, type TokenStore } from "./auth.ts";
import { withRateLimit } from "./ratelimit.ts";
import { baseUrl, KisError, type KisCredentials } from "./types.ts";
import { appKeyHash } from "./auth.ts";

export interface KisContext {
	creds: KisCredentials;
	store: TokenStore;
	/** 토큰 캐시 소유자 — 보통 사용자 이름. */
	owner: string;
}

export interface KisResponse<T = Record<string, unknown>> {
	rt_cd?: string;
	msg_cd?: string;
	msg1?: string;
	output?: T;
	output1?: T;
	output2?: T;
	[key: string]: unknown;
}

export interface CallOptions {
	path: string;
	trId: string;
	query: Record<string, string>;
	/** 로그·에러 표기용 짧은 이름. */
	label: string;
}

/** 토큰 만료로 판단해 1회 재시도할 응답 코드. */
const TOKEN_ERROR_CODES = new Set(["EGW00121", "EGW00123"]);

async function once(ctx: KisContext, opts: CallOptions, token: string): Promise<KisResponse> {
	const url = new URL(opts.path, baseUrl(ctx.creds.env));
	for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);

	const res = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${token}`,
			appkey: ctx.creds.appKey,
			appsecret: ctx.creds.appSecret,
			tr_id: opts.trId,
			custtype: "P",
			"content-type": "application/json; charset=utf-8",
		},
	});

	const text = await res.text();
	let json: KisResponse;
	try {
		json = JSON.parse(text) as KisResponse;
	} catch {
		throw new KisError(`응답을 파싱할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`, {
			status: res.status,
			api: opts.label,
		});
	}

	// KIS 는 HTTP 200 에 rt_cd 로 실패를 알린다 — 둘 다 본다.
	if (!res.ok || (json.rt_cd !== undefined && json.rt_cd !== "0")) {
		throw new KisError(`${opts.label} 실패: ${json.msg1 ?? text.slice(0, 200)}`, {
			status: res.status,
			code: typeof json.msg_cd === "string" ? json.msg_cd : undefined,
			api: opts.label,
		});
	}

	return json;
}

/**
 * KIS GET 호출. 토큰 만료(EGW00121 등)면 캐시를 버리고 한 번만 재시도한다.
 * 재발급은 SMS 를 유발하므로 무한 재시도는 하지 않는다.
 */
export async function kisGet(ctx: KisContext, opts: CallOptions): Promise<KisResponse> {
	const lane = appKeyHash(ctx.creds.appKey);

	return withRateLimit(lane, async () => {
		const token = await getToken(ctx.creds, ctx.store, ctx.owner);
		try {
			return await once(ctx, opts, token);
		} catch (err) {
			const retryable = err instanceof KisError && err.code !== undefined && TOKEN_ERROR_CODES.has(err.code);
			if (!retryable) throw err;

			await invalidateToken(ctx.creds, ctx.store, ctx.owner);
			const fresh = await getToken(ctx.creds, ctx.store, ctx.owner);
			return once(ctx, opts, fresh);
		}
	});
}

/** 계좌가 필요한 API 에서 CANO/ACNT_PRDT_CD 를 뽑는다. */
export function accountParams(creds: KisCredentials): { CANO: string; ACNT_PRDT_CD: string } {
	if (!creds.cano) {
		throw new KisError("계좌번호가 없습니다 — 설정 화면에서 '한국투자 계좌번호'를 입력하세요.", {
			status: 0,
			api: "account",
		});
	}
	return { CANO: creds.cano, ACNT_PRDT_CD: creds.prdtCd ?? "01" };
}
