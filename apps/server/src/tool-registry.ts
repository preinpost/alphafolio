/** 사용자별 도구 조립 — 런타임과 계약 테스트가 같은 등록 경로를 사용한다. */
import { createLedgerTools, LEDGER_TOOL_NAMES } from "@alphafolio/ledger/tools";
import { createBrokerTools, BROKER_TOOL_NAMES } from "@alphafolio/broker/tools";
import { createOrderTools, ORDER_TOOL_NAMES } from "@alphafolio/broker/order-tools";
import { createDataTools, DATA_TOOL_NAMES } from "@alphafolio/broker/data-tools";
import { createStreamTools, STREAM_TOOL_NAMES } from "@alphafolio/broker/stream-tools";
import { createDerivativesTools, DERIVATIVES_TOOL_NAMES } from "@alphafolio/broker/derivatives-tools";
import { createMcpTools, MCP_TOOL_NAMES } from "@alphafolio/mcp/tools";
import { createWatchTools, WATCH_TOOL_NAMES } from "@alphafolio/broker/watch-tools";
import { createJournalTools, JOURNAL_TOOL_NAMES } from "@alphafolio/broker/journal-tools";
import type { RuntimeManagerOptions } from "./runtimes.ts";

export const CUSTOM_TOOL_NAMES = [
	...LEDGER_TOOL_NAMES, ...BROKER_TOOL_NAMES, ...ORDER_TOOL_NAMES, ...DATA_TOOL_NAMES,
	...STREAM_TOOL_NAMES, ...DERIVATIVES_TOOL_NAMES, ...MCP_TOOL_NAMES, ...WATCH_TOOL_NAMES, ...JOURNAL_TOOL_NAMES,
] as const;

type ToolOptions = Pick<RuntimeManagerOptions,
	"ledgerConfig" | "brokerAccess" | "naverCreds" | "dataCreds" | "prepareOrder" |
	"mcpServers" | "mcpFetch" | "prepareMcpWrite" | "watch" | "journal"
>;

/**
 * 확인 카드(serialize.ts 의 CARD_KINDS)를 내는 도구 — codemode 스크립트에서 부르지 못하게 한다.
 * 스크립트 안의 호출 결과는 화면에 오지 않아 카드가 뜨지 않고, 사람이 [확인] 을 누를 길이 없어진다.
 * model-only 는 모델이 직접 부르는 것만 허용한다 (pi docs/extensions.md — Tool exposure).
 */
export const CONFIRM_CARD_TOOL_NAMES = [
	"order_prepare", "order_change", "order_conditional",
	"binance_order", "binance_stock_order", "binance_wallet", "binance_futures",
	"mcp_call", "watch_alert", "range_trade",
] as const;
const CONFIRM_CARD_TOOLS = new Set<string>(CONFIRM_CARD_TOOL_NAMES);

export function createUserTools(opts: ToolOptions, user: string) {
	return [
		// 가계부는 멤버끼리 공유되지만 기록자는 사용자별로 묶인다.
		...createLedgerTools(opts.ledgerConfig, user),
		...createBrokerTools({
			brokers: opts.brokerAccess(user), ledger: opts.ledgerConfig, member: user,
			naver: () => opts.naverCreds(user), prepareOrder: opts.prepareOrder(user),
		}),
		// 주문·MCP 쓰기·감시 켜기는 준비만 한다. 실행은 사람의 확인 경로로.
		...createOrderTools({ brokers: opts.brokerAccess(user), prepareOrder: opts.prepareOrder(user) }),
		...createDataTools({ creds: () => opts.dataCreds(user) }),
		...createStreamTools({ brokers: opts.brokerAccess(user) }),
		...createDerivativesTools({ brokers: opts.brokerAccess(user) }),
		...createMcpTools({ servers: () => opts.mcpServers(user), fetch: opts.mcpFetch, prepareWrite: opts.prepareMcpWrite(user) }),
		...createWatchTools(opts.watch(user)),
		// 매매일지는 개인 것이고 돈을 움직이지 않는다 — 확인 카드 없이 바로 쓴다
		...createJournalTools(opts.journal(user)),
	].map((tool) => (CONFIRM_CARD_TOOLS.has(tool.name) ? { ...tool, exposure: "model-only" as const } : tool));
}
