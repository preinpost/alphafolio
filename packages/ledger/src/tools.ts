/**
 * 가계부 에이전트 툴 (ledger_*) — repo.ts 위의 얇은 래퍼.
 *
 * 설계 규칙 (PLAN.md §7.2, §7.4):
 *   1. raw SQL 툴을 만들지 않는다. 툴은 구조화된 인자만 받고 SQL은 repo에 있는 리터럴만 쓴다.
 *   2. content(LLM이 읽는 텍스트)에는 집계·요약만 넣고, 원시 내역은 details로 UI에만 보낸다.
 *      → 토큰 절약 + 거래 내역이 프롬프트에 통째로 올라가는 것을 막는다.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { D1Config } from "./d1.ts";
import { ensureMigrated } from "./schema.ts";
import { currentMonthKST, dateFromDaysAgo, resolvePeriod, todayKST, type Period } from "./dates.ts";
import {
	addTransaction,
	budgetStatus,
	deleteTransaction,
	ledgerOfTransaction,
	listTransactions,
	setBudget,
	summary,
	updateTransaction,
} from "./repo.ts";
import { resolveLedger, type MyLedger } from "./ledgers.ts";
import type { BudgetStatus, SummaryRow, Transaction, TxType } from "./types.ts";

/**
 * details 페이로드 계약 — 웹/모바일 카드 렌더러가 이 모양에 의존한다.
 * 분기마다 모양이 달라지면 defineTool의 추론이 깨지므로 키를 고정하고
 * 비어 있는 값은 null/[]로 채운다.
 */
export interface LedgerTxDetails {
	kind: "ledger-tx";
	ledgerName: string;
	tx: Transaction;
}
export interface LedgerSummaryDetails {
	kind: "ledger-summary";
	ledgerName: string;
	from: string;
	to: string;
	groupBy: "category" | "month" | "member";
	rows: SummaryRow[];
}
export interface LedgerTableDetails {
	kind: "ledger-table";
	ledgerName: string;
	rows: Transaction[];
}
export interface LedgerDeleteDetails {
	kind: "ledger-delete";
	id: string;
	deleted: boolean;
}
export interface LedgerBudgetDetails {
	kind: "ledger-budget";
	ledgerName: string;
	action: "set" | "status";
	month: string;
	category: string | null;
	limit: number | null;
	rows: BudgetStatus[];
}

const won = (n: number): string => `${n.toLocaleString("ko-KR")}원`;

/**
 * 기간 열거형. Type.Union(PERIODS.map(...)) 은 typebox 타입 추론이 과도하게 깊어져
 * TS2589가 나므로 리터럴을 직접 나열한다.
 */
const PERIOD_ENUM = Type.Union(
	[
		Type.Literal("today"),
		Type.Literal("yesterday"),
		Type.Literal("this_week"),
		Type.Literal("this_month"),
		Type.Literal("last_month"),
		Type.Literal("last_7d"),
		Type.Literal("last_30d"),
		Type.Literal("this_year"),
	],
	{ description: "조회 기간 (기본 this_month)" },
);

/**
 * 날짜 인자 해석 — 상대 표현(daysAgo)을 산출 시점의 서버 시계로 바꾼다.
 * 달력상 날짜를 모델이 추측하지 않게 하는 것이 핵심 (dates.ts 주석 참고).
 */
function resolveDate(params: { date?: string; daysAgo?: number }): string {
	if (params.daysAgo !== undefined) return dateFromDaysAgo(params.daysAgo);
	if (params.date) return params.date;
	return todayKST();
}

/** 기간 인자 해석 — period 우선, 없으면 from/to, 둘 다 없으면 이번 달. */
function resolveRange(params: { period?: string; from?: string; to?: string }): { from: string; to: string } {
	if (params.period) return resolvePeriod(params.period as Period);
	if (params.from && params.to) return { from: params.from, to: params.to };
	return resolvePeriod("this_month");
}

/**
 * 어느 가계부에 쓸지 — 모든 툴 공통 인자.
 * 이름만 받는다 (모델이 id 를 외우게 하지 않는다). 비우면 사용자의 기본 가계부.
 */
const LEDGER_PARAM = Type.Optional(
	Type.String({
		description:
			"대상 가계부 이름 (예: '우리집'). 사용자가 특정 가계부를 말했을 때만 넣는다 — 비우면 기본 가계부",
	}),
);

/**
 * 가계부 툴 생성.
 *
 * 거래·예산은 **사용자가 멤버인 가계부** 에만 읽고 쓴다 (PLAN §23 — ledgers.resolveLedger).
 * 기록자(member)도 모델이 정하지 않는다 — 인증된 사용자가 곧 기록자다.
 * 가계부 만들기·초대·수락·내보내기는 툴로 만들지 않는다 (앱 화면 전용 — 외부 텍스트 주입 방어).
 */
export type D1Provider = () => D1Config;

export function createLedgerTools(provider: D1Provider, member: string) {
	/**
	 * 호출 시점에 설정을 읽는다 — 앱에서 키를 나중에 넣어도 재시작 없이 동작해야 한다.
	 * 미설정이면 여기서 안내 메시지와 함께 throw 되고, 툴 오류로 사용자에게 전달된다.
	 */
	const ready = async (): Promise<D1Config> => {
		const cfg = provider();
		await ensureMigrated(cfg);
		return cfg;
	};

	/** 설정 + 대상 가계부 (내가 멤버인 것만 고를 수 있다) */
	const open = async (ref: string | undefined): Promise<{ cfg: D1Config; ledger: MyLedger }> => {
		const cfg = await ready();
		return { cfg, ledger: await resolveLedger(cfg, member, ref) };
	};

	/** 수정·삭제 — 거래 id 로 가계부를 찾되, 내가 멤버인 가계부의 거래만 */
	const openByTx = async (id: string): Promise<{ cfg: D1Config; ledgerId: string; ledgerName: string }> => {
		const cfg = await ready();
		const ledgerId = await ledgerOfTransaction(cfg, member, id);
		if (!ledgerId) throw new Error(`거래를 찾을 수 없습니다: ${id}`);
		const ledger = await resolveLedger(cfg, member, ledgerId);
		return { cfg, ledgerId, ledgerName: ledger.name };
	};

	const ledgerAdd = defineTool({
		name: "ledger_add",
		label: "가계부 기록",
		description:
			"가계부에 거래 한 건을 기록한다. 사용자가 자연어로 말한 지출/수입을 구조화해서 넣는다. " +
			`날짜를 말하지 않으면 오늘(${todayKST()})로 본다. 금액은 원 단위 양수 정수이고 수입/지출은 type으로 구분한다.`,
		parameters: Type.Object({
			date: Type.String({ description: "거래 날짜 YYYY-MM-DD" }),
			amount: Type.Integer({ description: "금액 (원 단위 양수 정수)" }),
			type: Type.Union([Type.Literal("expense"), Type.Literal("income")], {
				description: "expense=지출, income=수입",
			}),
			category: Type.Optional(Type.String({ description: "카테고리 (예: 식비, 교통, 월급)" })),
			merchant: Type.Optional(Type.String({ description: "가맹점/거래처 (예: 김밥천국)" })),
			memo: Type.Optional(Type.String({ description: "메모" })),
			account: Type.Optional(Type.String({ description: "결제 수단 (예: 현금, 신한카드)" })),
			ledger: LEDGER_PARAM,
		}),
		execute: async (_id, params) => {
			const { cfg, ledger } = await open(params.ledger);
			const tx = await addTransaction(cfg, ledger.id, {
				date: params.date,
				amount: params.amount,
				type: params.type as TxType,
				category: params.category,
				merchant: params.merchant,
				memo: params.memo,
				account: params.account,
				member,
				source: "agent",
			});
			const label = params.type === "expense" ? "지출" : "수입";
			return {
				content: [
					{
						type: "text" as const,
						text: `[${ledger.name}] 기록 완료 — ${tx.date} ${label} ${won(params.amount)}${tx.category ? ` (${tx.category})` : ""}${tx.merchant ? ` @${tx.merchant}` : ""}`,
					},
				],
				details: { kind: "ledger-tx", ledgerName: ledger.name, tx },
			};
		},
	});

	const ledgerSummary = defineTool({
		name: "ledger_summary",
		label: "가계부 집계",
		description:
			"기간별 수입/지출을 집계한다. 카테고리별 또는 월별로 묶을 수 있다. " +
			"'이번 달 얼마 썼어', '식비 얼마야' 같은 질문에는 내역을 나열하지 말고 이 툴을 쓴다. " +
			"가계부는 멤버끼리 공유된다 — 기본은 가계부 전체 합계이고, '내 지출만' 같은 요청에는 scope=mine 을 쓴다. " +
			"⚠️ 날짜를 직접 계산하지 말고 period를 쓴다 (기본 this_month). " +
			"사용자가 절대 기간을 명시했을 때만 from/to를 쓴다.",
		parameters: Type.Object({
			period: Type.Optional(PERIOD_ENUM),
			from: Type.Optional(Type.String({ description: "시작일 YYYY-MM-DD (period 대신 쓸 때)" })),
			to: Type.Optional(Type.String({ description: "종료일 YYYY-MM-DD (period 대신 쓸 때)" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("household"), Type.Literal("mine")], {
					description: "household=가계부 전체(기본), mine=내가 기록한 것만",
				}),
			),
			ledger: LEDGER_PARAM,
			groupBy: Type.Optional(
				Type.Union([Type.Literal("category"), Type.Literal("month"), Type.Literal("member")], {
					description: "category=카테고리별(기본), month=월별, member=사람별",
				}),
			),
		}),
		execute: async (_id, params) => {
			const groupBy = (params.groupBy as "category" | "month" | "member" | undefined) ?? "category";
			const { from, to } = resolveRange(params);
			const scopedMember = params.scope === "mine" ? member : undefined;
			const { cfg, ledger } = await open(params.ledger);
			const rows = await summary(cfg, ledger.id, { from, to, groupBy, member: scopedMember });
			const details: LedgerSummaryDetails = { kind: "ledger-summary", ledgerName: ledger.name, from, to, groupBy, rows };

			if (rows.length === 0) {
				return {
					content: [{ type: "text" as const, text: `[${ledger.name}] ${from} ~ ${to} 기간에 기록이 없습니다.` }],
					details,
				};
			}

			const income = rows.reduce((s, r) => s + r.income, 0);
			const expense = rows.reduce((s, r) => s + r.expense, 0);
			const lines = rows.map((r) => `- ${r.key}: 지출 ${won(r.expense)}${r.income > 0 ? ` / 수입 ${won(r.income)}` : ""} (${r.count}건)`);

			return {
				content: [
					{
						type: "text" as const,
						text: `[${ledger.name}] ${from} ~ ${to}\n총 지출 ${won(expense)} / 총 수입 ${won(income)} / 순증감 ${won(income - expense)}\n\n${lines.join("\n")}`,
					},
				],
				details,
			};
		},
	});

	const ledgerList = defineTool({
		name: "ledger_list",
		label: "가계부 내역",
		description:
			"거래 내역을 조회한다. 사용자가 개별 거래를 직접 확인하거나 수정·삭제할 대상을 찾을 때만 쓴다. " +
			"금액 합계가 궁금한 것이면 ledger_summary를 쓴다. " +
			"⚠️ 날짜를 직접 계산하지 말고 period를 쓴다 (기본 this_month).",
		parameters: Type.Object({
			period: Type.Optional(PERIOD_ENUM),
			from: Type.Optional(Type.String({ description: "시작일 YYYY-MM-DD (period 대신 쓸 때)" })),
			to: Type.Optional(Type.String({ description: "종료일 YYYY-MM-DD (period 대신 쓸 때)" })),
			category: Type.Optional(Type.String({ description: "카테고리 필터" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("household"), Type.Literal("mine")], {
					description: "household=가계부 전체(기본), mine=내가 기록한 것만",
				}),
			),
			ledger: LEDGER_PARAM,
			type: Type.Optional(Type.Union([Type.Literal("expense"), Type.Literal("income")])),
			limit: Type.Optional(Type.Integer({ description: "최대 건수 (기본 50, 최대 500)" })),
		}),
		execute: async (_id, params) => {
			const range = resolveRange(params);
			const { cfg, ledger } = await open(params.ledger);
			const rows = await listTransactions(cfg, ledger.id, {
				from: range.from,
				to: range.to,
				category: params.category,
				member: params.scope === "mine" ? member : undefined,
				type: params.type as TxType | undefined,
				limit: params.limit,
			});

			// content에는 건수와 합계만. 원시 내역은 details로 UI에만 전달한다.
			const expense = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
			const preview = rows
				.slice(0, 10)
				.map((r) => `- ${r.date} ${r.amount < 0 ? "-" : "+"}${won(Math.abs(r.amount))} ${r.category ?? ""} ${r.merchant ?? ""} [${r.id}]`.trimEnd());

			return {
				content: [
					{
						type: "text" as const,
						text:
							`[${ledger.name}] ${rows.length}건 (지출 합계 ${won(expense)})` +
							(preview.length > 0 ? `\n\n${preview.join("\n")}` : "") +
							(rows.length > preview.length ? `\n… 외 ${rows.length - preview.length}건 (화면에 표시됨)` : ""),
					},
				],
				details: { kind: "ledger-table", ledgerName: ledger.name, rows },
			};
		},
	});

	const ledgerUpdate = defineTool({
		name: "ledger_update",
		label: "가계부 수정",
		description: "기존 거래를 수정한다. id는 ledger_list로 먼저 찾는다.",
		parameters: Type.Object({
			id: Type.String({ description: "거래 id (ULID)" }),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
			amount: Type.Optional(Type.Integer({ description: "금액 (원 단위 양수 정수)" })),
			type: Type.Optional(Type.Union([Type.Literal("expense"), Type.Literal("income")])),
			category: Type.Optional(Type.String()),
			merchant: Type.Optional(Type.String()),
			memo: Type.Optional(Type.String()),
			account: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			const { cfg, ledgerId, ledgerName } = await openByTx(params.id);
			const tx = await updateTransaction(cfg, ledgerId, params.id, {
				date: params.date,
				amount: params.amount,
				type: params.type as TxType | undefined,
				category: params.category,
				merchant: params.merchant,
				memo: params.memo,
				account: params.account,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `[${ledgerName}] 수정 완료 — ${tx.date} ${tx.amount < 0 ? "지출" : "수입"} ${won(Math.abs(tx.amount))}${tx.category ? ` (${tx.category})` : ""}`,
					},
				],
				details: { kind: "ledger-tx", ledgerName, tx },
			};
		},
	});

	const ledgerDelete = defineTool({
		name: "ledger_delete",
		label: "가계부 삭제",
		description: "거래를 삭제한다. 되돌릴 수 없으므로 사용자가 명시적으로 요청했을 때만 호출한다.",
		parameters: Type.Object({
			id: Type.String({ description: "거래 id (ULID)" }),
		}),
		execute: async (_id, params) => {
			// 내 가계부에 없는 id 는 "없음" 으로 답한다 (남의 가계부 거래인지 흘리지 않는다)
			const cfg = await ready();
			const ledgerId = await ledgerOfTransaction(cfg, member, params.id);
			const ok = ledgerId !== null && (await deleteTransaction(cfg, ledgerId, params.id));
			return {
				content: [{ type: "text" as const, text: ok ? `삭제됨 (${params.id})` : `해당 id가 없습니다 (${params.id})` }],
				details: { kind: "ledger-delete", id: params.id, deleted: ok },
			};
		},
	});

	const ledgerBudget = defineTool({
		name: "ledger_budget",
		label: "예산",
		description: "월별 카테고리 예산을 설정하거나(set) 소진 현황을 조회한다(status).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("status")], {
				description: "set=예산 설정, status=소진 현황",
			}),
			month: Type.Optional(Type.String({ description: "대상 월 YYYY-MM. 생략하면 이번 달 (직접 계산하지 말 것)" })),
			category: Type.Optional(Type.String({ description: "action=set일 때 필수" })),
			limit: Type.Optional(Type.Integer({ description: "action=set일 때 필수 — 예산 한도(원)" })),
			ledger: LEDGER_PARAM,
		}),
		execute: async (_id, params) => {
			const action = params.action as "set" | "status";
			const month = params.month ?? currentMonthKST();
			const { cfg, ledger } = await open(params.ledger);

			if (action === "set") {
				if (!params.category || params.limit === undefined) {
					throw new Error("예산을 설정하려면 category와 limit이 모두 필요합니다.");
				}
				await setBudget(cfg, ledger.id, { month: month, category: params.category, limit_amt: params.limit });
				const details: LedgerBudgetDetails = {
					kind: "ledger-budget",
					ledgerName: ledger.name,
					action,
					month: month,
					category: params.category,
					limit: params.limit,
					rows: await budgetStatus(cfg, ledger.id, month),
				};
				return {
					content: [{ type: "text" as const, text: `[${ledger.name}] ${month} ${params.category} 예산 ${won(params.limit)} 설정` }],
					details,
				};
			}

			const rows = await budgetStatus(cfg, ledger.id, month);
			const details: LedgerBudgetDetails = {
				kind: "ledger-budget",
				ledgerName: ledger.name,
				action,
				month: month,
				category: null,
				limit: null,
				rows,
			};

			if (rows.length === 0) {
				return {
					content: [{ type: "text" as const, text: `[${ledger.name}] ${month}에 설정된 예산이 없습니다.` }],
					details,
				};
			}
			const lines = rows.map(
				(r) => `- ${r.category}: ${won(r.spent)} / ${won(r.limit_amt)} (${r.usedPct}%)${r.remaining < 0 ? " ⚠️ 초과" : ""}`,
			);
			return {
				content: [{ type: "text" as const, text: `[${ledger.name}] ${month} 예산 현황\n${lines.join("\n")}` }],
				details,
			};
		},
	});

	return [ledgerAdd, ledgerSummary, ledgerList, ledgerUpdate, ledgerDelete, ledgerBudget];
}

export const LEDGER_TOOL_NAMES = [
	"ledger_add",
	"ledger_summary",
	"ledger_list",
	"ledger_update",
	"ledger_delete",
	"ledger_budget",
] as const;
