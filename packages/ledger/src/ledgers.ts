/**
 * 가계부(ledger) · 멤버 · 초대 — PLAN §23.
 *
 * 가계부를 만들면 UID 가 생기고, 소유자가 다른 사용자를 **앱 안에서** 초대한다.
 * 초대받은 사람이 수락해야 멤버가 되고, 멤버만 그 가계부의 거래·예산을 읽고 쓴다.
 *
 * 규칙
 *   - 권한 판단은 전부 이 파일의 SQL 에 있다. 호출부(REST·툴)는 결과만 쓴다.
 *   - 상태 전이는 "조건부 UPDATE + 바뀐 행 수" 로 한다 — 읽고 나서 쓰면 그 사이에 상태가 바뀔 수 있다.
 *   - 초대·수락·내보내기는 **에이전트 툴로 노출하지 않는다** (웹·뉴스 본문 주입으로 가계부가 넘어가지 않게).
 *     에이전트는 resolveLedger 로 "내가 속한 가계부" 를 고르는 것만 한다.
 */
import { d1Query, type D1Config } from "./d1.ts";
import { ulid } from "./ulid.ts";

export type LedgerRole = "owner" | "member";
export type InviteStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface Ledger {
	id: string;
	name: string;
	owner: string;
	created_at: string;
}

/** 내가 속한 가계부 한 줄 (목록용) */
export interface MyLedger extends Ledger {
	role: LedgerRole;
	memberCount: number;
	isDefault: boolean;
}

export interface LedgerMember {
	member: string;
	role: LedgerRole;
	joined_at: string;
}

export interface LedgerInvite {
	id: string;
	ledger_id: string;
	ledger_name: string;
	inviter: string;
	invitee: string;
	status: InviteStatus;
	created_at: string;
	expires_at: string;
	responded_at: string | null;
}

/** 초대 유효 기간 */
export const INVITE_TTL_DAYS = 14;
const NAME_MAX = 30;

/**
 * 권한·상태 오류. status 는 HTTP 로 그대로 옮길 수 있게 맞춰 둔다.
 * 남의 가계부는 "권한 없음" 이 아니라 "없음(404)" 으로 답한다 — ID 존재 여부를 흘리지 않게.
 */
export class LedgerAccessError extends Error {
	readonly status: 400 | 403 | 404 | 409;
	constructor(status: 400 | 403 | 404 | 409, message: string) {
		super(message);
		this.name = "LedgerAccessError";
		this.status = status;
	}
}

const notFound = (): LedgerAccessError => new LedgerAccessError(404, "가계부를 찾을 수 없습니다");

function cleanName(raw: string): string {
	const name = raw.trim().replace(/\s+/g, " ");
	if (!name) throw new LedgerAccessError(400, "가계부 이름을 입력하세요");
	if ([...name].length > NAME_MAX) throw new LedgerAccessError(400, `가계부 이름은 ${NAME_MAX}자 이내여야 합니다`);
	return name;
}

const now = (): string => new Date().toISOString();

// ── 조회 ────────────────────────────────────────────────────────────────

/** 이 사용자의 역할. 멤버가 아니면 null. */
export async function roleOf(cfg: D1Config, ledgerId: string, user: string): Promise<LedgerRole | null> {
	const r = await d1Query<{ role: LedgerRole }>(
		cfg,
		"SELECT role FROM ledger_members WHERE ledger_id = ? AND member = ?",
		[ledgerId, user],
	);
	return r.results[0]?.role ?? null;
}

/** 멤버여야 한다 — 아니면 404. 소유자 전용이면 owner 를 넘긴다. */
async function requireRole(cfg: D1Config, ledgerId: string, user: string, need: LedgerRole | "any"): Promise<Ledger> {
	const r = await d1Query<Ledger & { role: LedgerRole }>(
		cfg,
		`SELECT l.id, l.name, l.owner, l.created_at, m.role
		 FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
		 WHERE l.id = ? AND m.member = ?`,
		[ledgerId, user],
	);
	const row = r.results[0];
	if (!row) throw notFound();
	if (need === "owner" && row.role !== "owner") throw new LedgerAccessError(403, "가계부 소유자만 할 수 있습니다");
	return { id: row.id, name: row.name, owner: row.owner, created_at: row.created_at };
}

export async function listMyLedgers(cfg: D1Config, user: string): Promise<MyLedger[]> {
	const r = await d1Query<Ledger & { role: LedgerRole; member_count: number; is_default: number }>(
		cfg,
		`SELECT l.id, l.name, l.owner, l.created_at, m.role,
		        (SELECT COUNT(*) FROM ledger_members x WHERE x.ledger_id = l.id) AS member_count,
		        CASE WHEN p.default_ledger_id = l.id THEN 1 ELSE 0 END AS is_default
		 FROM ledger_members m
		 JOIN ledgers l ON l.id = m.ledger_id
		 LEFT JOIN user_prefs p ON p.member = m.member
		 WHERE m.member = ?
		 ORDER BY l.created_at, l.rowid`,
		[user],
	);
	return r.results.map(({ member_count, is_default, ...l }) => ({
		...l,
		memberCount: Number(member_count),
		isDefault: Number(is_default) === 1,
	}));
}

export async function listMembers(cfg: D1Config, user: string, ledgerId: string): Promise<LedgerMember[]> {
	await requireRole(cfg, ledgerId, user, "any");
	const r = await d1Query<LedgerMember>(
		cfg,
		`SELECT member, role, joined_at FROM ledger_members WHERE ledger_id = ?
		 ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at`,
		[ledgerId],
	);
	return r.results;
}

/**
 * 사용할 가계부를 고른다 — 에이전트 툴·REST 공용.
 *
 *   ref 있음  → 내 가계부 중 id 또는 이름이 일치하는 것 (이름이 겹치면 id 를 요구)
 *   ref 없음  → 기본 가계부 → 하나뿐이면 그것 → 하나도 없으면 개인 가계부를 만들어 준다
 *
 * 하나도 없을 때 만들어 주는 이유: 처음 쓰는 사람이 "커피 4500원" 이라고 했을 때
 * "가계부 탭에서 먼저 만드세요" 로 막히지 않게. 본인만 들어가는 가계부라 부작용이 없다.
 */
export async function resolveLedger(cfg: D1Config, user: string, ref?: string | null): Promise<MyLedger> {
	const mine = await listMyLedgers(cfg, user);
	const names = (): string => mine.map((l) => `"${l.name}"`).join(", ");

	const wanted = ref?.trim();
	if (wanted) {
		const byId = mine.find((l) => l.id === wanted);
		if (byId) return byId;
		const key = wanted.toLowerCase();
		const byName = mine.filter((l) => l.name.toLowerCase() === key);
		if (byName.length === 1) return byName[0] as MyLedger;
		if (byName.length > 1) {
			throw new LedgerAccessError(409, `"${wanted}" 이름의 가계부가 여러 개입니다 — 가계부 탭에서 구분해 주세요`);
		}
		throw new LedgerAccessError(
			404,
			mine.length > 0 ? `"${wanted}" 가계부가 없습니다. 내 가계부: ${names()}` : `"${wanted}" 가계부가 없습니다`,
		);
	}

	const def = mine.find((l) => l.isDefault);
	if (def) return def;
	if (mine.length === 1) return mine[0] as MyLedger;
	if (mine.length > 1) {
		throw new LedgerAccessError(409, `어느 가계부인지 정해야 합니다 — 내 가계부: ${names()}`);
	}
	return ensurePersonalLedger(cfg, user);
}

/**
 * 첫 사용 때의 개인 가계부 — **동시에 여러 번 불려도 하나만** 생긴다.
 * 화면을 처음 열면 목록·집계·예산 요청이 병렬로 나가고, 각각이 "가계부 없음" 을 보고
 * 만들면 가계부가 여러 개 생긴다. 그래서 id 를 사용자별로 고정하고 INSERT OR IGNORE 한다.
 *
 * 이 가계부의 소유권을 넘기고 나간 사용자라면 고정 id 는 이미 남의 것이다 —
 * 소유자가 본인일 때만 멤버로 넣고, 아니면 새 가계부를 만든다.
 */
async function ensurePersonalLedger(cfg: D1Config, user: string): Promise<MyLedger> {
	const id = `personal-${user}`;
	const at = now();
	await d1Query(cfg, "INSERT OR IGNORE INTO ledgers (id, name, owner, created_at) VALUES (?, ?, ?, ?)", [
		id,
		`${user}의 가계부`,
		user,
		at,
	]);
	await d1Query(
		cfg,
		`INSERT OR IGNORE INTO ledger_members (ledger_id, member, role, joined_at)
		 SELECT ?, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM ledgers WHERE id = ? AND owner = ?)`,
		[id, user, at, id, user],
	);
	if (!(await roleOf(cfg, id, user))) await createLedger(cfg, user, `${user}의 가계부`);
	else await setDefaultIfUnset(cfg, user, id);

	const mine = await listMyLedgers(cfg, user);
	return (mine.find((l) => l.isDefault) ?? mine[0]) as MyLedger;
}

// ── 가계부 ──────────────────────────────────────────────────────────────

export async function createLedger(cfg: D1Config, owner: string, rawName: string): Promise<Ledger> {
	const ledger: Ledger = { id: ulid(), name: cleanName(rawName), owner, created_at: now() };
	await d1Query(cfg, "INSERT INTO ledgers (id, name, owner, created_at) VALUES (?, ?, ?, ?)", [
		ledger.id,
		ledger.name,
		ledger.owner,
		ledger.created_at,
	]);
	await d1Query(cfg, "INSERT INTO ledger_members (ledger_id, member, role, joined_at) VALUES (?, ?, 'owner', ?)", [
		ledger.id,
		owner,
		ledger.created_at,
	]);
	await setDefaultIfUnset(cfg, owner, ledger.id);
	return ledger;
}

export async function renameLedger(cfg: D1Config, user: string, ledgerId: string, rawName: string): Promise<Ledger> {
	const ledger = await requireRole(cfg, ledgerId, user, "owner");
	const name = cleanName(rawName);
	await d1Query(cfg, "UPDATE ledgers SET name = ? WHERE id = ?", [name, ledgerId]);
	return { ...ledger, name };
}

/**
 * 가계부 삭제 — 거래·예산·초대·멤버를 모두 지운다. 되돌릴 수 없다.
 * 이름을 그대로 입력해야 한다 (UI 에서 export 를 먼저 권한다).
 * 멤버십부터 지워서, 중간에 실패해도 더는 아무도 접근하지 못하게 한다.
 */
export async function deleteLedger(cfg: D1Config, user: string, ledgerId: string, confirmName: string): Promise<void> {
	const ledger = await requireRole(cfg, ledgerId, user, "owner");
	if (confirmName.trim() !== ledger.name) {
		throw new LedgerAccessError(400, "확인용 이름이 가계부 이름과 다릅니다");
	}
	await d1Query(cfg, "DELETE FROM ledger_members WHERE ledger_id = ?", [ledgerId]);
	await d1Query(cfg, "UPDATE user_prefs SET default_ledger_id = NULL WHERE default_ledger_id = ?", [ledgerId]);
	await d1Query(cfg, "DELETE FROM ledger_invites WHERE ledger_id = ?", [ledgerId]);
	await d1Query(cfg, "DELETE FROM transactions WHERE ledger_id = ?", [ledgerId]);
	await d1Query(cfg, "DELETE FROM budgets WHERE ledger_id = ?", [ledgerId]);
	await d1Query(cfg, "DELETE FROM ledgers WHERE id = ?", [ledgerId]);
}

export async function setDefaultLedger(cfg: D1Config, user: string, ledgerId: string): Promise<void> {
	await requireRole(cfg, ledgerId, user, "any");
	await d1Query(
		cfg,
		`INSERT INTO user_prefs (member, default_ledger_id) VALUES (?, ?)
		 ON CONFLICT(member) DO UPDATE SET default_ledger_id = excluded.default_ledger_id`,
		[user, ledgerId],
	);
}

async function setDefaultIfUnset(cfg: D1Config, user: string, ledgerId: string): Promise<void> {
	await d1Query(
		cfg,
		`INSERT INTO user_prefs (member, default_ledger_id) VALUES (?, ?)
		 ON CONFLICT(member) DO UPDATE SET default_ledger_id = COALESCE(user_prefs.default_ledger_id, excluded.default_ledger_id)`,
		[user, ledgerId],
	);
}

async function clearDefaultIf(cfg: D1Config, user: string, ledgerId: string): Promise<void> {
	await d1Query(cfg, "UPDATE user_prefs SET default_ledger_id = NULL WHERE member = ? AND default_ledger_id = ?", [
		user,
		ledgerId,
	]);
}

/** 소유권 이전 — 받는 사람은 이미 멤버여야 한다. 이전한 사람은 일반 멤버로 남는다. */
export async function transferOwnership(cfg: D1Config, user: string, ledgerId: string, to: string): Promise<void> {
	await requireRole(cfg, ledgerId, user, "owner");
	if (to === user) throw new LedgerAccessError(400, "이미 소유자입니다");
	const promoted = await d1Query(
		cfg,
		"UPDATE ledger_members SET role = 'owner' WHERE ledger_id = ? AND member = ? AND role = 'member'",
		[ledgerId, to],
	);
	if ((promoted.meta.changes ?? 0) !== 1) throw new LedgerAccessError(400, `${to} 님은 이 가계부의 멤버가 아닙니다`);
	await d1Query(cfg, "UPDATE ledger_members SET role = 'member' WHERE ledger_id = ? AND member = ?", [ledgerId, user]);
	await d1Query(cfg, "UPDATE ledgers SET owner = ? WHERE id = ?", [to, ledgerId]);
}

/**
 * 멤버 제거 — 소유자가 남을 내보내거나(target ≠ user), 멤버가 스스로 나간다(target = user).
 * 소유자는 나갈 수 없다: 소유권을 넘기거나 가계부를 삭제해야 한다 (주인 없는 가계부를 만들지 않는다).
 * 내보낸 멤버가 쓴 기록은 남는다 (작성자 member 도 그대로).
 */
export async function removeMember(cfg: D1Config, user: string, ledgerId: string, target: string): Promise<void> {
	if (target === user) {
		const role = await roleOf(cfg, ledgerId, user);
		if (!role) throw notFound();
		if (role === "owner") {
			throw new LedgerAccessError(400, "소유자는 나갈 수 없습니다 — 소유권을 넘기거나 가계부를 삭제하세요");
		}
	} else {
		await requireRole(cfg, ledgerId, user, "owner");
	}
	const r = await d1Query(cfg, "DELETE FROM ledger_members WHERE ledger_id = ? AND member = ? AND role = 'member'", [
		ledgerId,
		target,
	]);
	if ((r.meta.changes ?? 0) !== 1) throw new LedgerAccessError(404, `${target} 님은 이 가계부의 멤버가 아닙니다`);
	await clearDefaultIf(cfg, target, ledgerId);
}

// ── 초대 ────────────────────────────────────────────────────────────────

const INVITE_COLUMNS = `i.id, i.ledger_id, l.name AS ledger_name, i.inviter, i.invitee, i.status,
	i.created_at, i.expires_at, i.responded_at`;

/** 기한이 지난 대기 초대를 expired 로 정리한다 — 조회·초대 전에 부른다. */
async function expireStale(cfg: D1Config): Promise<void> {
	await d1Query(cfg, "UPDATE ledger_invites SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [
		now(),
	]);
}

/**
 * 초대 보내기 — 소유자만.
 * @param userExists 계정 존재 확인 (계정 목록은 서버가 안다 — env·D1 users)
 */
export async function inviteMember(
	cfg: D1Config,
	inviter: string,
	ledgerId: string,
	rawInvitee: string,
	userExists: (name: string) => boolean | Promise<boolean>,
): Promise<LedgerInvite> {
	const ledger = await requireRole(cfg, ledgerId, inviter, "owner");
	const invitee = rawInvitee.trim();
	if (!invitee) throw new LedgerAccessError(400, "초대할 사용자 ID 를 입력하세요");
	if (invitee === inviter) throw new LedgerAccessError(400, "자기 자신은 초대할 수 없습니다");
	if (!(await userExists(invitee))) throw new LedgerAccessError(404, `${invitee} 사용자가 없습니다`);
	if (await roleOf(cfg, ledgerId, invitee)) throw new LedgerAccessError(409, `${invitee} 님은 이미 멤버입니다`);

	await expireStale(cfg);
	const invite: LedgerInvite = {
		id: ulid(),
		ledger_id: ledgerId,
		ledger_name: ledger.name,
		inviter,
		invitee,
		status: "pending",
		created_at: now(),
		expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
		responded_at: null,
	};
	try {
		await d1Query(
			cfg,
			`INSERT INTO ledger_invites (id, ledger_id, inviter, invitee, status, created_at, expires_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
			[invite.id, ledgerId, inviter, invitee, invite.created_at, invite.expires_at],
		);
	} catch (err) {
		// uq_inv_pending — 같은 사람에게 대기 중인 초대가 이미 있다
		if (/UNIQUE/i.test(String((err as Error)?.message))) {
			throw new LedgerAccessError(409, `${invitee} 님에게 보낸 초대가 이미 대기 중입니다`);
		}
		throw err;
	}
	return invite;
}

/** 내가 받은 대기 중 초대 */
export async function listIncomingInvites(cfg: D1Config, user: string): Promise<LedgerInvite[]> {
	await expireStale(cfg);
	const r = await d1Query<LedgerInvite>(
		cfg,
		`SELECT ${INVITE_COLUMNS} FROM ledger_invites i JOIN ledgers l ON l.id = i.ledger_id
		 WHERE i.invitee = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
		[user],
	);
	return r.results;
}

/** 이 가계부에서 보낸 대기 중 초대 — 멤버면 볼 수 있다 (누가 초대됐는지는 가계부 멤버끼리 공유해도 된다) */
export async function listLedgerInvites(cfg: D1Config, user: string, ledgerId: string): Promise<LedgerInvite[]> {
	await requireRole(cfg, ledgerId, user, "any");
	await expireStale(cfg);
	const r = await d1Query<LedgerInvite>(
		cfg,
		`SELECT ${INVITE_COLUMNS} FROM ledger_invites i JOIN ledgers l ON l.id = i.ledger_id
		 WHERE i.ledger_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
		[ledgerId],
	);
	return r.results;
}

/**
 * 초대 수락/거절 — 초대받은 본인만, 대기 중·기한 내일 때만.
 * 조건부 UPDATE 한 번으로 "지금 이 순간 유효한가" 를 판정한다 (중복 수락·취소와의 경합 방지).
 */
export async function respondInvite(
	cfg: D1Config,
	user: string,
	inviteId: string,
	accept: boolean,
): Promise<{ ledgerId: string; status: "accepted" | "declined" }> {
	const at = now();
	const status = accept ? "accepted" : "declined";
	const r = await d1Query(
		cfg,
		`UPDATE ledger_invites SET status = ?, responded_at = ?
		 WHERE id = ? AND invitee = ? AND status = 'pending' AND expires_at > ?`,
		[status, at, inviteId, user, at],
	);
	if ((r.meta.changes ?? 0) !== 1) {
		throw new LedgerAccessError(404, "초대를 찾을 수 없습니다 (이미 처리됐거나 취소·만료됨)");
	}
	const inv = await d1Query<{ ledger_id: string }>(cfg, "SELECT ledger_id FROM ledger_invites WHERE id = ?", [inviteId]);
	const ledgerId = inv.results[0]?.ledger_id as string;
	if (accept) {
		await d1Query(
			cfg,
			`INSERT OR IGNORE INTO ledger_members (ledger_id, member, role, joined_at)
			 SELECT ?, ?, 'member', ? WHERE EXISTS (SELECT 1 FROM ledgers WHERE id = ?)`,
			[ledgerId, user, at, ledgerId],
		);
		if (!(await roleOf(cfg, ledgerId, user))) throw notFound(); // 그 사이 가계부가 삭제됨
		await setDefaultIfUnset(cfg, user, ledgerId);
	}
	return { ledgerId, status };
}

/** 초대 취소 — 그 가계부의 소유자만 */
export async function revokeInvite(cfg: D1Config, user: string, inviteId: string): Promise<void> {
	const r = await d1Query(
		cfg,
		`UPDATE ledger_invites SET status = 'revoked', responded_at = ?
		 WHERE id = ? AND status = 'pending'
		   AND ledger_id IN (SELECT ledger_id FROM ledger_members WHERE member = ? AND role = 'owner')`,
		[now(), inviteId, user],
	);
	if ((r.meta.changes ?? 0) !== 1) throw new LedgerAccessError(404, "취소할 초대를 찾을 수 없습니다");
}
