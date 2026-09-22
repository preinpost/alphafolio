/**
 * /api/ledger — 에이전트를 거치지 않는 CRUD 경로 (PLAN.md §3.2).
 *
 * 에이전트 툴(ledger_*)과 **같은 repo**를 호출한다. 비즈니스 로직이 한 곳에만 있도록
 * 여기서는 HTTP ↔ repo 변환만 한다.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	addTransaction,
	budgetStatus,
	deleteTransaction,
	ensureMigrated,
	exportAll,
	listTransactions,
	setBudget,
	summary,
	updateTransaction,
	type D1Config,
	type TxType,
} from "@alphafolio/ledger";

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function num(v: string | null, field: string): number {
	const n = Number(v);
	if (!Number.isInteger(n)) throw new HttpError(400, `${field}는 정수여야 합니다`);
	return n;
}

function required(v: string | null | undefined, field: string): string {
	if (!v) throw new HttpError(400, `${field}가 필요합니다`);
	return v;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > 1_000_000) throw new HttpError(413, "요청 본문이 너무 큽니다");
		chunks.push(buf);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON 파싱 실패");
	}
}

/**
 * D1 설정 공급자 — 서버 기동 시 주입한다.
 * 앱에서 키를 나중에 넣어도 재시작 없이 반영되도록 호출 시점에 조회한다.
 */
let provider: (() => D1Config) | null = null;

export function setLedgerConfigProvider(fn: () => D1Config): void {
	provider = fn;
}

async function cfg(): Promise<D1Config> {
	if (!provider) throw new HttpError(503, "가계부 설정 공급자가 초기화되지 않았습니다");
	const resolved = provider();
	await ensureMigrated(resolved);
	return resolved;
}

/**
 * 가계부 라우트. 처리했으면 결과를, 라우트가 아니면 undefined를 돌려준다.
 * 경로는 /api/ledger 이후만 본다.
 */
export async function handleLedger(
	req: IncomingMessage,
	url: URL,
	rest: string,
	/** 인증된 사용자 = 기록자. 가계부는 가구 공유지만 귀속은 남긴다. */
	member: string,
): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	const q = url.searchParams;

	// GET /api/ledger/transactions?from&to&category&type&limit
	if (rest === "/transactions" && method === "GET") {
		return listTransactions((await cfg()), {
			from: q.get("from") ?? undefined,
			to: q.get("to") ?? undefined,
			category: q.get("category") ?? undefined,
			// scope=mine 이면 본인 기록만, 기본은 가구 전체
			member: q.get("scope") === "mine" ? member : undefined,
			type: (q.get("type") as TxType | null) ?? undefined,
			limit: q.has("limit") ? num(q.get("limit"), "limit") : undefined,
			offset: q.has("offset") ? num(q.get("offset"), "offset") : undefined,
		});
	}

	// POST /api/ledger/transactions
	if (rest === "/transactions" && method === "POST") {
		const body = await readJson(req);
		return addTransaction((await cfg()), {
			date: required(body.date as string, "date"),
			amount: Number(body.amount),
			type: (body.type as TxType) ?? "expense",
			category: body.category as string | undefined,
			merchant: body.merchant as string | undefined,
			memo: body.memo as string | undefined,
			account: body.account as string | undefined,
			member,
			source: "manual",
		});
	}

	// PATCH / DELETE /api/ledger/transactions/:id
	if (rest.startsWith("/transactions/")) {
		const id = rest.slice("/transactions/".length);
		if (!id) throw new HttpError(400, "id가 필요합니다");

		if (method === "PATCH") {
			const body = await readJson(req);
			return updateTransaction((await cfg()), id, {
				date: body.date as string | undefined,
				amount: body.amount === undefined ? undefined : Number(body.amount),
				type: body.type as TxType | undefined,
				category: body.category as string | undefined,
				merchant: body.merchant as string | undefined,
				memo: body.memo as string | undefined,
				account: body.account as string | undefined,
			});
		}
		if (method === "DELETE") {
			return { deleted: await deleteTransaction((await cfg()), id) };
		}
	}

	// GET /api/ledger/summary?from&to&groupBy
	if (rest === "/summary" && method === "GET") {
		return summary((await cfg()), {
			from: required(q.get("from"), "from"),
			to: required(q.get("to"), "to"),
			groupBy: (q.get("groupBy") as "category" | "month" | "member" | null) ?? "category",
			member: q.get("scope") === "mine" ? member : undefined,
		});
	}

	// GET /api/ledger/budgets?month  |  PUT /api/ledger/budgets
	if (rest === "/budgets" && method === "GET") {
		return budgetStatus((await cfg()), required(q.get("month"), "month"));
	}
	if (rest === "/budgets" && method === "PUT") {
		const body = await readJson(req);
		return setBudget((await cfg()), {
			month: required(body.month as string, "month"),
			category: required(body.category as string, "category"),
			limit_amt: Number(body.limit_amt ?? body.limit),
		});
	}

	// GET /api/ledger/export — Time Travel이 무료 7일뿐이라 상시 제공 (PLAN.md §7.3)
	if (rest === "/export" && method === "GET") {
		return exportAll(await cfg());
	}

	return undefined;
}

export { readJson };
