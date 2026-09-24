/**
 * 토스증권 범용 조회 — 공개 OpenAPI 규격(catalog.json)의 **조회(GET) API 전부**를 호출한다 (PLAN §32).
 *
 * KIS 범용 조회(kis/gateway.ts)와 같은 원칙:
 *   - 쓰기(주문·정정·취소·조건주문)는 실행하지 않는다 — 확인 카드 경로로만
 *   - 계좌(X-Tossinvest-Account)는 서버가 넣는다. 계좌번호가 응답에 오면 끝 4자리만 보여준다
 *   - 날짜는 "today" / "today-30" → YYYY-MM-DD (토스 형식)
 *   - 모르는 파라미터·선택지 밖의 값은 거절한다
 * 다른 점: 응답이 중첩 JSON 이라 한글 이름으로 머리를 바꾸면 겹친다(외국인·기관 모두 "순매수 거래량").
 * 그래서 표 머리는 경로(foreigner.netBuyVolume) 그대로 두고, 아래에 한글 설명 범례를 붙인다.
 */
import { readFileSync } from "node:fs";
import { buildOasRequest, describeOasParams, oasDateToken, OAS_DEFAULT_ROWS, OAS_MAX_ROWS, renderOasResult, type OasApi } from "../oas.ts";
import { tossGet, type TossContext } from "./client.ts";
import { defaultAccountSeq } from "./api.ts";

export type TossApi = OasApi;

interface TossCatalog {
	source: string;
	version: string;
	count: number;
	tags: Record<string, string>;
	apis: Record<string, TossApi>;
}

export class TossGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TossGatewayError";
	}
}

let cached: TossCatalog | null = null;
export function tossCatalog(): TossCatalog {
	if (!cached) cached = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as TossCatalog;
	return cached;
}

export const isTossWrite = (api: TossApi): boolean => api.method !== "GET";
const ACCOUNT_HEADER = "X-Tossinvest-Account";

export function resolveTossApi(ref: string): { id: string; api: TossApi } | null {
	const apis = tossCatalog().apis;
	const r = ref.trim();
	if (apis[r]) return { id: r, api: apis[r] };
	const hit = Object.entries(apis).find(([id]) => id.toLowerCase() === r.toLowerCase());
	return hit ? { id: hit[0], api: hit[1] } : null;
}

/** 조회 API 목록 한 줄씩 — 툴 설명에 싣는다 (29개라 검색 단계 없이 바로 고른다) */
export function tossReadIndex(): string {
	return Object.entries(tossCatalog().apis)
		.filter(([, a]) => !isTossWrite(a))
		.map(([id, a]) => {
			const ps = Object.entries(a.params)
				.filter(([n]) => n !== ACCOUNT_HEADER)
				.map(([n, p]) => `${n}${p.required ? "*" : ""}`);
			return `${id}(${ps.join(", ")}) ${a.summary}`;
		})
		.join("\n");
}

/** "today" / "today-30" → YYYY-MM-DD (한국 시간) — 공용(oas.ts) */
export const tossDateToken = oasDateToken;

export interface TossRequest {
	path: string;
	query: Record<string, string>;
	needsAccount: boolean;
}

const SERVER_PARAMS: ReadonlySet<string> = new Set([ACCOUNT_HEADER]);

/** 모델이 준 파라미터를 규격에 맞춘다. 계좌 헤더는 모델 값을 무시한다 (서버가 넣는다). */
export function buildTossRequest(api: TossApi, input: Record<string, unknown>, now: number = Date.now()): { req: TossRequest; errors: string[] } {
	const { req, errors } = buildOasRequest(api, input, { serverParams: SERVER_PARAMS, now });
	return { req: { ...req, needsAccount: ACCOUNT_HEADER in api.params }, errors };
}

export async function callTossApi(
	ctx: TossContext,
	ref: string,
	input: Record<string, unknown>,
	now: number = Date.now(),
): Promise<{ id: string; api: TossApi; data: unknown }> {
	const found = resolveTossApi(ref);
	if (!found) throw new TossGatewayError(`없는 토스 API: "${ref}" — toss_query 설명의 목록에서 고르세요.`);
	const { id, api } = found;
	if (isTossWrite(api)) {
		throw new TossGatewayError(
			`"${api.summary}" 은(는) 주문·정정·취소 같은 쓰기 API 라 범용 조회로 실행하지 않습니다. ` +
				"주문은 order_prepare 로 준비하고 사용자가 화면에서 확인해야 나갑니다.",
		);
	}
	const { req, errors } = buildTossRequest(api, input, now);
	if (errors.length > 0) throw new TossGatewayError(`${api.summary} — 파라미터를 고쳐 다시 호출하세요:\n- ${errors.join("\n- ")}`);
	const accountSeq = req.needsAccount ? await defaultAccountSeq(ctx) : undefined;
	const data = await tossGet<unknown>(ctx, req.path, {
		query: req.query,
		group: api.group || "MARKET_DATA",
		...(accountSeq !== undefined ? { accountSeq } : {}),
	});
	return { id, api, data };
}

// ── 출력 (공용 — oas.ts) ────────────────────────────────────

export const TOSS_DEFAULT_ROWS = OAS_DEFAULT_ROWS;
export const TOSS_MAX_ROWS = OAS_MAX_ROWS;
export const renderTossResult = renderOasResult;

/** 상세 — 파라미터 설명 전부 + 그룹 설명(지수 심볼 카탈로그 같은 표) */
export function describeTossApi(id: string, api: TossApi): string {
	const params = describeOasParams(api, SERVER_PARAMS);
	const tag = tossCatalog().tags[api.tag];
	return [
		`${id} — ${api.summary} [${api.tag}]${isTossWrite(api) ? " · 쓰기(범용 조회로 실행 불가)" : ""}`,
		api.desc ? `설명: ${api.desc.slice(0, 700)}` : "",
		"파라미터:",
		...(params.length > 0 ? params : ["  (없음)"]),
		ACCOUNT_HEADER in api.params ? "  (계좌는 서버가 채움)" : "",
		tag && /카탈로그|\|/.test(tag) ? `\n그룹 안내:\n${tag.slice(0, 1500)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
