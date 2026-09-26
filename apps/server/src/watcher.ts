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
	BarsError,
	fetchBinanceBars,
	fireIndices,
	INTERVAL_MS,
	kstShort,
	lastClosedBarStart,
	MAX_BARS,
	num,
	SERIES_LABEL,
	valuesAt,
	WARMUP_BARS,
	type SeriesName,
	type WatchBar,
} from "@alphafolio/broker";
import type { NotifyMessage } from "./notify/index.ts";
import { EVAL_DELAY_MS, type TriggerEventKind, type TriggerRecord, type TriggerStore } from "./triggers.ts";

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
	fetchBars?: typeof fetchBinanceBars;
	now?: () => number;
}

/** \"종가 2,594.2 · RSI(14) 28.1\" */
export function valuesText(values: Partial<Record<SeriesName, number>>): string {
	return Object.entries(values)
		.map(([k, v]) => `${SERIES_LABEL[k as SeriesName]} ${num(Math.round((v as number) * 100) / 100)}`)
		.join(" · ");
}

export class Watcher {
	private readonly opts: WatcherOptions;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;

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
				const key = `${c.market.venue}:${c.market.symbol}:${c.interval}`;
				groups.set(key, [...(groups.get(key) ?? []), t]);
			}
			for (const list of groups.values()) {
				try {
					await this.evalGroup(list, now);
				} catch (err) {
					console.warn(`[watch] 묶음 평가 실패: ${err instanceof Error ? err.message : err}`);
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async evalGroup(list: TriggerRecord[], now: number): Promise<void> {
		const c0 = (list[0] as TriggerRecord).source.condition;
		const step = INTERVAL_MS[c0.interval];
		const target = lastClosedBarStart(now - EVAL_DELAY_MS, c0.interval);
		const due = list.filter((t) => t.lastBarT === null || t.lastBarT < target);
		if (due.length === 0) return;

		// 가장 오래 못 본 트리거 기준으로 필요한 만큼 (예열 포함, 상한 1000봉)
		const oldest = Math.min(...due.map((t) => t.lastBarT ?? target - step));
		const missed = Math.ceil((target - oldest) / step);
		let bars: WatchBar[];
		try {
			bars = await (this.opts.fetchBars ?? fetchBinanceBars)(c0.market.symbol, c0.interval, Math.min(MAX_BARS, WARMUP_BARS + missed + 1), { now: now - EVAL_DELAY_MS });
		} catch (err) {
			const msg = err instanceof BarsError ? err.message : String(err);
			for (const t of due) await this.opts.store.mark(t.id, { lastError: msg, lastEvalAt: now });
			console.warn(`[watch] ${c0.market.symbol} ${c0.interval} 조회 실패: ${msg}`);
			return;
		}
		const newest = bars.at(-1)?.t;
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
		const step = INTERVAL_MS[c.interval];
		const after = t.lastBarT ?? newest - step;
		const fires = fireIndices(c, bars).filter((i) => (bars[i] as WatchBar).t > after);

		let rec = t;
		// 쿨다운 안의 발동은 버린다 (봉 마감 시각 기준)
		const usable = fires.filter((i, k) => {
			const closeAt = (bars[i] as WatchBar).t + step;
			const prev = k > 0 ? (bars[fires[k - 1] as number] as WatchBar).t + step : rec.lastFiredAt;
			return !prev || closeAt - prev >= rec.cooldownSec * 1000;
		});
		const late = usable.filter((i) => now - ((bars[i] as WatchBar).t + step) > step + EVAL_DELAY_MS);
		const onTime = usable.filter((i) => !late.includes(i));

		// 놓친 발동은 하나로 묶는다 — 재기동 뒤 알림이 쏟아지지 않게
		if (late.length > 0) {
			const last = late.at(-1) as number;
			const bar = bars[last] as WatchBar;
			rec = await this.fire(rec, bar, valuesAt(c, bars, last), now, { missed: late.length });
		}
		for (const i of onTime) {
			if (rec.state !== "armed") break;
			rec = await this.fire(rec, bars[i] as WatchBar, valuesAt(c, bars, i), now);
		}
		if (rec.state === "armed" || rec.state === "done") {
			await this.opts.store.mark(rec.id, { lastBarT: newest, lastEvalAt: now, lastError: null });
		}
	}

	private async fire(t: TriggerRecord, bar: WatchBar, values: Partial<Record<SeriesName, number>>, now: number, opt: { missed?: number } = {}): Promise<TriggerRecord> {
		const step = INTERVAL_MS[t.source.condition.interval];
		const fires = t.fires + 1;
		const done = t.maxFires !== null && fires >= t.maxFires;
		const kind: TriggerEventKind = opt.missed ? "missed" : "fired";
		const lines = [
			`${kstShort(bar.t + step)} 마감 · ${valuesText(values)}`,
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
