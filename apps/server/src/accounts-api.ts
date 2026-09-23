/**
 * 계정 REST — 내 계정(/api/me/*)과 관리자(/api/admin/*) (PLAN §25).
 * 권한 판단은 AccountStore 에 있다. 여기서는 HTTP ↔ 스토어 변환만 한다.
 */
import type { IncomingMessage } from "node:http";
import type { AccountStore } from "./accounts.ts";
import { readJson } from "./ledger-api.ts";

export async function handleAccounts(
	req: IncomingMessage,
	path: string,
	user: string,
	accounts: AccountStore,
	/** 토큰 버전이 바뀐 뒤 이 기기에 줄 새 토큰 */
	issueToken: (name: string) => string,
): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	const seg = path.split("/").filter(Boolean).slice(1).map((x) => decodeURIComponent(x)); // ["me"|"admin", ...]

	if (seg[0] === "me" && method === "POST") {
		// POST /api/me/password { current, next } — 다른 기기 로그인은 끊기고 이 기기는 새 토큰으로 이어간다
		if (seg[1] === "password") {
			const body = await readJson(req);
			await accounts.changePassword(user, String(body.current ?? ""), String(body.next ?? ""));
			return { token: issueToken(user) };
		}
		// POST /api/me/logout-all
		if (seg[1] === "logout-all") {
			await accounts.logoutAll(user);
			return { token: issueToken(user) };
		}
	}

	if (seg[0] === "admin") {
		const [, kind, id, action] = seg;
		// GET/POST /api/admin/invites, POST /api/admin/invites/:id/revoke
		if (kind === "invites" && !id && method === "GET") return accounts.listInvites(user);
		if (kind === "invites" && !id && method === "POST") {
			const body = await readJson(req);
			return accounts.createInvite(user, {
				note: typeof body.note === "string" ? body.note : undefined,
				days: typeof body.days === "number" ? body.days : undefined,
			});
		}
		if (kind === "invites" && id && action === "revoke" && method === "POST") {
			await accounts.revokeInvite(user, id);
			return { ok: true };
		}
		// GET /api/admin/users, POST /api/admin/users/:name/disable | enable | reset-password
		if (kind === "users" && !id && method === "GET") return accounts.listAccounts(user);
		if (kind === "users" && id && method === "POST") {
			if (action === "disable" || action === "enable") {
				await accounts.setDisabled(user, id, action === "disable");
				return { ok: true };
			}
			if (action === "reset-password") return { password: await accounts.resetPassword(user, id) };
		}
	}
	return undefined;
}
