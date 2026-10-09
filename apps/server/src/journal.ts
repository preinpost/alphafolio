/**
 * 매매일지 (PLAN §42) — D1 `trade_journal` · `trade_journal_refs`, 사용자 개인 것 (member 단위).
 *
 *   직접 기록      화면(/api/journal) · 챗(journal_add)
 *   챗 주문        /api/orders/execute 가 접수 직후 recordOrder — pending, 확인 카드의 "근거 한 줄" 이 thesis
 *   자동 매매      TradeStore.finish → recordExec — 체결기 보고 그대로 filled
 *   가져오기       JournalSync — 연결된 계좌의 체결 내역을 ref 로 맞춘다 (pending 을 채우고, 앱 밖 매매는 새 줄)
 *
 * 증권사 주문과는 ref 로 잇는다 (broker/journal/refs.ts). 기록을 지워도 ref 는 남긴다 — 다음 가져오기에서 다시 살아나지 않게.
 * 일지 쓰기가 실패해도 주문·자동 매매는 그대로 간다 (호출부가 오류를 삼킨다).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { d1Query, ensureMigrated, type D1Config, type D1Param } from "@alphafolio/ledger";
import {
	conditionText,
	execCurrency,
	execRefs,
	JournalValidationError,
	kstDate,
	orderJournal,
	parseJournalNotes,
	parseJournalTrade,
	planSync,
	replacedRefs,
	touchesTrade,
	type BrokerFill,
	type ExecResult,
	type FillSource,
	type JournalContext,
	type JournalEntry,
	type JournalFilter,
	type JournalInput,
	type JournalNotes,
	type JournalPatch,
	type JournalSyncResult,
	type JournalTrade,
	type KnownEntry,
	type OrderAction,
	type SyncPlan,
} from "@alphafolio/broker";
import { HttpError, readJson } from "./ledger-api.ts";
import type { ExecRecord } from "./trade-store.ts";
import type { TriggerRecord } from "./triggers.ts";

/** 가져오기 기본 기간 · 최대 (한국투자 국장 체결 조회가 3개월까지) */
export const SYNC_DEFAULT_DAYS = 30;
export const SYNC_MAX_DAYS = 90;
/** 화면을 열 때마다 증권사를 부르지 않게 — 이보다 짧으면 건너뛴다 (버튼은 force) */
export const SYNC_THROTTLE_MS = 10 * 60_000;
const DAY = 86_400_000;

interface Row {
	id: string;
	at: number;
	date: string;
	broker: string;
	symbol: string;
	name: string | null;
	side: string;
	quantity: number;
	price: number | null;
	currency: string;
	fee: number | null;
	status: string;
	source: string;
	thesis: string | null;
	target_price: number | null;
	stop_price: number | null;
	tags: string;
	emotion: string | null;
	review: string | null;
	context: string | null;
	conversation_id: string | null;
	created_at: string;
	updated_at: string;
}

const parse = <T>(s: string | null, fallback: T): T => {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

const fromRow = (r: Row): JournalEntry => ({
	id: r.id,
	at: r.at,
	date: r.date,
	broker: r.broker as JournalEntry["broker"],
	symbol: r.symbol,
	name: r.name,
	side: r.side === "SELL" ? "SELL" : "BUY",
	quantity: r.quantity,
	price: r.price,
	currency: r.currency,
	fee: r.fee,
	status: r.status as JournalEntry["status"],
	source: r.source as JournalEntry["source"],
	thesis: r.thesis,
	targetPrice: r.target_price,
	stopPrice: r.stop_price,
	tags: parse<string[]>(r.tags, []),
	emotion: r.emotion as JournalEntry["emotion"],
	review: r.review,
	context: parse<JournalContext | null>(r.context, null),
	conversationId: r.conversation_id,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** 저장소 오류를 화면(400)·모델이 읽을 문장으로 */
function valid<T>(run: () => T): T {
	try {
		return run();
	} catch (err) {
		if (err instanceof JournalValidationError) throw new HttpError(400, err.message);
		throw err;
	}
}

const NOTE_COLUMNS: Record<keyof JournalNotes, string> = {
	thesis: "thesis",
	targetPrice: "target_price",
	stopPrice: "stop_price",
	tags: "tags",
	emotion: "emotion",
	review: "review",
};
const TRADE_COLUMNS: Record<keyof JournalTrade, string> = {
	at: "at",
	broker: "broker",
	symbol: "symbol",
	name: "name",
	side: "side",
	quantity: "quantity",
	price: "price",
	currency: "currency",
	fee: "fee",
};

export class JournalStore {
	private readonly d1: () => D1Config;
	private readonly now: () => number;

	constructor(d1: () => D1Config, now: () => number = Date.now) {
		this.d1 = d1;
		this.now = now;
	}

	private async cfg(): Promise<D1Config> {
		const cfg = this.d1();
		await ensureMigrated(cfg);
		return cfg;
	}

	async list(member: string, filter: JournalFilter = {}): Promise<JournalEntry[]> {
		const where = ["member = ?"];
		const params: D1Param[] = [member];
		if (filter.from !== undefined) {
			where.push("at >= ?");
			params.push(filter.from);
		}
		if (filter.to !== undefined) {
			where.push("at < ?");
			params.push(filter.to);
		}
		if (filter.symbol) {
			where.push("symbol = ?");
			params.push(filter.symbol.toUpperCase());
		}
		if (filter.side) {
			where.push("side = ?");
			params.push(filter.side);
		}
		if (filter.missingNotes) where.push("thesis IS NULL AND status != 'canceled'");
		params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
		const r = await d1Query<Row>(await this.cfg(), `SELECT * FROM trade_journal WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, params);
		return r.results.map(fromRow);
	}

	async get(member: string, id: string): Promise<JournalEntry | null> {
		const r = await d1Query<Row>(await this.cfg(), "SELECT * FROM trade_journal WHERE id = ? AND member = ?", [id, member]);
		return r.results[0] ? fromRow(r.results[0]) : null;
	}

	/**
	 * 새 줄. refs 가 있으면 먼저 차지한다 — 첫 ref 가 이미 있으면(같은 주문이 먼저 들어왔다) 만들지 않고 null.
	 * 차지한 뒤 쓰기 전에 멈추면 그 주문은 일지에 없다 (두 줄이 되는 것보다 낫다).
	 */
	async create(member: string, input: JournalInput, refs: readonly string[] = []): Promise<JournalEntry | null> {
		const cfg = await this.cfg();
		const id = `j${randomBytes(8).toString("hex")}`;
		for (const [i, ref] of refs.entries()) {
			const r = await d1Query(cfg, "INSERT OR IGNORE INTO trade_journal_refs (member, ref, entry_id) VALUES (?, ?, ?)", [member, ref, id]);
			if (i === 0 && (r.meta.changes ?? 0) === 0) return null;
		}
		const at = new Date(this.now()).toISOString();
		const entry: JournalEntry = { ...input, id, date: kstDate(input.at), createdAt: at, updatedAt: at };
		await d1Query(
			cfg,
			`INSERT INTO trade_journal (id, member, at, date, broker, symbol, name, side, quantity, price, currency, fee, status, source,
			   thesis, target_price, stop_price, tags, emotion, review, context, conversation_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id, member, entry.at, entry.date, entry.broker, entry.symbol, entry.name, entry.side, entry.quantity, entry.price, entry.currency, entry.fee,
				entry.status, entry.source, entry.thesis, entry.targetPrice, entry.stopPrice, JSON.stringify(entry.tags), entry.emotion, entry.review,
				entry.context ? JSON.stringify(entry.context) : null, entry.conversationId, at, at,
			],
		);
		return entry;
	}

	/**
	 * 고치기 — 사람이 쓰는 칸은 누구나, 매매 칸은 직접 기록만 (증권사에서 온 숫자는 증권사가 맞다).
	 * 남의 것·없는 것은 404.
	 */
	async update(member: string, id: string, patch: JournalPatch): Promise<JournalEntry> {
		const cfg = await this.cfg();
		const current = await this.get(member, id);
		if (!current) throw new HttpError(404, `일지를 찾을 수 없습니다: ${id}`);
		const sets: string[] = [];
		const params: D1Param[] = [];
		for (const k of Object.keys(NOTE_COLUMNS) as Array<keyof JournalNotes>) {
			if (patch[k] === undefined) continue;
			sets.push(`${NOTE_COLUMNS[k]} = ?`);
			params.push(k === "tags" ? JSON.stringify(patch.tags) : (patch[k] as D1Param));
		}
		const trade = (Object.keys(TRADE_COLUMNS) as Array<keyof JournalTrade>).filter((k) => patch[k] !== undefined);
		if (trade.length > 0 && current.source !== "manual") throw new HttpError(400, "증권사·앱에서 들어온 매매는 수량·가격을 고칠 수 없습니다 — 메모만 고칠 수 있습니다");
		for (const k of trade) {
			sets.push(`${TRADE_COLUMNS[k]} = ?`);
			params.push(patch[k] as D1Param);
		}
		if (patch.at !== undefined) {
			sets.push("date = ?");
			params.push(kstDate(patch.at));
		}
		if (sets.length === 0) return current;
		sets.push("updated_at = ?");
		params.push(new Date(this.now()).toISOString());
		await d1Query(cfg, `UPDATE trade_journal SET ${sets.join(", ")} WHERE id = ? AND member = ?`, [...params, id, member]);
		const updated = await this.get(member, id);
		if (!updated) throw new HttpError(404, `일지를 찾을 수 없습니다: ${id}`);
		return updated;
	}

	/** 지우기 — ref 는 남긴다 (다음 가져오기에서 다시 살아나지 않게) */
	async remove(member: string, id: string): Promise<void> {
		const cfg = await this.cfg();
		const r = await d1Query(cfg, "DELETE FROM trade_journal WHERE id = ? AND member = ?", [id, member]);
		if ((r.meta.changes ?? 0) === 0) throw new HttpError(404, `일지를 찾을 수 없습니다: ${id}`);
	}

	/** 정정·재주문 — 원주문 기록에 새 주문번호를 붙인다 (원주문 기록이 없으면 아무것도 하지 않는다) */
	async linkRef(member: string, parent: string, child: string): Promise<boolean> {
		const cfg = await this.cfg();
		const r = await d1Query<{ entry_id: string }>(cfg, "SELECT entry_id FROM trade_journal_refs WHERE member = ? AND ref = ?", [member, parent]);
		const entry = r.results[0]?.entry_id;
		if (!entry) return false;
		await d1Query(cfg, "INSERT OR IGNORE INTO trade_journal_refs (member, ref, entry_id) VALUES (?, ?, ?)", [member, child, entry]);
		return true;
	}

	/**
	 * 가져오기가 맞춰 볼 기록 — 기간 안(앞으로 7일 여유)과 아직 체결을 모르는 것 전부 + 그 ref.
	 * claimed 는 이 사용자가 쓴 ref 전부 (지운 기록 포함).
	 */
	async known(member: string, since: number): Promise<{ entries: KnownEntry[]; claimed: Set<string> }> {
		const cfg = await this.cfg();
		const r = await d1Query<Pick<Row, "id" | "source" | "status" | "quantity" | "price" | "fee" | "name"> & { ref: string | null }>(
			cfg,
			`SELECT j.id, j.source, j.status, j.quantity, j.price, j.fee, j.name, r.ref
			 FROM trade_journal j LEFT JOIN trade_journal_refs r ON r.member = j.member AND r.entry_id = j.id
			 WHERE j.member = ? AND (j.at >= ? OR j.status = 'pending')`,
			[member, since - 7 * DAY],
		);
		const by = new Map<string, KnownEntry>();
		for (const x of r.results) {
			const e = by.get(x.id) ?? { id: x.id, source: x.source as KnownEntry["source"], status: x.status as KnownEntry["status"], quantity: x.quantity, price: x.price, fee: x.fee, name: x.name, refs: [] };
			if (x.ref) e.refs.push(x.ref);
			by.set(x.id, e);
		}
		const refs = await d1Query<{ ref: string }>(cfg, "SELECT ref FROM trade_journal_refs WHERE member = ?", [member]);
		return { entries: [...by.values()], claimed: new Set(refs.results.map((x) => x.ref)) };
	}

	async apply(member: string, plan: SyncPlan): Promise<{ added: number; updated: number }> {
		const cfg = await this.cfg();
		let updated = 0;
		for (const u of plan.updates) {
			const at = new Date(this.now()).toISOString();
			const sets = ["status = ?", "quantity = ?", "price = ?", "fee = ?", "updated_at = ?"];
			const params: D1Param[] = [u.patch.status, u.patch.quantity, u.patch.price, u.patch.fee, at];
			if (u.patch.name) {
				sets.push("name = ?");
				params.push(u.patch.name);
			}
			await d1Query(cfg, `UPDATE trade_journal SET ${sets.join(", ")} WHERE id = ? AND member = ?`, [...params, u.id, member]);
			for (const ref of u.addRefs) await d1Query(cfg, "INSERT OR IGNORE INTO trade_journal_refs (member, ref, entry_id) VALUES (?, ?, ?)", [member, ref, u.id]);
			updated++;
		}
		let added = 0;
		for (const i of plan.inserts) if (await this.create(member, i.input, i.refs)) added++;
		return { added, updated };
	}

	/** Binance 현물에서 훑을 마켓 — 일지에 있는 것 */
	async binanceSymbols(member: string, since: number): Promise<string[]> {
		const r = await d1Query<{ symbol: string }>(await this.cfg(), "SELECT DISTINCT symbol FROM trade_journal WHERE member = ? AND broker = 'binance' AND at >= ?", [member, since]);
		return r.results.map((x) => x.symbol);
	}
}

// ── 가져오기 ────────────────────────────────────────────────

export interface JournalSyncDeps {
	store: JournalStore;
	/** 사용자가 연결한 계좌의 체결 출처 (broker fillSources) */
	sources: (user: string, since: number) => FillSource[];
	/** 종목명 — 토스·Binance 체결에는 이름이 없다 (실패해도 가져오기는 간다) */
	names?: (user: string, symbols: string[]) => Promise<Map<string, string>>;
	now?: () => number;
}

export class JournalSync {
	private readonly d: JournalSyncDeps;
	private readonly last = new Map<string, number>();
	private readonly running = new Map<string, Promise<JournalSyncResult>>();

	constructor(deps: JournalSyncDeps) {
		this.d = deps;
	}

	private now(): number {
		return this.d.now?.() ?? Date.now();
	}

	/**
	 * 같은 사용자의 가져오기는 하나만 — 겹치면 도는 것을 기다린다.
	 * 마지막 가져오기에서 minIntervalMs(기본 10분)가 안 지났으면 건너뛴다. force 는 바로 (화면의 버튼).
	 */
	run(user: string, opts: { days?: number; force?: boolean; minIntervalMs?: number } = {}): Promise<JournalSyncResult> {
		const inflight = this.running.get(user);
		if (inflight) return inflight;
		const last = this.last.get(user) ?? 0;
		const gap = opts.force ? 0 : (opts.minIntervalMs ?? SYNC_THROTTLE_MS);
		if (this.now() - last < gap) return Promise.resolve({ added: 0, updated: 0, sources: [], warnings: [], skipped: true });
		const p = this.sync(user, Math.min(Math.max(Math.floor(opts.days ?? SYNC_DEFAULT_DAYS), 1), SYNC_MAX_DAYS)).finally(() => this.running.delete(user));
		this.running.set(user, p);
		return p;
	}

	private async sync(user: string, days: number): Promise<JournalSyncResult> {
		const to = this.now();
		const from = to - days * DAY;
		const fills: BrokerFill[] = [];
		const result: JournalSyncResult = { added: 0, updated: 0, sources: [], warnings: [] };
		// 계좌마다 차례로 — 증권사 호출 제한을 서로 나눠 쓰지 않게. 한 계좌가 실패해도 나머지는 간다
		for (const s of this.d.sources(user, from)) {
			try {
				const r = await s.run(from, to);
				fills.push(...r.fills);
				result.warnings.push(...r.warnings);
				result.sources.push({ broker: s.broker, label: s.label, fills: r.fills.filter((f) => f.filled > 0).length, error: null });
			} catch (err) {
				result.sources.push({ broker: s.broker, label: s.label, fills: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
			}
		}
		const { entries, claimed } = await this.d.store.known(user, from);
		const plan = planSync(fills, entries, claimed);
		const unnamed = [...new Set(plan.inserts.filter((i) => !i.input.name && i.input.broker !== "binance").map((i) => i.input.symbol))];
		if (unnamed.length > 0 && this.d.names) {
			const names = await this.d.names(user, unnamed).catch(() => new Map<string, string>());
			for (const i of plan.inserts) if (!i.input.name) i.input.name = names.get(i.input.symbol) ?? null;
		}
		const applied = await this.d.store.apply(user, plan);
		this.last.set(user, this.now());
		console.log(`[journal] 가져오기 user=${user} ${days}일 체결 ${fills.length}건 → 새 ${applied.added} · 반영 ${applied.updated}`);
		return { ...result, ...applied };
	}
}

// ── 앱이 낸 주문 · 자동 매매 ────────────────────────────────

export interface JournalRecorderDeps {
	store: JournalStore;
	names?: (user: string, symbols: string[]) => Promise<Map<string, string>>;
	now?: () => number;
}

/** 확인 카드 "근거 한 줄" — 주문 본문의 note */
export function parseOrderNote(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim().slice(0, 1000);
	return t || null;
}

export class JournalRecorder {
	private readonly d: JournalRecorderDeps;

	constructor(deps: JournalRecorderDeps) {
		this.d = deps;
	}

	private now(): number {
		return this.d.now?.() ?? Date.now();
	}

	private async nameOf(user: string, symbol: string, broker: string): Promise<string | null> {
		if (!this.d.names || broker === "binance") return null;
		const m = await this.d.names(user, [symbol]).catch(() => new Map<string, string>());
		return m.get(symbol.toUpperCase()) ?? null;
	}

	/** 확인 카드로 접수된 주문 — 신규는 pending 한 줄, 정정·재주문은 원주문 기록에 새 번호를 붙인다 */
	async recordOrder(user: string, action: OrderAction, result: ExecResult, opts: { note: string | null; conversationId: string | null }): Promise<JournalEntry | null> {
		const t = this.now();
		const replaced = replacedRefs(action, result.orderId, t);
		if (replaced) {
			await this.d.store.linkRef(user, replaced.parent, replaced.child);
			return null;
		}
		const o = orderJournal(action, result.orderId, t);
		if (!o) return null;
		const name = await this.nameOf(user, o.input.symbol, o.input.broker);
		return this.d.store.create(
			user,
			{ ...o.input, name, thesis: opts.note, targetPrice: null, stopPrice: null, tags: [], emotion: null, review: null, conversationId: opts.conversationId },
			[o.ref],
		);
	}

	/** 자동 매매 한 신호가 끝났다 — 체결이 있으면 한 줄 (자식 주문 전부의 ref 를 붙여 가져오기와 겹치지 않게) */
	async recordExec(rec: ExecRecord, trigger: TriggerRecord | null): Promise<JournalEntry | null> {
		const report = rec.report;
		if (!report || report.filledQty <= 0) return null;
		const target = rec.plan.target.broker;
		const leg = rec.plan.rangeLeg ?? (trigger?.action.kind === "order" && trigger.action.position ? (rec.side === "SELL" ? protectLeg(trigger, report.avgPrice) : "normal") : "normal");
		const context: JournalContext = {
			orderType: "LIMIT",
			ordered: rec.plan.quantity,
			...(trigger ? { trigger: trigger.name, condition: conditionText(trigger.source.condition) } : {}),
			leg,
			arrivalPrice: report.arrivalPrice,
			slippageBps: report.slippageBps,
		};
		const name = await this.nameOf(rec.member, rec.symbol, target);
		return this.d.store.create(
			rec.member,
			{
				at: this.now(),
				broker: target,
				symbol: rec.symbol,
				name,
				side: rec.side,
				quantity: report.filledQty,
				price: report.avgPrice,
				currency: execCurrency(target, rec.symbol, rec.currency),
				fee: settledFee(report.children),
				status: "filled",
				source: "auto",
				thesis: null,
				targetPrice: null,
				stopPrice: null,
				tags: [],
				emotion: null,
				review: null,
				context,
				conversationId: trigger?.conversationId ?? null,
			},
			execRefs(target, rec.symbol, report.children),
		);
	}
}

/** 반복매매 체결기가 확인한 수수료(호가 자산) — 체결된 자식 주문을 다 확인했을 때만 합친다 */
function settledFee(children: NonNullable<ExecRecord["report"]>["children"]): number | null {
	const filled = children.filter((c) => c.filledQty > 0);
	if (filled.length === 0 || filled.some((c) => c.settlement?.quoteFee === null || c.settlement?.quoteFee === undefined)) return null;
	return Number(filled.reduce((s, c) => s + (c.settlement?.quoteFee ?? 0), 0).toPrecision(10));
}

/** 보호 매도가 손절인지 익절인지 — 평단보다 낮게 팔았으면 손절 */
function protectLeg(trigger: TriggerRecord, avg: number | null): "stop" | "take" | "normal" {
	if (trigger.action.kind !== "order" || !trigger.action.position || avg === null) return "normal";
	return avg < trigger.action.position.avgPrice ? "stop" : "take";
}

// ── REST ────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstStart = (date: string): number => Date.parse(`${date}T00:00:00+09:00`);

/** /api/journal[/<id>|/sync] — 처리했으면 결과, 라우트가 아니면 undefined */
export async function handleJournal(
	req: IncomingMessage,
	url: URL,
	path: string,
	member: string,
	deps: { store: JournalStore; sync: JournalSync; now?: () => number },
): Promise<unknown | undefined> {
	const method = req.method ?? "GET";
	const now = deps.now?.() ?? Date.now();
	if (path === "/api/journal") {
		if (method === "GET") {
			const from = url.searchParams.get("from");
			const to = url.searchParams.get("to");
			for (const [k, v] of [["from", from], ["to", to]] as const) if (v && !DATE_RE.test(v)) throw new HttpError(400, `${k} 는 YYYY-MM-DD 형식이어야 합니다`);
			const side = url.searchParams.get("side");
			const filter: JournalFilter = {
				...(from ? { from: kstStart(from) } : {}),
				...(to ? { to: kstStart(to) + DAY } : {}),
				...(url.searchParams.get("symbol") ? { symbol: url.searchParams.get("symbol")! } : {}),
				...(side === "BUY" || side === "SELL" ? { side } : {}),
				...(url.searchParams.get("missing") === "1" ? { missingNotes: true } : {}),
				limit: Number(url.searchParams.get("limit")) || 500,
			};
			return { items: await deps.store.list(member, filter) };
		}
		if (method === "POST") {
			const body = await readJson(req);
			const { trade, notes } = valid(() => ({ trade: parseJournalTrade(body, false, now), notes: parseJournalNotes(body, false) }));
			return deps.store.create(member, { ...trade, ...notes, status: "filled", source: "manual", context: null, conversationId: null });
		}
		return undefined;
	}
	if (path === "/api/journal/sync" && method === "POST") {
		const body = await readJson(req);
		return deps.sync.run(member, { days: typeof body.days === "number" ? body.days : undefined, force: body.force === true });
	}
	const m = /^\/api\/journal\/(j[0-9a-f]{16})$/.exec(path);
	if (!m) return undefined;
	const id = m[1]!;
	if (method === "PATCH") {
		const body = await readJson(req);
		const patch = valid((): JournalPatch => ({ ...parseJournalNotes(body, true), ...(touchesTrade(body) ? parseJournalTrade(body, true, now) : {}) }));
		return deps.store.update(member, id, patch);
	}
	if (method === "DELETE") {
		await deps.store.remove(member, id);
		return { deleted: true };
	}
	return undefined;
}
