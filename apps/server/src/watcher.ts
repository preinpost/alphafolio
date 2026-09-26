/**
 * 자체 감시 (PLAN §40) — 봉이 닫히면 켜진 트리거의 조건을 평가하고, 발동하면 알린다.
 *
 *   10초마다: 만료 처리 → (종목, 봉 간격) 으로 묶기 → 새로 닫힌 봉이 있는 묶음만 한 번 조회 → 트리거마다
 *   \"마지막으로 평가한 봉\" 뒤의 봉만 평가 (condition.fireIndices — 발동 규칙이 봉 배열만으로 정해진다).
 *
 * 재기동으로 놓친 봉도 같은 규칙으로 소급 평가한다. 단 **1봉 넘게 늦은 발동은 \"놓친 알림\" 으로 한 번에 묶어** 알린다
 * (주문 동작이 붙는 2단계에서는 늦은 신호로 주문하지 않는 근거가 된다).
 * 비활성화된 계정의 트리거는 끈다. 한 묶음·한 트리거의 실패가 나머지를 멈추지 않는다.
 */
import {
	barCloseAt,
	BarsError,
	CRYPTO_STEP,
	evalDelay,
	fetchWatchBars,
	fireIndices,
	isStock,
	kstShort,
	lastClosedStart,
	lateAfter,
	maxBarsFor,
	num,
	valuesText,
	valuesAt,
	warmupFor,
	type Condition,
	type WatchBar,
} from "@alphafolio/broker";
import type { NotifyMessage } from "./notify/index.ts";
import type { TriggerEventKind, TriggerRecord, TriggerStore } from "./triggers.ts";

export const TICK_MS = 10_000;

/** 감시 이벤트 — 알림 채널·앱 화면 공용 */
export interface WatchEvent {
	user: string;
	triggerId: string;
	name: string;
	kind: TriggerEventKind;
	at: number;
	message: NotifyMessage;
}

export interface WatcherOptions {
	store: TriggerStore;
	/** 알림 채널 + 앱 화면. 실패해도 던지지 않는다 (채널 결과를 돌려준다) */
	deliver: (ev: WatchEvent) => Promise<unknown>;
	/** 로그인 가능한 계정인가 — 아니면 트리거를 끈다 */
	isActive: (user: string) => boolean;
	/** 봉 조회 — 주식은 user 의 증권 키로 (서버가 묶는다). 없으면 코인만 */
	fetchBars?: (user: string, c: Condition, limit: number, now: number) => Promise<WatchBar[]>;
	now?: () => number;
}

/** 닫혔어야 할 봉이 아직 안 왔을 때 다시 조회하기까지 (휴장일·거래소 지연 — 10초마다 두드리지 않게) */
export function recheckAfter(c: Condition): number {
	return isStock(c.market.venue) ? 10 * 60_000 : 30_000;
}
/** 재기동 뒤 소급 평가할 봉 수 상한 */
const MAX_CATCHUP_BARS = 200;

export class Watcher {
	private readonly opts: WatcherOptions;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	/** 묶음별 "이 기준 봉을 찾으러 조회했는데 아직 없었다" — 휴장일에 헛조회를 막는다 */
	private readonly waiting = new Map<string, { target: number; at: number }>();

	constructor(opts: WatcherOptions) {
		this.opts = opts;
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	start(): void {
		void this.tick();
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	async tick(): Promise<void> {
		if (this.running) return; // 조회가 길어져도 겹치지 않는다
		this.running = true;
		try {
			const now = this.now();
			const groups = new Map<string, TriggerRecord[]>();
			for (const t of this.opts.store.armed()) {
				if (!this.opts.isActive(t.member)) {
					await this.opts.store.mark(t.id, { state: "off", lastError: "계정 비활성화" });
					continue;
				}
				if (Date.parse(t.expiresAt) <= now) {
					await this.finish(t, "expired", now, `만료됐습니다 (${t.expiresAt.slice(0, 10)}). 계속 보려면 새로 만들어 주세요.`);
					continue;
				}
				const c = t.source.condition;
				// 코인은 공개 시세라 모두 한 번에, 주식은 각자의 증권 키로 조회하므로 사용자별로 묶는다
				const key = `${c.market.venue}:${c.market.symbol}:${c.interval}:${c.session ?? "regular"}${isStock(c.market.venue) ? `:${t.member}` : ""}`;
				groups.set(key, [...(groups.get(key) ?? []), t]);
			}
			for (const [key, list] of groups) {
				try {
					await this.evalGroup(key, list, now);
				} catch (err) {
					console.warn(`[watch] 묶음 평가 실패: ${err instanceof Error ? err.message : err}`);
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async evalGroup(key: string, list: TriggerRecord[], now: number): Promise<void> {
		const first = list[0] as TriggerRecord;
		const c0 = first.source.condition;
		const target = lastClosedStart(c0, now - evalDelay(c0));
		const due = list.filter((t) => t.lastBarT === null || t.lastBarT < target);
		if (due.length === 0) return;
		const w = this.waiting.get(key);
		if (w && w.target === target && now - w.at < recheckAfter(c0)) return;

		// 가장 오래 못 본 트리거 기준으로 필요한 만큼 (조건에 맞춘 예열 + 놓친 봉, 상한 1000봉)
		const step = CRYPTO_STEP[c0.interval]; // 주식은 달력 기준이라 넉넉한 어림 (휴장일만큼 더 받는다)
		const oldest = Math.min(...due.map((t) => t.lastBarT ?? target - step));
		const missed = Math.min(MAX_CATCHUP_BARS, Math.ceil((target - oldest) / step));
		const warm = Math.max(...due.map((t) => warmupFor(t.source.condition)));
		const limit = Math.min(maxBarsFor(c0), warm + missed + 1);
		const at = now - evalDelay(c0);
		let bars: WatchBar[];
		try {
			bars = this.opts.fetchBars ? await this.opts.fetchBars(first.member, c0, limit, at) : await fetchWatchBars(c0, limit, { now: at });
		} catch (err) {
			const msg = err instanceof BarsError ? err.message : err instanceof Error ? err.message : String(err);
			for (const t of due) await this.opts.store.mark(t.id, { lastError: msg, lastEvalAt: now });
			this.waiting.set(key, { target, at: now });
			console.warn(`[watch] ${c0.market.venue}:${c0.market.symbol} ${c0.interval} 조회 실패: ${msg}`);
			return;
		}
		const newest = bars.at(-1)?.t;
		if (newest === undefined || newest < target) this.waiting.set(key, { target, at: now });
		else this.waiting.delete(key);
		if (newest === undefined) return;

		for (const t of due) {
			try {
				await this.evalTrigger(t, bars, newest, now);
			} catch (err) {
				console.warn(`[watch] ${t.id} 평가 실패: ${err instanceof Error ? err.message : err}`);
			}
		}
	}

	private async evalTrigger(t: TriggerRecord, bars: WatchBar[], newest: number, now: number): Promise<void> {
		const c = t.source.condition;
		const closeAt = (i: number) => barCloseAt(c, (bars[i] as WatchBar).t);
		const after = t.lastBarT ?? newest - CRYPTO_STEP[c.interval];
		if (newest <= after) return;
		const fires = fireIndices(c, bars).filter((i) => (bars[i] as WatchBar).t > after);

		let rec = t;
		// 쿨다운 안의 발동은 버린다 (봉 마감 시각 기준)
		const usable = fires.filter((i, k) => {
			const prev = k > 0 ? closeAt(fires[k - 1] as number) : rec.lastFiredAt;
			return !prev || closeAt(i) - prev >= rec.cooldownSec * 1000;
		});
		const late = usable.filter((i) => now - closeAt(i) > lateAfter(c) + evalDelay(c));
		const onTime = usable.filter((i) => !late.includes(i));

		// 놓친 발동은 하나로 묶는다 — 재기동 뒤 알림이 쏟아지지 않게
		if (late.length > 0) {
			const last = late.at(-1) as number;
			rec = await this.fire(rec, bars[last] as WatchBar, valuesAt(c, bars, last), now, { missed: late.length });
		}
		for (const i of onTime) {
			if (rec.state !== "armed") break;
			rec = await this.fire(rec, bars[i] as WatchBar, valuesAt(c, bars, i), now);
		}
		if (rec.state === "armed" || rec.state === "done") {
			await this.opts.store.mark(rec.id, { lastBarT: newest, lastEvalAt: now, lastError: null });
		}
	}

	private async fire(t: TriggerRecord, bar: WatchBar, values: Record<string, number>, now: number, opt: { missed?: number } = {}): Promise<TriggerRecord> {
		const closeAt = barCloseAt(t.source.condition, bar.t);
		const fires = t.fires + 1;
		const done = t.maxFires !== null && fires >= t.maxFires;
		const kind: TriggerEventKind = opt.missed ? "missed" : "fired";
		const lines = [
			`${kstShort(closeAt)} 마감 · ${valuesText(t.source.condition, values)}`,
			...(opt.missed ? [`⚠ 늦은 알림 — 서버가 멈춰 있던 동안 조건을 ${opt.missed}번 충족했습니다 (마지막 기준)`] : []),
			...(done ? [`최대 발동 ${t.maxFires}회를 채워 감시를 끝냈습니다.`] : []),
		];
		const message: NotifyMessage = {
			level: "important",
			title: `${t.name}`,
			lines,
			path: t.conversationId ? `/c/${t.conversationId}` : "/settings/watch",
		};
		const rec = (await this.opts.store.mark(t.id, { fires, lastFiredAt: now, ...(done ? { state: "done" as const } : {}) })) ?? t;
		const notified = await this.opts.deliver({ user: t.member, triggerId: t.id, name: t.name, kind, at: now, message });
		await this.opts.store.addEvent({ triggerId: t.id, member: t.member, at: now, kind, barT: bar.t, detail: { name: t.name, values, ...(opt.missed ? { missed: opt.missed } : {}) }, notified });
		console.log(`[watch] ${kind} user=${t.member} ${t.id} ${t.name} bar=${kstShort(bar.t)}`);
		return rec;
	}

	private async finish(t: TriggerRecord, kind: "expired", now: number, text: string): Promise<void> {
		await this.opts.store.mark(t.id, { state: kind });
		const message: NotifyMessage = { level: "info", title: `감시 만료 — ${t.name}`, lines: [text], path: "/settings/watch" };
		const notified = await this.opts.deliver({ user: t.member, triggerId: t.id, name: t.name, kind, at: now, message });
		await this.opts.store.addEvent({ triggerId: t.id, member: t.member, at: now, kind, barT: null, detail: { name: t.name }, notified });
	}
}
