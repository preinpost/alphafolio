/** 전용 툴에 없는 KIS·토스 조회의 게이트웨이. */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { callKisApi, describeKisApi, DEFAULT_ROWS, findKisApis, isVerifiedKisApi, isWriteApi, MAX_PAGES, MAX_ROWS, renderKisResult, resolveDateToken, resolveKisApi } from "../kis/gateway.ts";
import { callTossApi, describeTossApi, renderTossResult, resolveTossApi, TOSS_DEFAULT_ROWS, TOSS_MAX_ROWS, tossDateToken, tossReadIndex } from "../toss/gateway.ts";
import type { BrokerToolDeps } from "./contracts.ts";

export function createGatewayTools(deps: BrokerToolDeps) {
	const kisFind = defineTool({
		name: "kis_find",
		label: "KIS API 찾기",
		description:
			"한국투자증권 조회 API 257개(카탈로그)에서 필요한 API 를 찾는다. **전용 툴(market_* · portfolio_* · stock_research)로 " +
			"안 되는 조회**일 때만 쓴다 — 예: 외국인·기관 수급(투자자 매매동향), 공매도·신용잔고·대차, 프로그램매매, 업종 지수, " +
			"시가총액·배당률·신고가 순위, ETF NAV, 호가, 채권·선물옵션 시세, 배당 일정, 대차대조표. " +
			"query 로 검색하면 후보 목록, api 로 지정하면 파라미터·응답 필드 상세를 준다. 찾은 뒤 kis_call 로 호출한다.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "찾을 내용 (예: '종목별 외국인 순매수 일별', '공매도 추이')" })),
			api: Type.Optional(Type.String({ description: "상세를 볼 API (kis_find 결과의 key 또는 TR ID)" })),
		}),
		execute: async (_id, params) => {
			const today = resolveDateToken("today");
			if (params.api) {
				const hit = resolveKisApi(params.api);
				if (!hit) throw new Error(`없는 API: "${params.api}" — query 로 먼저 찾으세요.`);
				return {
					content: [{ type: "text" as const, text: `${describeKisApi(hit.key, hit.api)}

오늘(KST) ${today} — 날짜는 "today", "today-30" 처럼 넘겨도 된다.` }],
					details: { kind: "kis-find", count: 1 },
				};
			}
			const q = params.query?.trim();
			if (!q) throw new Error("query 또는 api 중 하나가 필요합니다.");
			const found = findKisApis(q, 8);
			if (found.length === 0) {
				return {
					content: [{ type: "text" as const, text: `"${q}" 에 맞는 KIS API 를 찾지 못했습니다. 다른 말로 찾아 보세요 (예: 투자자, 순위, 지수).` }],
					details: { kind: "kis-find", count: 0 },
				};
			}
			const lines = found.map((f) => {
				const required = Object.entries(f.api.params)
					.filter(([c, p]) => p[1] && c !== "CANO" && c !== "ACNT_PRDT_CD" && !/^CTX_AREA_/i.test(c))
					.map(([c, p]) => `${c}(${p[0]})`);
				return (
					`- ${f.api.name} [${f.api.category}${isWriteApi(f.api) ? " · 쓰기: 실행 불가" : ""}${isVerifiedKisApi(f.key) ? " · ✓실측" : ""}] key=${f.key}` +
					(required.length > 0 ? `
  필수: ${required.slice(0, 8).join(", ")}` : "") +
					(f.api.desc ? `
  ${f.api.desc.split("\n")[0]!.slice(0, 120)}` : "")
				);
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `${lines.join("\n")}

파라미터 안내가 필요하면 kis_find { api: key } 로 상세를 본다. 오늘(KST) ${today}.`,
					},
				],
				details: { kind: "kis-find", count: found.length },
			};
		},
	});

	const kisCall = defineTool({
		name: "kis_call",
		label: "KIS 조회",
		description:
			"kis_find 로 찾은 한국투자증권 **조회** API 를 호출한다. 응답 필드는 한글 이름(단위 포함)으로 바꿔 표로 준다 — " +
			"숫자는 그대로 인용하고 단위([백만원] 등)를 지킨다. 계좌번호·연속조회 키는 서버가 넣으므로 넘기지 않는다. " +
			"날짜는 YYYYMMDD 또는 'today' / 'today-30' 으로 넘긴다 (오늘 날짜를 추측하지 않는다). " +
			"주문·정정·취소 같은 쓰기 API 는 실행되지 않는다 (주문은 order_prepare).",
		parameters: Type.Object({
			api: Type.String({ description: "kis_find 결과의 key 또는 TR ID" }),
			params: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
					description: "API 파라미터 — 규격 코드(예: FID_INPUT_ISCD) 또는 한글명. 계좌번호·CTX_AREA_* 는 넣지 않는다",
				}),
			),
			tr_id: Type.Optional(Type.String({ description: "TR ID 가 여러 개인 API 만 — kis_find 상세의 TR 중 하나" })),
			pages: Type.Optional(Type.Integer({ description: `연속조회 페이지 수 (기본 1, 최대 ${MAX_PAGES})` })),
			limit: Type.Optional(Type.Integer({ description: `목록 최대 행 수 (기본 ${DEFAULT_ROWS}, 최대 ${MAX_ROWS})` })),
			fields: Type.Optional(
				Type.Array(Type.String(), { description: "보고 싶은 필드만 (한글명 일부 또는 코드, 예: ['일자', '외국인 순매수'])" }),
			),
		}),
		execute: async (_id, params) => {
			const kis = deps.brokers.kis;
			if (!kis) throw new Error("KIS 조회는 한국투자증권 연결이 필요합니다. 설정 화면의 '증권 (KIS)' 에서 키를 입력하세요.");
			const result = await callKisApi(kis(), params.api, params.params ?? {}, {
				...(params.tr_id ? { trId: params.tr_id } : {}),
				...(params.pages ? { pages: params.pages } : {}),
			});
			const out = renderKisResult(result, {
				...(params.limit ? { limit: params.limit } : {}),
				...(params.fields ? { fields: params.fields } : {}),
			});
			const head = `[KIS] ${result.api.name} · TR ${result.trId} · 오늘(KST) ${resolveDateToken("today")}`;
			const note = out.empty && result.api.desc ? `

규격 안내: ${result.api.desc.slice(0, 300)}` : "";
			return {
				content: [{ type: "text" as const, text: `${head}

${out.text}${note}` }],
				details: { kind: "kis-call", api: result.key, name: result.api.name, rows: out.rowCount },
			};
		},
	});

	// ── 토스 범용 조회 (PLAN §32) ────────────────────────────

	const tossQuery = defineTool({
		name: "toss_query",
		label: "토스 조회",
		description:
			"토스증권 조회 API 29개(공개 OpenAPI 규격)를 호출한다. **전용 툴로 안 되는 토스 조회**에 쓴다 — 호가·체결·상하한가, " +
			"매수 유의사항(투자경고·VI 등), 장 운영 일정(한국·미국 프리/정규/애프터), 코스피·코스닥 지수와 국채 금리, " +
			"시장 투자자별 매매대금, 종목별 투자자·공매도·신용·대차·프로그램매매 동향(거래량 기준), 랭킹 전 종류, 수수료, 주문·조건주문 조회. " +
			"api 에 아래 id 를, params 에 파라미터를 넣는다 (*=필수). 파라미터 선택지·지수 심볼 목록이 필요하면 describe: true. " +
			"날짜는 YYYY-MM-DD 또는 'today' / 'today-30'. 계좌는 서버가 넣는다. 주문·정정·취소는 실행되지 않는다.\n" +
			tossReadIndex(),
		parameters: Type.Object({
			api: Type.String({ description: "위 목록의 id (예: getStockInvestorTrading)" }),
			params: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { description: "파라미터 (예: { symbol: '005930', count: 10 })" }),
			),
			describe: Type.Optional(Type.Boolean({ description: "true 면 호출하지 않고 파라미터 설명·선택지·그룹 안내를 준다" })),
			limit: Type.Optional(Type.Integer({ description: `목록 최대 행 수 (기본 ${TOSS_DEFAULT_ROWS}, 최대 ${TOSS_MAX_ROWS})` })),
			fields: Type.Optional(Type.Array(Type.String(), { description: "보고 싶은 필드만 (경로 일부 또는 설명 일부, 예: ['date', 'foreigner'])" })),
		}),
		execute: async (_id, params) => {
			const today = tossDateToken("today");
			if (params.describe) {
				const hit = resolveTossApi(params.api);
				if (!hit) throw new Error(`없는 토스 API: "${params.api}"`);
				return {
					content: [{ type: "text" as const, text: `${describeTossApi(hit.id, hit.api)}

오늘(KST) ${today}` }],
					details: { kind: "toss-query", api: hit.id, rows: 0 },
				};
			}
			const toss = deps.brokers.toss;
			if (!toss) throw new Error("토스 조회는 토스증권 연결이 필요합니다. 설정 화면의 '증권 (토스)' 에서 키를 입력하세요.");
			const r = await callTossApi(toss(), params.api, params.params ?? {});
			const out = renderTossResult(r.api, r.data, {
				...(params.limit ? { limit: params.limit } : {}),
				...(params.fields ? { fields: params.fields } : {}),
			});
			return {
				content: [{ type: "text" as const, text: `[토스] ${r.api.summary} (${r.id}) · 오늘(KST) ${today}\n\n${out.text}` }],
				details: { kind: "toss-query", api: r.id, rows: out.rowCount },
			};
		},
	});

	return { kisFind, kisCall, tossQuery };
}
