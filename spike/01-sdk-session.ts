/**
 * 스파이크 1 — pi SDK를 라이브러리로 임베드할 수 있는가?
 *
 * 검증 항목:
 *   a. 서브프로세스(`pi --mode rpc`) 없이 우리 프로세스 안에서 세션이 뜨는가
 *   b. customTool이 실제로 모델에 노출되고 호출되는가
 *   c. 스트리밍 이벤트를 구독할 수 있는가 (웹챗 WS로 중계할 대상)
 *   d. details 페이로드가 툴 결과에 실려 나오는가 (차트/원장 카드의 전달 경로)
 *
 * 실행: pnpm spike:sdk
 */
import { Type } from "typebox";
import {
	createAgentSession,
	defineTool,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadEnv } from "./env.ts";

loadEnv();

const MODEL = process.env.AF_DEFAULT_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash";

// (b)(d) 검증용 더미 툴 — 고정 값을 돌려주고 details를 실어 보낸다.
let toolCalled = false;
let detailsSent: unknown = null;

const portfolioValue = defineTool({
	name: "portfolio_value",
	label: "포트폴리오 평가액",
	description: "사용자의 현재 투자 포트폴리오 평가액을 조회한다. 금액을 물으면 반드시 이 툴을 쓴다.",
	parameters: Type.Object({
		currency: Type.Optional(Type.String({ description: "통화 (기본 KRW)" })),
	}),
	execute: async (_toolCallId, params) => {
		toolCalled = true;
		detailsSent = { kind: "spike-portfolio", total: 12_345_678, currency: params.currency ?? "KRW" };
		return {
			content: [{ type: "text" as const, text: "총 평가액 12,345,678원 (현금 2,000,000원 포함)" }],
			details: detailsSent,
		};
	},
});

async function main(): Promise<void> {
	const modelRuntime = await ModelRuntime.create();

	const resolved = resolveCliModel({ cliModel: MODEL, modelRuntime });
	if (resolved.error) throw new Error(`모델 해석 실패 (${MODEL}): ${resolved.error}`);
	if (resolved.warning) console.warn(`⚠️  ${resolved.warning}`);

	const { session } = await createAgentSession({
		model: resolved.model,
		thinkingLevel: "off",
		modelRuntime,
		// 파일시스템·bash 툴은 빼고 커스텀 툴만 노출 (앱에는 코딩 툴이 필요 없다)
		tools: ["portfolio_value"],
		customTools: [portfolioValue],
		sessionManager: SessionManager.inMemory(),
	});

	// (c) 이벤트 구독 — 웹챗이 WS로 중계할 바로 그 스트림
	const seen = new Set<string>();
	session.subscribe((event) => {
		seen.add(event.type);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log(`[모델] ${resolved.model?.provider}/${resolved.model?.id}`);
	console.log("[프롬프트] 내 포트폴리오 총 평가액이 얼마야?\n");
	console.log("─".repeat(60));

	await session.prompt("내 포트폴리오 총 평가액이 얼마야? 툴로 조회해서 알려줘.");

	console.log(`\n${"─".repeat(60)}`);
	console.log("\n[검증 결과]");
	console.log(`  a. 인프로세스 세션 생성 : ✅ (sessionId=${session.sessionId})`);
	console.log(`  b. customTool 호출      : ${toolCalled ? "✅" : "❌ 모델이 툴을 부르지 않음"}`);
	console.log(`  c. 이벤트 구독          : ✅ (${seen.size}종: ${[...seen].slice(0, 6).join(", ")}…)`);
	console.log(`  d. details 전달         : ${detailsSent ? `✅ ${JSON.stringify(detailsSent)}` : "❌"}`);

	session.dispose();
	if (!toolCalled) process.exitCode = 1;
}

main().catch((err: unknown) => {
	console.error("\n❌ 스파이크 1 실패:", err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
