/** 사용자별 도구 조립 — 런타임과 계약 테스트가 같은 등록 경로를 사용한다. */
import { createLedgerTools, LEDGER_TOOL_NAMES } from "@alphafolio/ledger/tools";
import { createBrokerTools, BROKER_TOOL_NAMES } from "@alphafolio/broker/tools";
import { createOrderTools, ORDER_TOOL_NAMES } from "@alphafolio/broker/order-tools";
import { createDataTools, DATA_TOOL_NAMES } from "@alphafolio/broker/data-tools";
import { createStreamTools, STREAM_TOOL_NAMES } from "@alphafolio/broker/stream-tools";
import { createDerivativesTools, DERIVATIVES_TOOL_NAMES } from "@alphafolio/broker/derivatives-tools";
import { createMcpTools, MCP_TOOL_NAMES } from "@alphafolio/mcp/tools";
import { createWatchTools, WATCH_TOOL_NAMES } from "@alphafolio/broker/watch-tools";
import type { RuntimeManagerOptions } from "./runtimes.ts";

export const CUSTOM_TOOL_NAMES = [
	...LEDGER_TOOL_NAMES, ...BROKER_TOOL_NAMES, ...ORDER_TOOL_NAMES, ...DATA_TOOL_NAMES,
	...STREAM_TOOL_NAMES, ...DERIVATIVES_TOOL_NAMES, ...MCP_TOOL_NAMES, ...WATCH_TOOL_NAMES,
] as const;

type ToolOptions = Pick<RuntimeManagerOptions,
	"ledgerConfig" | "brokerAccess" | "naverCreds" | "dataCreds" | "prepareOrder" |
	"mcpServers" | "mcpFetch" | "prepareMcpWrite" | "watch"
>;

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
	];
}
