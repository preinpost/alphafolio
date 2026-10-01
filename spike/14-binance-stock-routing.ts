/**
 * 스파이크 14 — "바이낸스에서 ○○ 주식 사 줘" 를 에이전트가 **실제 주식**(binance_stock_order · watch_alert broker binance_stock)으로 보내는가,
 * bStock 토큰(AAPLBUSDT)으로 새지 않는가. 실제 페르소나 + 실제 툴 정의 + 앱 기본 모델.
 *
 * 주문은 **준비만** 한다 — prepareOrder·prepareWatch 는 기록만 하는 가짜라 확인 토큰도 서버에 없다 (실행 경로가 없다).
 * 조회(Binance 공개·주식 exchangeInfo·quote)는 실제로 한다. 감시 봉은 가짜.
 *
 * 실행: node spike/14-binance-stock-routing.ts
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
import { d1ConfigFromEnv } from "@alphafolio/ledger";
import { buildSystemPrompt } from "../packages/agent/src/persona.ts";
import { equityGrid, equityRules, type OrderAction, type OrderTarget, type TriggerSpec } from "@alphafolio/broker";
import { createBinanceOrderTool } from "../packages/broker/src/binance/order-tool.ts";
import { createBinanceStockOrderTool } from "../packages/broker/src/binance/stock-order-tool.ts";
import { createWatchTools } from "../packages/broker/src/triggers/tool.ts";
import { SecretStore } from "../apps/server/src/secrets.ts";
import { loadEnv } from "./env.ts";

setDefaultAutoSelectFamilyAttemptTimeout(2_000);
loadEnv();
const MODEL = process.argv[2] ?? process.env.AF_DEFAULT_MODEL ?? "openrouter/openai/gpt-6-luna";
const user = process.env.AF_ADMIN_USER ?? "alpha";
const secrets = new SecretStore(() => d1ConfigFromEnv(), process.env.AF_AUTH_SECRET ?? "", false);
await secrets.load();
const creds = { key: secrets.get("BINANCE_API_KEY", user) ?? "", secret: secrets.get("BINANCE_API_SECRET", user) ?? "" };
if (!creds.key) throw new Error("Binance 키가 없습니다");

const KIS: OrderTarget = { broker: "kis", account: "aaa", accountLabel: "한국투자 ****78-01" };
const BIN: OrderTarget = { broker: "binance", account: "bbb", accountLabel: "Binance 현물 (키 bbb)" };
const BST: OrderTarget = { broker: "binance_stock", account: "ccc", accountLabel: "Binance 미국 주식 (키 ccc)" };

interface Rec { tool: string; args: Record<string, unknown>; error: string | null }

async function run(prompt: string): Promise<{ recs: Rec[]; orders: OrderAction[]; watches: TriggerSpec[]; text: string }> {
	const orders: OrderAction[] = [];
	const watches: TriggerSpec[] = [];
	const prepareOrder = (a: OrderAction) => (orders.push(a), { token: "spike", expiresAt: Date.now() + 600_000 });
	const brokers = { binance: () => creds };
	const [watch] = createWatchTools({
		prepareWatch: (s) => (watches.push(s), { token: "spike", expiresAt: Date.now() + 600_000 }),
		listWatches: async () => [],
		pauseWatch: async () => {
			throw new Error("no");
		},
		channels: () => ["telegram"],
		fetchBars: async (_c, limit) => Array.from({ length: limit }, (_, i) => ({ t: Date.now() - (limit - i) * 3_600_000, open: 330, high: 335, low: 325, close: 332, volume: 100 })),
		feeds: () => ({ kis: true, toss: false }),
		orderTargets: async () => [KIS, BIN, BST],
		tradeLimits: async () => ({ KRW: 1_000_000, USD: 1000, USDT: 500 }),
		autoTradeOff: () => null,
		position: async () => ({ sellable: 1, avgPrice: 300 }),
		equityGrid: async (s) => {
			const r = await equityRules(creds, s);
			return r ? equityGrid(r) : null;
		},
	});
	const tools = [createBinanceOrderTool({ brokers, prepareOrder }), createBinanceStockOrderTool({ brokers, prepareOrder }), watch!];
	const spikeDir = dirname(fileURLToPath(import.meta.url));
	const loader = new DefaultResourceLoader({ cwd: spikeDir, agentDir: join(spikeDir, ".pi-agent"), systemPromptOverride: () => buildSystemPrompt({ ledgerEnabled: false, member: user }) });
	await loader.reload();
	const modelRuntime = await ModelRuntime.create();
	const resolved = resolveCliModel({ cliModel: MODEL, modelRuntime });
	if (resolved.error) throw new Error(resolved.error);
	const { session } = await createAgentSession({
		model: resolved.model,
		thinkingLevel: "low",
		modelRuntime,
		tools: tools.map((t) => t.name),
		customTools: tools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
	});
	const recs: Rec[] = [];
	let text = "";
	session.subscribe((e) => {
		const ev = e as { type: string; toolName?: string; args?: Record<string, unknown>; isError?: boolean; result?: { content?: Array<{ text?: string }> }; assistantMessageEvent?: { type: string; delta?: string } };
		if (ev.type === "tool_execution_start") recs.push({ tool: ev.toolName ?? "?", args: ev.args ?? {}, error: null });
		if (ev.type === "tool_execution_end" && ev.isError) {
			const r = recs.at(-1);
			if (r) r.error = (ev.result?.content?.[0]?.text ?? "error").slice(0, 140);
		}
		if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") text += ev.assistantMessageEvent.delta ?? "";
	});
	await session.prompt(prompt);
	session.dispose();
	return { recs, orders, watches, text };
}

const CASES: Array<{ prompt: string; want: "stock" | "bstock" | "ask" }> = [
	{ prompt: "바이낸스에서 애플 0.1주 사줘", want: "stock" },
	{ prompt: "바이낸스로 엔비디아 100달러어치 사 줘", want: "stock" },
	{ prompt: "바이낸스에서 테슬라 주식 0.05주 현재가 근처 지정가로 매수", want: "stock" },
	{ prompt: "바이낸스에서 애플 주식 좀 사고 싶어, 50달러 정도", want: "stock" },
	{ prompt: "바이낸스 애플 1시간봉 340 돌파하면 100달러어치 사줘", want: "stock" },
	{ prompt: "바이낸스에서 AAPLB 토큰(bStock) 0.1개 사줘, 지정가 330", want: "bstock" },
];

console.log(`[모델] ${MODEL}\n`);
let ok = 0;
for (const c of CASES) {
	const r = await run(c.prompt);
	const tokenOrder = r.orders.some((o) => o.kind.startsWith("binance-") && !o.kind.startsWith("binance-stock") && /BUSDT$/.test((o as { symbol: string }).symbol)) || r.watches.some((w) => w.condition.market.venue === "binance");
	const stockOrder = r.orders.some((o) => o.kind === "binance-stock-place") || r.watches.some((w) => w.action.kind === "order" && w.action.target.broker === "binance_stock");
	// 라우팅 — 어느 툴·심볼로 갔는가 (검증 거절로 준비가 안 됐어도 길은 맞을 수 있다)
	const triedToken = r.recs.some((x) => /BUSDT/.test(JSON.stringify(x.args)) || (x.tool === "watch_alert" && x.args.market === "binance"));
	const triedStock = r.recs.some((x) => x.tool === "binance_stock_order" || (x.tool === "watch_alert" && JSON.stringify(x.args).includes("binance_stock")));
	const routed = c.want === "stock" ? triedStock && !triedToken : triedToken && !triedStock;
	const prepared = c.want === "stock" ? stockOrder && !tokenOrder : tokenOrder && !stockOrder;
	const verdict = !routed ? "❌ 길 틀림" : prepared ? "✅" : "✅ 길 맞음 · 준비 안 됨";
	if (routed) ok++;
	console.log(`${verdict} 👤 ${c.prompt}`);
	for (const x of r.recs) console.log(`    → ${x.tool} ${JSON.stringify(x.args).slice(0, 200)}${x.error ? `\n      ✖ ${x.error}` : ""}`);
	console.log(`    🤖 ${r.text.replace(/\s+/g, " ").slice(0, 220)}\n`);
}
console.log(`라우팅 ${ok}/${CASES.length}`);
process.exit(0);
