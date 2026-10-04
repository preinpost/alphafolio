/**
 * 직접 입력 자산 — API 가 없는 곳(은행 예금·연금·부동산·다른 거래소)의 금액 (PLAN §41 3단계).
 *
 * 사용자 개인 것이다 (증권 키·스냅샷처럼 member 단위). 가계부와 달리 공유하지 않는다.
 * 포트폴리오 집계는 BrokerAccess.manual 로 목록만 받아 원화 환산·배분한다 (broker/sources/manual.ts).
 * 화면(/api/assets/manual)만 고친다 — 에이전트 도구는 없다 (읽기는 portfolio_holdings 로 보인다).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { d1Query, ensureMigrated, type D1Config } from "@alphafolio/ledger";
import { MANUAL_KINDS, type ManualAsset, type ManualKind } from "@alphafolio/broker";
import { HttpError, readJson } from "./ledger-api.ts";

/** 한 사람이 둘 수 있는 개수 — 화면 한 장에 들어갈 만큼 */
export const MAX_MANUAL_ASSETS = 50;
const MAX_AMOUNT = 1e13;

interface Row {
	id: string;
	name: string;
	kind: string;
	currency: string;
	amount: number;
	memo: string | null;
	updated_at: string;
}

const fromRow = (r: Row): ManualAsset => ({
	id: r.id,
	name: r.name,
	kind: r.kind as ManualKind,
	currency: r.currency === "USD" ? "USD" : "KRW",
	amount: r.amount,
	memo: r.memo,
	updatedAt: r.updated_at,
});

export type ManualInput = Pick<ManualAsset, "name" | "kind" | "currency" | "amount" | "memo">;

/** 입력 검증 (순수). partial 이면 온 필드만 본다 (수정) */
export function parseManualInput(body: Record<string, unknown>, partial: false): ManualInput;
export function parseManualInput(body: Record<string, unknown>, partial: true): Partial<ManualInput>;
export function parseManualInput(body: Record<string, unknown>, partial: boolean): Partial<ManualInput> {
	const out: Partial<ManualInput> = {};
	const has = (k: string): boolean => body[k] !== undefined;

	if (!partial || has("name")) {
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name || name.length > 60) throw new HttpError(400, "이름은 1~60자로 입력하세요");
		out.name = name;
	}
	if (!partial || has("kind")) {
		if (!MANUAL_KINDS.includes(body.kind as ManualKind)) throw new HttpError(400, `종류는 ${MANUAL_KINDS.join(", ")} 중 하나입니다`);
		out.kind = body.kind as ManualKind;
	}
	if (!partial || has("currency")) {
		if (body.currency !== "KRW" && body.currency !== "USD") throw new HttpError(400, "통화는 KRW 또는 USD 입니다");
		out.currency = body.currency;
	}
	if (!partial || has("amount")) {
		const amount = typeof body.amount === "number" ? body.amount : Number.NaN;
		if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw new HttpError(400, "금액은 0 이상의 숫자여야 합니다");
		out.amount = amount;
	}
	if (!partial || has("memo")) {
		const memo = body.memo === null || body.memo === undefined ? "" : typeof body.memo === "string" ? body.memo.trim() : null;
		if (memo === null || memo.length > 200) throw new HttpError(400, "메모는 200자 이하 문자열입니다");
		out.memo = memo || null;
	}
	return out;
}

export class ManualAssetStore {
	private readonly d1: () => D1Config;
	private readonly now: () => Date;

	constructor(d1: () => D1Config, now: () => Date = () => new Date()) {
		this.d1 = d1;
		this.now = now;
	}

	private async cfg(): Promise<D1Config> {
		const cfg = this.d1();
		await ensureMigrated(cfg);
		return cfg;
	}

	async list(member: string): Promise<ManualAsset[]> {
		const r = await d1Query<Row>(
			await this.cfg(),
			"SELECT id, name, kind, currency, amount, memo, updated_at FROM manual_assets WHERE member = ? ORDER BY created_at",
			[member],
		);
		return r.results.map(fromRow);
	}

	async create(member: string, input: ManualInput): Promise<ManualAsset> {
		const cfg = await this.cfg();
		const count = await d1Query<{ n: number }>(cfg, "SELECT COUNT(*) AS n FROM manual_assets WHERE member = ?", [member]);
		if ((count.results[0]?.n ?? 0) >= MAX_MANUAL_ASSETS) throw new HttpError(400, `직접 입력 자산은 ${MAX_MANUAL_ASSETS}개까지입니다`);
		const id = `m${randomBytes(6).toString("hex")}`;
		const at = this.now().toISOString();
		await d1Query(
			cfg,
			"INSERT INTO manual_assets (id, member, name, kind, currency, amount, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[id, member, input.name, input.kind, input.currency, input.amount, input.memo, at, at],
		);
		return { id, ...input, updatedAt: at };
	}

	/** 남의 것·없는 것은 404 (member 조건으로만 고친다) */
	async update(member: string, id: string, patch: Partial<ManualInput>): Promise<ManualAsset> {
		const cfg = await this.cfg();
		const sets: string[] = [];
		const params: Array<string | number | null> = [];
		const col: Record<keyof ManualInput, string> = { name: "name", kind: "kind", currency: "currency", amount: "amount", memo: "memo" };
		for (const k of Object.keys(col) as Array<keyof ManualInput>) {
			if (patch[k] === undefined) continue;
			sets.push(`${col[k]} = ?`);
			params.push(patch[k] as string | number | null);
		}
		if (sets.length > 0) {
			sets.push("updated_at = ?");
			params.push(this.now().toISOString());
			await d1Query(cfg, `UPDATE manual_assets SET ${sets.join(", ")} WHERE id = ? AND member = ?`, [...params, id, member]);
		}
		const r = await d1Query<Row>(cfg, "SELECT id, name, kind, currency, amount, memo, updated_at FROM manual_assets WHERE id = ? AND member = ?", [id, member]);
		const row = r.results[0];
		if (!row) throw new HttpError(404, `자산을 찾을 수 없습니다: ${id}`);
		return fromRow(row);
	}

	async remove(member: string, id: string): Promise<void> {
		const cfg = await this.cfg();
		const r = await d1Query<{ id: string }>(cfg, "SELECT id FROM manual_assets WHERE id = ? AND member = ?", [id, member]);
		if (!r.results[0]) throw new HttpError(404, `자산을 찾을 수 없습니다: ${id}`);
		await d1Query(cfg, "DELETE FROM manual_assets WHERE id = ? AND member = ?", [id, member]);
	}
}

/** /api/assets/manual[/<id>] — 처리했으면 결과, 라우트가 아니면 undefined */
export async function handleManualAssets(req: IncomingMessage, path: string, member: string, store: ManualAssetStore): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	if (path === "/api/assets/manual") {
		if (method === "GET") return { items: await store.list(member) };
		if (method === "POST") return store.create(member, parseManualInput(await readJson(req), false));
		return undefined;
	}
	const m = /^\/api\/assets\/manual\/([A-Za-z0-9_-]{1,40})$/.exec(path);
	if (!m) return undefined;
	const id = m[1]!;
	if (method === "PATCH") return store.update(member, id, parseManualInput(await readJson(req), true));
	if (method === "DELETE") {
		await store.remove(member, id);
		return { deleted: true };
	}
	return undefined;
}
