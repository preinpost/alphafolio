/**
 * 데이터 제공자 범용 조회 툴 — data_find · data_call (PLAN §35).
 * finnhub(미국 재무·실적·뉴스·내부자) · Twelve Data(전 세계 시세·지표·외환·ETF) · CoinGecko(코인 시장) · Binance(코인 시세·내 계좌).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	callDataApi,
	describeDataApi,
	findDataApis,
	isDataWrite,
	PROVIDERS,
	renderDataResult,
	resolveDataApi,
	type DataCreds,
	type DataProvider,
} from "./data/gateway.ts";
import { oasDateToken, OAS_DEFAULT_ROWS, OAS_MAX_ROWS } from "./oas.ts";

export interface DataToolDeps {
	/** 호출 시점에 읽는다 — 설정에서 키를 넣으면 재시작 없이 된다 */
	creds: () => DataCreds;
}

const ProviderT = Type.Union([Type.Literal("finnhub"), Type.Literal("twelve"), Type.Literal("coingecko"), Type.Literal("binance")], {
	description: "finnhub=미국 재무·실적·뉴스 / twelve=전 세계 시세·지표·외환·ETF / coingecko=코인 시장 / binance=코인 시세·내 계좌",
});

export function createDataTools(deps: DataToolDeps) {
	const dataFind = defineTool({
		name: "data_find",
		label: "데이터 API 찾기",
		description:
			"해외·코인 데이터 제공자 API ~600개(finnhub 113 · Twelve Data 186 · CoinGecko 66 · Binance 230, 공식 규격)에서 찾는다. " +
			"KIS·토스·전용 툴로 안 되는 것만 — 미국 기업 재무·실적 발표 일정·애널리스트 추정·내부자 거래(finnhub), " +
			"외환·원자재·해외 지수·ETF·기술지표(twelve), 코인 시가총액·트렌딩·거래소(coingecko), 코인 호가·캔들·내 Binance 잔고·주문 내역(binance). " +
			"query 로 찾고, provider+api 로 파라미터 상세를 본다. 그다음 data_call.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "영문 키워드가 잘 맞는다 (규격이 영어) — 예: 'earnings calendar', 'forex', 'trending'" })),
			provider: Type.Optional(ProviderT),
			api: Type.Optional(Type.String({ description: "상세를 볼 API id (provider 필요)" })),
		}),
		execute: async (_id, params) => {
			const today = oasDateToken("today");
			if (params.api) {
				if (!params.provider) throw new Error("api 상세에는 provider 가 필요합니다.");
				const hit = resolveDataApi(params.provider as DataProvider, params.api);
				if (!hit) throw new Error(`없는 API: ${params.provider} "${params.api}"`);
				return {
					content: [{ type: "text" as const, text: `${describeDataApi(params.provider as DataProvider, hit.id, hit.api)}\n\n오늘(KST) ${today}` }],
					details: { kind: "data-find", count: 1 },
				};
			}
			const q = params.query?.trim();
			if (!q) throw new Error("query 또는 provider+api 가 필요합니다.");
			const found = findDataApis(q, params.provider as DataProvider | undefined, 10);
			if (found.length === 0) {
				return { content: [{ type: "text" as const, text: `"${q}" 에 맞는 API 가 없습니다. 영문 키워드로 찾아 보세요.` }], details: { kind: "data-find", count: 0 } };
			}
			const creds = deps.creds();
			const lines = found.map((f) => {
				const req = Object.entries(f.api.params)
					.filter(([n, p]) => p.required && !PROVIDERS[f.provider].serverParams.has(n))
					.map(([n]) => n);
				const keyNeed =
					f.provider === "binance" ? (f.api.auth === "signed" ? " · 내 계좌(키 필요)" : "") : !PROVIDERS[f.provider].keyOptional && !creds[f.provider] ? " · ⚠ 키 미설정" : "";
				return `- ${f.provider} · ${f.id} — ${f.api.summary}${isDataWrite(f.api) ? " · 쓰기: 실행 불가" : ""}${keyNeed}\n  ${f.api.method} ${f.api.path}${req.length ? ` · 필수: ${req.join(", ")}` : ""}`;
			});
			return {
				content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n상세는 data_find { provider, api }. 오늘(KST) ${today}.` }],
				details: { kind: "data-find", count: found.length },
			};
		},
	});

	const dataCall = defineTool({
		name: "data_call",
		label: "데이터 조회",
		description:
			"data_find 로 찾은 API 를 호출한다 (조회만). 키·서명은 서버가 넣는다. 날짜는 YYYY-MM-DD 또는 'today' / 'today-30'. " +
			"결과의 '필드 설명' 범례로 뜻·단위를 확인하고 숫자는 그대로 인용한다. 무료 요금제라 Twelve Data 는 분당 8회로 느리다 — 꼭 필요한 호출만.",
		parameters: Type.Object({
			provider: ProviderT,
			api: Type.String({ description: "data_find 결과의 id (또는 GET 경로)" }),
			params: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
			limit: Type.Optional(Type.Integer({ description: `목록 최대 행 수 (기본 ${OAS_DEFAULT_ROWS}, 최대 ${OAS_MAX_ROWS})` })),
			fields: Type.Optional(Type.Array(Type.String(), { description: "보고 싶은 필드만 (경로 일부 또는 설명 일부)" })),
		}),
		execute: async (_id, params) => {
			const provider = params.provider as DataProvider;
			const r = await callDataApi(provider, params.api, params.params ?? {}, deps.creds());
			const out = renderDataResult(provider, r.api, r.data, {
				...(params.limit ? { limit: params.limit } : {}),
				...(params.fields ? { fields: params.fields } : {}),
			});
			return {
				content: [{ type: "text" as const, text: `[${PROVIDERS[provider].label}] ${r.api.summary || r.id} · 오늘(KST) ${oasDateToken("today")}\n\n${out.text}` }],
				details: { kind: "data-call", provider, api: r.id, rows: out.rowCount },
			};
		},
	});

	return [dataFind, dataCall];
}

export const DATA_TOOL_NAMES = ["data_find", "data_call"] as const;
