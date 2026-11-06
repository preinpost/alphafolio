/**
 * /api/ledger — 에이전트를 거치지 않는 CRUD 경로 (PLAN.md §3.2).
 *
 * 에이전트 툴(ledger_*)과 **같은 repo**를 호출한다. 비즈니스 로직이 한 곳에만 있도록
 * 여기서는 HTTP ↔ repo 변환만 한다.
 */
import type { IncomingMessage } from "node:http";
import { Type } from "typebox";
import {
	addTransaction,
	budgetStatus,
	createLedger,
	deleteLedger,
	deleteTransaction,
	ensureMigrated,
	exportAll,
	inviteMember,
	LedgerValidationError,
	ledgerOfTransaction,
	listIncomingInvites,
	listLedgerInvites,
	listMembers,
	listMyLedgers,
	listTransactions,
	removeMember,
	renameLedger,
	resolveLedger,
	respondInvite,
	revokeInvite,
	setBudget,
	setDefaultLedger,
	summary,
	transferOwnership,
	updateTransaction,
	type D1Config,
	type TxType,
} from "@alphafolio/ledger";
import { HttpError, readBody, readJson } from "./http.ts";

export { HttpError, readJson };

function num(v: string | null, field: string): number {
	const n = Number(v);
	if (!Number.isInteger(n)) throw new HttpError(400, `${field}는 정수여야 합니다`);
	return n;
}

function required(v: string | null | undefined, field: string): string {
	if (!v) throw new HttpError(400, `${field}가 필요합니다`);
	return v;
}


// ── 본문 스키마 ─────────────────────────────────────────────────
// 형식만 본다 (문자열인가·숫자인가). 날짜·월·유형 같은 값 규칙은 도메인(LedgerValidationError)에 있다.
// 금액은 앱이 문자열로 보내던 경우가 있어 숫자 문자열도 받는다 (Number() 로 바꿔 도메인이 검사).
const Amount = Type.Union([Type.Number(), Type.String()]);
const OptStr = Type.Optional(Type.String());
const TxCreateBody = Type.Object({
	date: Type.String(),
	amount: Amount,
	type: OptStr,
	category: OptStr,
	merchant: OptStr,
	memo: OptStr,
	account: OptStr,
});
const TxPatchBody = Type.Object({
	date: OptStr,
	amount: Type.Optional(Amount),
	type: OptStr,
	category: OptStr,
	merchant: OptStr,
	memo: OptStr,
	account: OptStr,
});
const BudgetBody = Type.Object({
	month: Type.String(),
	category: Type.String(),
	limit_amt: Type.Optional(Amount),
	limit: Type.Optional(Amount),
});
const NameBody = Type.Object({ name: Type.String() });
const DeleteLedgerBody = Type.Object({ confirmName: Type.String() });
const OwnerBody = Type.Object({ to: Type.String() });
const InviteBody = Type.Object({ invitee: Type.String() });

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
 *
 * 대상 가계부는 `?ledger=<id>` (없으면 기본 가계부). 멤버가 아닌 가계부는 404 —
 * resolveLedger 가 멤버십으로만 고르기 때문이다 (PLAN §23).
 */
export async function handleLedger(
	req: IncomingMessage,
	url: URL,
	rest: string,
	/** 인증된 사용자 = 기록자. */
	member: string,
): Promise<unknown | undefined> {
	try {
		return await handleLedgerRequest(req, url, rest, member);
	} catch (err) {
		if (err instanceof LedgerValidationError) throw new HttpError(400, err.message);
		throw err;
	}
}

async function handleLedgerRequest(req: IncomingMessage, url: URL, rest: string, member: string): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	const q = url.searchParams;
	/** 대상 가계부 id — 내가 멤버인 것만 */
	const ledger = async (c: D1Config): Promise<string> => (await resolveLedger(c, member, q.get("ledger"))).id;
	/** 거래 id 로 가계부 찾기 — 남의 가계부 거래면 404 */
	const ledgerOf = async (c: D1Config, id: string): Promise<string> => {
		const found = await ledgerOfTransaction(c, member, id);
		if (!found) throw new HttpError(404, `거래를 찾을 수 없습니다: ${id}`);
		return found;
	};

	// GET /api/ledger/transactions?from&to&category&type&limit
	if (rest === "/transactions" && method === "GET") {
		const c = await cfg();
		return listTransactions(c, await ledger(c), {
			from: q.get("from") ?? undefined,
			to: q.get("to") ?? undefined,
			category: q.get("category") ?? undefined,
			// scope=mine 이면 본인 기록만, 기본은 가계부 전체
			member: q.get("scope") === "mine" ? member : undefined,
			type: (q.get("type") as TxType | null) ?? undefined,
			limit: q.has("limit") ? num(q.get("limit"), "limit") : undefined,
			offset: q.has("offset") ? num(q.get("offset"), "offset") : undefined,
		});
	}

	// POST /api/ledger/transactions
	if (rest === "/transactions" && method === "POST") {
		const body = await readBody(req, TxCreateBody);
		const c = await cfg();
		return addTransaction(c, await ledger(c), {
			date: required(body.date, "date"),
			amount: Number(body.amount),
			type: body.type === undefined ? "expense" : (body.type as TxType),
			category: body.category,
			merchant: body.merchant,
			memo: body.memo,
			account: body.account,
			member,
			source: "manual",
		});
	}

	// PATCH / DELETE /api/ledger/transactions/:id
	if (rest.startsWith("/transactions/")) {
		const id = rest.slice("/transactions/".length);
		if (!id) throw new HttpError(400, "id가 필요합니다");

		if (method === "PATCH") {
			const body = await readBody(req, TxPatchBody);
			const c = await cfg();
			return updateTransaction(c, await ledgerOf(c, id), id, {
				date: body.date,
				amount: body.amount === undefined ? undefined : Number(body.amount),
				type: body.type as TxType | undefined,
				category: body.category,
				merchant: body.merchant,
				memo: body.memo,
				account: body.account,
			});
		}
		if (method === "DELETE") {
			const c = await cfg();
			return { deleted: await deleteTransaction(c, await ledgerOf(c, id), id) };
		}
	}

	// GET /api/ledger/summary?from&to&groupBy
	if (rest === "/summary" && method === "GET") {
		const c = await cfg();
		return summary(c, await ledger(c), {
			from: required(q.get("from"), "from"),
			to: required(q.get("to"), "to"),
			groupBy: (q.get("groupBy") as "category" | "month" | "member" | null) ?? "category",
			member: q.get("scope") === "mine" ? member : undefined,
		});
	}

	// GET /api/ledger/budgets?month  |  PUT /api/ledger/budgets
	if (rest === "/budgets" && method === "GET") {
		const c = await cfg();
		return budgetStatus(c, await ledger(c), required(q.get("month"), "month"));
	}
	if (rest === "/budgets" && method === "PUT") {
		const body = await readBody(req, BudgetBody);
		const c = await cfg();
		return setBudget(c, await ledger(c), {
			month: required(body.month, "month"),
			category: required(body.category, "category"),
			limit_amt: Number(body.limit_amt ?? body.limit),
		});
	}

	// GET /api/ledger/export — Time Travel이 무료 7일뿐이라 상시 제공 (PLAN.md §7.3)
	if (rest === "/export" && method === "GET") {
		const c = await cfg();
		return exportAll(c, await ledger(c));
	}

	return undefined;
}

/**
 * 가계부 관리 · 초대 — `/api/ledgers/*`, `/api/invites/*` (전체 경로를 받는다).
 *
 * **앱 화면 전용 경로다.** 에이전트 툴에는 없다 — 웹·뉴스 본문에 섞인 "○○를 초대해" 가
 * 가계부를 넘기지 못하게 (주문 확인과 같은 이유, PLAN §18·§23).
 */
export async function handleLedgerAdmin(
	req: IncomingMessage,
	path: string,
	user: string,
	userExists: (name: string) => boolean,
): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	const seg = path.split("/").filter(Boolean).slice(1); // ["ledgers", id, ...] | ["invites", ...]
	const [root, id, sub, target] = seg.map((x) => decodeURIComponent(x));

	if (root === "ledgers") {
		// GET /api/ledgers — 내 가계부 목록 + 받은 초대 (앱 시작·포그라운드 복귀 때 한 번에)
		if (!id && method === "GET") {
			const c = await cfg();
			const [ledgers, invites] = await Promise.all([listMyLedgers(c, user), listIncomingInvites(c, user)]);
			return { ledgers, invites };
		}
		// POST /api/ledgers { name }
		if (!id && method === "POST") {
			const body = await readBody(req, NameBody);
			return createLedger(await cfg(), user, body.name);
		}
		if (!id) return undefined;

		// PATCH /api/ledgers/:id { name }   DELETE /api/ledgers/:id { confirmName }
		if (!sub && method === "PATCH") {
			const body = await readBody(req, NameBody);
			return renameLedger(await cfg(), user, id, body.name);
		}
		if (!sub && method === "DELETE") {
			const body = await readBody(req, DeleteLedgerBody);
			await deleteLedger(await cfg(), user, id, body.confirmName);
			return { deleted: true };
		}
		// POST /api/ledgers/:id/default
		if (sub === "default" && method === "POST") {
			await setDefaultLedger(await cfg(), user, id);
			return { ok: true };
		}
		// POST /api/ledgers/:id/owner { to }
		if (sub === "owner" && method === "POST") {
			const body = await readBody(req, OwnerBody);
			await transferOwnership(await cfg(), user, id, body.to);
			return { ok: true };
		}
		// GET /api/ledgers/:id/members   DELETE /api/ledgers/:id/members/:name (내보내기 / 본인이면 나가기)
		if (sub === "members" && !target && method === "GET") {
			const c = await cfg();
			const [members, invites] = await Promise.all([listMembers(c, user, id), listLedgerInvites(c, user, id)]);
			return { members, invites };
		}
		if (sub === "members" && target && method === "DELETE") {
			await removeMember(await cfg(), user, id, target);
			return { ok: true };
		}
		// POST /api/ledgers/:id/invites { invitee }
		if (sub === "invites" && method === "POST") {
			const body = await readBody(req, InviteBody);
			return inviteMember(await cfg(), user, id, body.invitee, userExists);
		}
		return undefined;
	}

	if (root === "invites") {
		// GET /api/invites — 받은 초대
		if (!id && method === "GET") return listIncomingInvites(await cfg(), user);
		// POST /api/invites/:id/accept | decline | revoke
		if (id && method === "POST" && (sub === "accept" || sub === "decline")) {
			return respondInvite(await cfg(), user, id, sub === "accept");
		}
		if (id && method === "POST" && sub === "revoke") {
			await revokeInvite(await cfg(), user, id);
			return { ok: true };
		}
	}
	return undefined;
}
