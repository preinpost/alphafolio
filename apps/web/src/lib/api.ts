/** REST 클라이언트 — Bearer 토큰을 붙이고 401이면 로그아웃시킨다. */
import type {
	BrokerHolding,
	BrokerOrder,
	LedgerBudgetRow,
	LedgerSummaryRow,
	LedgerTransaction,
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

	transactions: (params: { from?: string; to?: string; category?: string; limit?: number; scope?: "household" | "mine" }) => {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
		return request<LedgerTransaction[]>(`/api/ledger/transactions?${q}`);
	},

	addTransaction: (tx: {
		date: string;
		amount: number;
		type: "expense" | "income";
		category?: string;
		merchant?: string;
		memo?: string;
	}) => request<LedgerTransaction>("/api/ledger/transactions", { method: "POST", body: JSON.stringify(tx) }),

	deleteTransaction: (id: string) =>
		request<{ deleted: boolean }>(`/api/ledger/transactions/${id}`, { method: "DELETE" }),

	summary: (from: string, to: string, groupBy: "category" | "month" | "member" = "category", scope?: "household" | "mine") =>
		request<LedgerSummaryRow[]>(
			`/api/ledger/summary?from=${from}&to=${to}&groupBy=${groupBy}${scope === "mine" ? "&scope=mine" : ""}`,
		),

	budgets: (month: string) => request<LedgerBudgetRow[]>(`/api/ledger/budgets?month=${month}`),

	setBudget: (month: string, category: string, limit: number) =>
		request<unknown>("/api/ledger/budgets", {
			method: "PUT",
			body: JSON.stringify({ month, category, limit_amt: limit }),
		}),
};
