/** REST 클라이언트 — Bearer 토큰을 붙이고 401이면 로그아웃시킨다. */
import type {
	ConversationListItem,
	BrokerHolding,
	BrokerOrder,
	LedgerBudgetRow,
	LedgerInviteDto,
	LedgerMemberDto,
	LedgerSummaryRow,
	LedgerTransaction,
	MyLedgerDto,
	QuoteCard,
} from "@alphafolio/protocol";
import { API_BASE, clearToken, getToken } from "./auth.ts";

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** 값이 있는 것만 쿼리스트링으로 */
function query(params: Record<string, string | number | undefined>): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
	return q.toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const token = getToken();
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...init.headers,
		},
	});

	if (res.status === 401) {
		// 앱(Keychain)은 삭제가 비동기다 — 끝나기 전에 reload 하면 만료 토큰을 다시 읽는다
		await clearToken();
		location.reload();
		throw new ApiError(401, "인증이 만료되었습니다");
	}

	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	if (!res.ok) throw new ApiError(res.status, body?.error ?? `요청 실패 (HTTP ${res.status})`);
	return body as T;
}

export async function login(user: string, password: string): Promise<string> {
	const res = await fetch(`${API_BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user, password }),
	});
	const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
	if (!res.ok || !body?.token) throw new ApiError(res.status, body?.error ?? "로그인 실패");
	return body.token;
}

export interface SecretStatus {
	name: string;
	label: string;
	group: string;
	hint?: string;
	source: "user" | "env" | "none";
	/** 마스킹된 미리보기 — 원문은 서버가 내려주지 않는다 */
	preview: string | null;
}

export const api = {
	health: () => request<{ ok: boolean; ledger: boolean; model: string }>("/api/health"),

	me: () => request<{ user: string; groups: string[] }>("/api/me"),

	/** 대화 목록 (최근 순) — 응답 중인 대화 표시 포함 */
	sessions: () => request<ConversationListItem[]>("/api/sessions"),

	portfolio: () =>
		request<{
			holdings: BrokerHolding[];
			brokers: string[];
			stockValueKrw: number;
			cashKrw: number;
			profitKrw: number;
			usdKrw: number;
			warnings: string[];
		}>("/api/portfolio"),

	quote: (symbol: string) => request<QuoteCard["quote"]>(`/api/quote?symbol=${encodeURIComponent(symbol)}`),

	// ⚠️ 실제 주문이 나가는 유일한 클라이언트 경로. 확인 카드의 버튼에서만 호출한다.
	executeOrder: (token: string) =>
		request<{ ok: boolean; orderId: string; symbol: string }>("/api/orders/execute", {
			method: "POST",
			body: JSON.stringify({ token }),
		}),

	orders: (status: "OPEN" | "CLOSED" = "OPEN") =>
		request<{ orders: BrokerOrder[] }>(`/api/orders?status=${status}`),

	cancelOrder: (orderId: string) =>
		request<{ ok: boolean }>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" }),

	secrets: () =>
		request<{ items: SecretStatus[]; ephemeralMaster: boolean; storageReady: boolean; undecryptable: number }>(
			"/api/secrets",
		),

	setSecret: (name: string, value: string) =>
		request<{ items: SecretStatus[] }>("/api/secrets", { method: "PUT", body: JSON.stringify({ name, value }) }),

	deleteSecret: (name: string) =>
		request<{ items: SecretStatus[] }>(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),

	testD1: () => request<{ ok: boolean; message: string }>("/api/secrets/test/d1", { method: "POST" }),

	// ── 가계부 (ledgerId 를 비우면 서버가 기본 가계부를 고른다) ─────────────
	transactions: (
		ledgerId: string | undefined,
		params: { from?: string; to?: string; category?: string; limit?: number; scope?: "household" | "mine" },
	) => request<LedgerTransaction[]>(`/api/ledger/transactions?${query({ ...params, ledger: ledgerId })}`),

	addTransaction: (
		ledgerId: string | undefined,
		tx: {
			date: string;
			amount: number;
			type: "expense" | "income";
			category?: string;
			merchant?: string;
			memo?: string;
		},
	) =>
		request<LedgerTransaction>(`/api/ledger/transactions?${query({ ledger: ledgerId })}`, {
			method: "POST",
			body: JSON.stringify(tx),
		}),

	/** 거래 id 로 서버가 가계부를 찾는다 (내가 멤버인 가계부의 거래만) */
	deleteTransaction: (id: string) =>
		request<{ deleted: boolean }>(`/api/ledger/transactions/${encodeURIComponent(id)}`, { method: "DELETE" }),

	summary: (
		ledgerId: string | undefined,
		from: string,
		to: string,
		groupBy: "category" | "month" | "member" = "category",
		scope?: "household" | "mine",
	) =>
		request<LedgerSummaryRow[]>(
			`/api/ledger/summary?${query({ ledger: ledgerId, from, to, groupBy, scope: scope === "mine" ? "mine" : undefined })}`,
		),

	budgets: (ledgerId: string | undefined, month: string) =>
		request<LedgerBudgetRow[]>(`/api/ledger/budgets?${query({ ledger: ledgerId, month })}`),

	setBudget: (ledgerId: string | undefined, month: string, category: string, limit: number) =>
		request<unknown>(`/api/ledger/budgets?${query({ ledger: ledgerId })}`, {
			method: "PUT",
			body: JSON.stringify({ month, category, limit_amt: limit }),
		}),

	exportLedger: (ledgerId: string) => request<unknown>(`/api/ledger/export?${query({ ledger: ledgerId })}`),

	// ── 가계부 관리 · 초대 (앱 화면 전용 — 에이전트 툴에는 없다) ────────────
	ledgers: () => request<{ ledgers: MyLedgerDto[]; invites: LedgerInviteDto[] }>("/api/ledgers"),

	createLedger: (name: string) =>
		request<MyLedgerDto>("/api/ledgers", { method: "POST", body: JSON.stringify({ name }) }),

	renameLedger: (id: string, name: string) =>
		request<unknown>(`/api/ledgers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),

	deleteLedger: (id: string, confirmName: string) =>
		request<unknown>(`/api/ledgers/${encodeURIComponent(id)}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmName }),
		}),

	setDefaultLedger: (id: string) =>
		request<unknown>(`/api/ledgers/${encodeURIComponent(id)}/default`, { method: "POST" }),

	transferLedger: (id: string, to: string) =>
		request<unknown>(`/api/ledgers/${encodeURIComponent(id)}/owner`, { method: "POST", body: JSON.stringify({ to }) }),

	ledgerMembers: (id: string) =>
		request<{ members: LedgerMemberDto[]; invites: LedgerInviteDto[] }>(`/api/ledgers/${encodeURIComponent(id)}/members`),

	/** 소유자가 내보내기 — 본인 이름이면 나가기 */
	removeLedgerMember: (id: string, member: string) =>
		request<unknown>(`/api/ledgers/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}`, {
			method: "DELETE",
		}),

	inviteToLedger: (id: string, invitee: string) =>
		request<LedgerInviteDto>(`/api/ledgers/${encodeURIComponent(id)}/invites`, {
			method: "POST",
			body: JSON.stringify({ invitee }),
		}),

	respondInvite: (inviteId: string, accept: boolean) =>
		request<unknown>(`/api/invites/${encodeURIComponent(inviteId)}/${accept ? "accept" : "decline"}`, { method: "POST" }),

	revokeInvite: (inviteId: string) =>
		request<unknown>(`/api/invites/${encodeURIComponent(inviteId)}/revoke`, { method: "POST" }),
};
