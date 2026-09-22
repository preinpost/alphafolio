/**
 * 스파이크 3 — 결합. 자연어 → 에이전트 → ledger_* 툴 → D1.
 *
 * 이 프로젝트의 핵심 가설을 검증한다:
 *   "어제 김밥천국에서 8천원 썼어" 한 문장으로 구조화된 거래가 DB에 들어가는가.
 *   (= 가계부의 진짜 난제인 '입력 마찰'을 LLM이 실제로 해결하는가)
 *
 * 검증 항목:
 *   a. 날짜 표현("어제")을 LLM이 YYYY-MM-DD로 변환하는가
 *   b. 카테고리를 알아서 분류하는가 (김밥천국 → 식비)
 *   c. 집계 질문에 ledger_list가 아니라 ledger_summary를 고르는가 (토큰·프라이버시)
 *
 * 실행: pnpm spike:agent-ledger
 * 필요: .env 의 AF_D1_* + LLM 인증
 *
 * ⚠️ 실제 D1에 행을 쓴다. source='agent' 로 들어가며 끝에 정리한다.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { d1ConfigFromEnv, deleteTransaction, listTransactions, migrate } from "@alphafolio/ledger";
import { createLedgerTools, LEDGER_TOOL_NAMES } from "@alphafolio/ledger/tools";
import { loadEnv } from "./env.ts";

loadEnv();

const MODEL = process.env.AF_DEFAULT_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash";
const TODAY = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
	const cfg = d1ConfigFromEnv();
	await migrate(cfg);

	const modelRuntime = await ModelRuntime.create();
	const resolved = resolveCliModel({ cliModel: MODEL, modelRuntime });
	if (resolved.error) throw new Error(`모델 해석 실패 (${MODEL}): ${resolved.error}`);

	const calls: string[] = [];

	// 시스템 프롬프트는 ResourceLoader로 교체한다 (createAgentSession에 systemPrompt 옵션은 없다).
	// agentDir를 스파이크 전용 경로로 두어 사용자의 전역 확장(~/.pi/agent)이 따라들어오지 않게 한다.
	const spikeDir = dirname(fileURLToPath(import.meta.url));
	const loader = new DefaultResourceLoader({
		cwd: spikeDir,
		agentDir: join(spikeDir, ".pi-agent"),
		systemPromptOverride: () => `당신은 개인 금융 비서입니다. 오늘은 ${TODAY} (KST)입니다.
사용자가 지출/수입을 말하면 ledger_add로 기록하세요. 금액 합계를 물으면 ledger_summary를 쓰고,
개별 내역을 확인해야 할 때만 ledger_list를 쓰세요. 한국어로 간결하게 답하세요.`,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		model: resolved.model,
		thinkingLevel: "off",
		modelRuntime,
		tools: [...LEDGER_TOOL_NAMES],
		customTools: createLedgerTools(() => cfg, "spike"),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
	});

	session.subscribe((event) => {
		if (event.type === "tool_execution_start") calls.push(event.toolName);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log(`[모델] ${resolved.model?.provider}/${resolved.model?.id}   [오늘] ${TODAY}\n`);

	console.log("─ 1회차: 자연어 입력 ".padEnd(60, "─"));
	console.log("👤 어제 김밥천국에서 8천원 썼어\n🤖 ");
	await session.prompt("어제 김밥천국에서 8천원 썼어");

	console.log(`\n\n─ 2회차: 집계 질문 `.padEnd(60, "─"));
	console.log("👤 이번 달 식비 얼마나 썼어?\n🤖 ");
	await session.prompt("이번 달 식비 얼마나 썼어?");

	// 검증
	const yesterday = new Date(Date.now() + 9 * 60 * 60 * 1000 - 86_400_000).toISOString().slice(0, 10);
	const written = await listTransactions(cfg, { from: yesterday, to: TODAY, limit: 20 });
	const spikeRows = written.filter((r) => r.source === "agent" && r.merchant?.includes("김밥"));

	console.log(`\n\n${"─".repeat(60)}`);
	console.log("\n[검증 결과]");
	console.log(`  호출된 툴: ${calls.join(" → ") || "(없음)"}`);

	const row = spikeRows[0];
	console.log(`  a. 날짜 변환("어제")  : ${row ? (row.date === yesterday ? `✅ ${row.date}` : `⚠️ ${row.date} (기대 ${yesterday})`) : "❌ 기록 없음"}`);
	console.log(`  b. 카테고리 자동분류  : ${row?.category ? `✅ ${row.category}` : "❌"}`);
	console.log(`  c. 집계에 summary 선택: ${calls.includes("ledger_summary") ? "✅" : `❌ (${calls.join(",")})`}`);
	console.log(`     금액                : ${row ? `${Math.abs(row.amount).toLocaleString("ko-KR")}원` : "-"}`);

	// 정리
	for (const r of spikeRows) await deleteTransaction(cfg, r.id);
	console.log(`  정리                  : ✅ 테스트 행 ${spikeRows.length}건 삭제`);

	session.dispose();
	if (spikeRows.length === 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
	console.error("\n❌ 스파이크 3 실패:\n", err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
