/**
 * kis_stream — KIS 실시간 시세(웹소켓 53종)를 몇 초 구독해서 요약한다 (PLAN §37).
 * 현재가 한 번이면 market_price 가 낫다. 이 툴은 "지금 몇 초간의 흐름" — 체결 틱·매수/매도 체결 비중·호가 잔량 변화.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrokerAccess } from "./portfolio.ts";
import { findWsApis, renderStream, resolveWsApi, streamKis, WS_MAX_SECONDS, WS_MAX_SUBS, type WsFactory } from "./kis/stream.ts";

type StreamDetails =
	| { kind: "kis-stream"; seconds: number; counts: Array<{ trId: string; key: string; n: number; error: string | null }> }
	| { kind: "kis-stream-find"; count: number };

export function createStreamTools(deps: { brokers: BrokerAccess; factory?: WsFactory }) {
	const tool = defineTool({
		name: "kis_stream",
		label: "실시간 시세",
		description:
			`한국투자증권 실시간 시세(웹소켓)를 몇 초(기본 5, 최대 ${WS_MAX_SECONDS}) 구독해 요약한다 — 구간 시가·고가·저가·마지막, 체결량 합과 매수/매도 체결 비중, 호가 10단계, 마지막 수신 값. ` +
			"국내주식 체결·호가·예상체결·프로그램매매·회원사(KRX/NXT/통합), 국내 지수, ELW, ETF NAV, 국내 선물옵션(지수·주식·상품·야간), 해외주식(미국 무료 실시간·아시아 지연), 해외선물옵션, 채권. " +
			"현재가 한 번이면 market_price 를 쓴다. find 로 찾고(TR ID·종목코드 형식 안내), subscribe 로 구독한다. " +
			"장 시간이 아니면 0건이 정상이다. 내 주문 체결통보는 지원하지 않는다 (order_list).",
		parameters: Type.Object({
			find: Type.Optional(Type.String({ description: "찾을 실시간 시세 (예: '주식 체결', '호가', '지수옵션', '해외주식')" })),
			subscribe: Type.Optional(
				Type.Array(
					Type.Object({
						api: Type.String({ description: "TR ID (예: H0STCNT0) 또는 find 결과의 key" }),
						key: Type.String({ description: "종목코드 — 형식은 find 결과 안내대로 (예: 005930, 0001, DNASAAPL)" }),
					}),
					{ description: `최대 ${WS_MAX_SUBS}개 — 같은 연결로 함께 받는다` },
				),
			),
			seconds: Type.Optional(Type.Integer({ description: `구독 시간 (기본 5, 최대 ${WS_MAX_SECONDS})` })),
		}),
		execute: async (_id, params) => {
			if (params.subscribe?.length) {
				const kis = deps.brokers.kis;
				if (!kis) throw new Error("실시간 시세는 한국투자증권 연결이 필요합니다. 설정 화면의 '증권 (KIS)' 에서 키를 입력하세요.");
				const r = await streamKis(kis(), params.subscribe, { seconds: params.seconds ?? 5, ...(deps.factory ? { factory: deps.factory } : {}) });
				return {
					content: [{ type: "text" as const, text: renderStream(r) }],
					details: { kind: "kis-stream", seconds: r.seconds, counts: r.subs.map((s) => ({ trId: s.api.trId, key: s.trKey, n: s.records.length, error: s.error ?? null })) } as StreamDetails,
				};
			}
			const q = params.find?.trim();
			if (!q) throw new Error("find 또는 subscribe 중 하나가 필요합니다.");
			const exact = resolveWsApi(q);
			const found = exact ? [exact] : findWsApis(q, 10);
			if (found.length === 0) {
				return { content: [{ type: "text" as const, text: `"${q}" 에 맞는 실시간 시세가 없습니다 (예: 체결, 호가, 지수, 선물, 옵션, 해외주식).` }], details: { kind: "kis-stream-find", count: 0 } as StreamDetails };
			}
			const lines = found.map(
				(f) => `- ${f.api.trId} · ${f.api.name} [${f.api.category}] · 필드 ${f.api.fields.length}개\n  종목코드: ${f.api.keyDesc.split("\n").slice(0, exact ? 30 : 4).join(" ")}`,
			);
			return {
				content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n구독: kis_stream { subscribe: [{ api: TR ID, key: 종목코드 }], seconds }` }],
				details: { kind: "kis-stream-find", count: found.length } as StreamDetails,
			};
		},
	});
	return [tool];
}

export const STREAM_TOOL_NAMES = ["kis_stream"] as const;
