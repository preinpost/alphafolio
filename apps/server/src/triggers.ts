/**
 * 감시 트리거 저장소 — D1 `triggers` · `trigger_events` (PLAN §40).
 *
 * 감시기가 10초마다 켜진 트리거를 훑으므로 메모리 캐시를 앞에 둔다 (기동 때 적재, 쓰기마다 갱신 — SecretStore 와 같은 방식).
 * 자격증명은 없다 (웹훅 비밀값은 3단계에서 해시로).
 */
import { randomBytes } from "node:crypto";
import { d1Query, ulid, type D1Config } from "@alphafolio/ledger";
import { conditionText, evalDelay, lastClosedStart, nextCloseAt, type Condition, type TriggerAction, type TriggerSpec, type TriggerState } from "@alphafolio/broker";
import type { WatchSummary } from "@alphafolio/broker/watch-tools";

export const MAX_ACTIVE_PER_USER = 20;

export interface TriggerRecord {
	id: string;
	member: string;
	name: string;
	conversationId: string | null;
	source: { kind: "watch"; condition: Condition };
	action: TriggerAction;
	maxFires: number | null;
	cooldownSec: number;
	expiresAt: string;
	state: TriggerState;
	fires: number;
	lastBarT: number | null;
	lastFiredAt: number | null;
	lastEvalAt: number | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export type TriggerEventKind = "armed" | "fired" | "missed" | "expired" | "done" | "error" | "paused" | "resumed" | "removed" | "stopped";

export interface TriggerEvent {
	id: string;
	triggerId: string;
	member: string;
	at: number;
	kind: TriggerEventKind;
	barT: number | null;
	detail: Record<string, unknown>;
	notified: unknown;
}

export class TriggerError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface Row {
	id: string;
	member: string;
	name: string;
	conversation_id: string | null;
	source: string;
	action: string;
	max_fires: number | null;
	cooldown_sec: number;
	expires_at: string;
	state: string;
	fires: number;
	last_bar_t: number | null;
	last_fired_at: number | null;
	last_eval_at: number | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

const fromRow = (r: Row): TriggerRecord => ({
	id: r.id,
	member: r.member,
	name: r.name,
	conversationId: r.conversation_id,
	source: JSON.parse(r.source) as TriggerRecord["source"],
	action: JSON.parse(r.action) as TriggerAction,
	maxFires: r.max_fires,
	cooldownSec: r.cooldown_sec,
	expiresAt: r.expires_at,
	state: r.state as TriggerState,
	fires: r.fires,
	lastBarT: r.last_bar_t,
	lastFiredAt: r.last_fired_at,
	lastEvalAt: r.last_eval_at,
	lastError: r.last_error,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** 켜진 트리거의 다음 평가 시각 = 다음 봉 마감 + 지연 (시장 시계 — 주식은 장 마감) */
export function nextEvalAt(rec: TriggerRecord, now: number): number | null {
	if (rec.state !== "armed") return null;
	const c = rec.source.condition;
	return nextCloseAt(c, now - evalDelay(c)) + evalDelay(c);
}

/** 기준 봉 — 켜기·다시 켜기 때. 이 봉까지는 평가한 것으로 친다 */
function baseline(c: Condition, now: number): number {
	return lastClosedStart(c, now - evalDelay(c));
}

export function toSummary(rec: TriggerRecord, now: number): WatchSummary {
	return {
		id: rec.id,
		name: rec.name,
		text: conditionText(rec.source.condition),
		state: rec.state,
		fires: rec.fires,
		maxFires: rec.maxFires,
		expiresAt: rec.expiresAt,
		lastFiredAt: rec.lastFiredAt,
		lastEvalAt: rec.lastEvalAt,
		nextEvalAt: nextEvalAt(rec, now),
	};
}

/** 켤 수 있는 상태에서만 */
const ACTIVE: ReadonlySet<TriggerState> = new Set(["armed", "paused"]);

export class TriggerStore {
	private readonly d1: () => D1Config;
	private readonly now: () => number;
	private cache = new Map<string, TriggerRecord>();
	private loaded = false;

	constructor(d1: () => D1Config, now: () => number = Date.now) {
		this.d1 = d1;
		this.now = now;
	}

	async load(): Promise<void> {
		const rows = await d1Query<Row>(this.d1(), "SELECT * FROM triggers");
		const next = new Map<string, TriggerRecord>();
		for (const r of rows.results) {
			try {
				next.set(r.id, fromRow(r));
			} catch {
				console.warn(`[triggers] 읽지 못한 트리거 ${r.id} — 건너뜀`);
			}
		}
		this.cache = next;
		this.loaded = true;
	}

	get ready(): boolean {
		return this.loaded;
	}

	list(user: string): TriggerRecord[] {
		return [...this.cache.values()].filter((t) => t.member === user).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/** 이 사용자의 트리거만 (남의 id 는 \"없음\") */
	get(user: string, id: string): TriggerRecord | undefined {
		const t = this.cache.get(id);
		return t && t.member === user ? t : undefined;
	}

	armed(): TriggerRecord[] {
		return [...this.cache.values()].filter((t) => t.state === "armed");
	}

	/**
	 * 켜기 — 확인 카드의 [켜기] 로만 온다. 켜는 순간의 마지막 닫힌 봉을 기준으로 삼아
	 * **켜기 전의 봉으로는 울리지 않게** 한다 (미리보기에 나온 과거 발동이 켜자마자 오면 안 된다).
	 */
	async create(user: string, spec: TriggerSpec): Promise<TriggerRecord> {
		if (!this.loaded) throw new TriggerError(503, "감시 저장소가 준비되지 않았습니다 (서버 DB 미설정)");
		const active = this.list(user).filter((t) => ACTIVE.has(t.state)).length;
		if (active >= MAX_ACTIVE_PER_USER) throw new TriggerError(400, `감시는 ${MAX_ACTIVE_PER_USER}개까지 켤 수 있습니다 — 안 쓰는 감시를 지워 주세요`);
		if (Date.parse(spec.limits.expiresAt) <= this.now()) throw new TriggerError(400, "만료일이 지났습니다 — 다시 준비해 주세요");

		let id: string;
		do id = `w${randomBytes(4).toString("hex")}`;
		while (this.cache.has(id));
		const iso = new Date(this.now()).toISOString();
		const rec: TriggerRecord = {
			id,
			member: user,
			name: spec.name,
			conversationId: spec.conversationId,
			source: { kind: "watch", condition: spec.condition },
			action: spec.action,
			maxFires: spec.limits.maxFires,
			cooldownSec: spec.limits.cooldownSec,
			expiresAt: spec.limits.expiresAt,
			state: "armed",
			fires: 0,
			lastBarT: baseline(spec.condition, this.now()),
			lastFiredAt: null,
			lastEvalAt: null,
			lastError: null,
			createdAt: iso,
			updatedAt: iso,
		};
		await d1Query(
			this.d1(),
			`INSERT INTO triggers (id, member, name, conversation_id, source, action, max_fires, cooldown_sec, expires_at, state, fires, last_bar_t, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
			[rec.id, user, rec.name, rec.conversationId, JSON.stringify(rec.source), JSON.stringify(rec.action), rec.maxFires, rec.cooldownSec, rec.expiresAt, rec.state, rec.lastBarT, iso, iso],
		);
		this.cache.set(id, rec);
		return rec;
	}

	private async update(rec: TriggerRecord, patch: Partial<TriggerRecord>): Promise<TriggerRecord> {
		const next = { ...rec, ...patch, updatedAt: new Date(this.now()).toISOString() };
		await d1Query(
			this.d1(),
			`UPDATE triggers SET state = ?, fires = ?, last_bar_t = ?, last_fired_at = ?, last_eval_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
			[next.state, next.fires, next.lastBarT, next.lastFiredAt, next.lastEvalAt, next.lastError, next.updatedAt, rec.id],
		);
		this.cache.set(rec.id, next);
		return next;
	}

	/** 일시정지 — 에이전트·텔레그램·앱 누구나 (위험을 줄이는 쪽) */
	async pause(user: string, id: string): Promise<TriggerRecord> {
		const rec = this.get(user, id);
		if (!rec) throw new TriggerError(404, `없는 감시입니다: ${id}`);
		if (rec.state !== "armed") throw new TriggerError(400, `켜져 있는 감시가 아닙니다 (${rec.state})`);
		return this.update(rec, { state: "paused" });
	}

	/**
	 * 다시 켜기 — **앱 화면에서만** (자동 동작을 허용하는 쪽이라 켜기와 같은 무게).
	 * 멈춰 있던 동안의 봉으로는 울리지 않게 기준 봉을 지금으로 옮긴다.
	 */
	async resume(user: string, id: string): Promise<TriggerRecord> {
		const rec = this.get(user, id);
		if (!rec) throw new TriggerError(404, `없는 감시입니다: ${id}`);
		if (rec.state !== "paused") throw new TriggerError(400, `일시정지된 감시가 아닙니다 (${rec.state})`);
		if (Date.parse(rec.expiresAt) <= this.now()) throw new TriggerError(400, "이미 만료된 감시입니다 — 새로 만들어 주세요");
		return this.update(rec, { state: "armed", lastError: null, lastBarT: baseline(rec.source.condition, this.now()) });
	}

	async remove(user: string, id: string): Promise<TriggerRecord> {
		const rec = this.get(user, id);
		if (!rec) throw new TriggerError(404, `없는 감시입니다: ${id}`);
		await d1Query(this.d1(), "DELETE FROM triggers WHERE id = ?", [id]);
		this.cache.delete(id);
		return rec;
	}

	/** 비상 정지 — 이 사용자의 켜진 감시 전부 일시정지. 몇 개 멈췄는지 */
	async stopAll(user: string): Promise<number> {
		const armed = this.list(user).filter((t) => t.state === "armed");
		for (const t of armed) await this.update(t, { state: "paused" });
		return armed.length;
	}

	/** 감시기 전용 — 상태·평가 결과 반영 */
	async mark(id: string, patch: Partial<Pick<TriggerRecord, "state" | "fires" | "lastBarT" | "lastFiredAt" | "lastEvalAt" | "lastError">>): Promise<TriggerRecord | undefined> {
		const rec = this.cache.get(id);
		return rec ? this.update(rec, patch) : undefined;
	}

	async addEvent(e: Omit<TriggerEvent, "id">): Promise<TriggerEvent> {
		const ev: TriggerEvent = { id: ulid(), ...e };
		await d1Query(
			this.d1(),
			"INSERT INTO trigger_events (id, trigger_id, member, at, kind, bar_t, detail, notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[ev.id, ev.triggerId, ev.member, ev.at, ev.kind, ev.barT, JSON.stringify(ev.detail), ev.notified == null ? null : JSON.stringify(ev.notified)],
		);
		return ev;
	}

	async events(user: string, limit = 30): Promise<TriggerEvent[]> {
		const r = await d1Query<{ id: string; trigger_id: string; member: string; at: number; kind: string; bar_t: number | null; detail: string | null; notified: string | null }>(
			this.d1(),
			"SELECT * FROM trigger_events WHERE member = ? ORDER BY at DESC LIMIT ?",
			[user, Math.min(Math.max(limit, 1), 100)],
		);
		return r.results.map((x) => ({
			id: x.id,
			triggerId: x.trigger_id,
			member: x.member,
			at: x.at,
			kind: x.kind as TriggerEventKind,
			barT: x.bar_t,
			detail: x.detail ? (JSON.parse(x.detail) as Record<string, unknown>) : {},
			notified: x.notified ? (JSON.parse(x.notified) as unknown) : null,
		}));
	}
}
