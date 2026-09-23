/**
 * KIS REST 실행기 — 자격증명 주입식.
 *
 * 자주 쓰는 API 는 api.ts 에 타입드 래퍼로 고정하고(전용 툴이 쓴다), 나머지 조회 API 전부는
 * gateway.ts 가 카탈로그(catalog.json, 포털 규격에서 추린 것)로 호출한다 (PLAN §31).
 * 범용 통로는 **GET 조회만** 연다 — 주문·정정·취소(POST)는 확인 카드 경로로만 간다.
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
	/** 연속조회 — 다음 페이지를 요청할 때 "N" */
	trCont?: string;
}

/** 응답 + 연속조회 헤더 (F·M = 뒤에 더 있음, D·E = 마지막) */
export interface KisPage {
	json: KisResponse;
	trCont: string;
}

/** 토큰 만료로 판단해 1회 재시도할 응답 코드. */
const TOKEN_ERROR_CODES = new Set(["EGW00121", "EGW00123"]);

async function once(ctx: KisContext, opts: CallOptions, token: string): Promise<KisPage> {
	const url = new URL(opts.path, baseUrl(ctx.creds.env));
	for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);

	const res = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${token}`,
			appkey: ctx.creds.appKey,
			appsecret: ctx.creds.appSecret,
			tr_id: opts.trId,
			...(opts.trCont ? { tr_cont: opts.trCont } : {}),
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

	return { json, trCont: res.headers.get("tr_cont") ?? "" };
}

/**
 * KIS GET 호출. 토큰 만료(EGW00121 등)면 캐시를 버리고 한 번만 재시도한다.
 * 재발급은 SMS 를 유발하므로 무한 재시도는 하지 않는다.
 */
export async function kisGet(ctx: KisContext, opts: CallOptions): Promise<KisResponse> {
	return (await kisGetPage(ctx, opts)).json;
}

/** kisGet + 연속조회 헤더. 범용 조회(gateway.ts)가 페이지를 이어 받을 때 쓴다. */
export async function kisGetPage(ctx: KisContext, opts: CallOptions): Promise<KisPage> {
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
