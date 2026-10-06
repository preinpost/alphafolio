/**
 * 주문 실행기 (PLAN §40 2단계) — 켜진 주문 트리거의 신호를 받아 규칙 → 리스크 → 체결기 → 보고까지.
 *
 *   신호 (감시기: 봉 마감 발동) ─▶ 사용자별 직렬
 *     → 트리거가 아직 켜져 있나 · 자동 매매가 켜져 있나 · 정규장인가      ─(아니면)→ 주문 안 함 + 이유
 *     → 기준가(호가 중간가, 없으면 봉 종가) · 매도 가능 수량 → 규칙(수량·최악 허용가)
 *     → 하루 매수 한도 (체결 금액 + 진행 중 예약)
 *     → D1 에 신호 한 줄 (트리거·봉 유니크 — 같은 봉으로 두 번 주문하지 않는다)
 *     → 체결기 (자식 주문은 보내기 전에 기록) → 보고 → 알림
 *
 * 발동 횟수는 **실제로 체결됐거나 결과를 모를 때만** 센다 — 장 밖·한도 초과로 주문하지 않은 신호가 "최대 1번" 을 써 버리지 않게.
 * 결과를 모르면 그 트리거를 일시정지한다 (사람이 증권사 앱에서 확인하고 다시 켠다). 자동 재시도는 없다.
 *
 * 기동 복구: running 으로 남은 신호 — 접수된 자식 주문은 상태를 보고 살아 있으면 취소, "보내는 중" 이었던 것은 결과 모름.
 *
 * 코인(Binance 현물, PLAN §40 4단계)도 같은 길이다 — 장 시간 검사가 없고(24시간), 하루는 UTC 날짜, 한도는 USDT.
 * 수량은 코인 단위(소수)라 격자(venue.grid)로 자른다. 보호 트리거의 남은 수량이 최소 주문 단위보다 작으면(수수료로 빠진 부스러기) 끝낸다.
 */
import { randomBytes } from "node:crypto";
import { RangeRunner } from "./range-runner.ts";
import {
	cryptoAutoProblem,
	currencyOf,
	execute,
	gridOf,
	LOOSE_GRID,
	moneyText,
	qtyText,
	unitOf,
	PROTECT_EXTRA_DAYS,
	PROTECT_SELL,
	protectCondition,
	protectLeg,
	protectPrices,
	protectText,
	type TriggerSpec,
	kstShort,
	midPrice,
	planOrder,
	sessionProblem,
	sessionRemainingMs,
	dailyLimitProblem,
	sizeText,
	tradingDay,
	type ChildOrder,
	type ExecDeps,
	type ExecReport,
	type ExecVenue,
	type Grid,
	type OrderTarget,
	type WatchBar,
} from "@alphafolio/broker";
import type { NotifyMessage } from "./notify/index.ts";
import type { Currency, ExecPlan, ExecRecord, TradeStore } from "./trade-store.ts";
import type { TriggerRecord, TriggerStore } from "./triggers.ts";
import type { WatchEvent } from "./watcher.ts";

export interface OrderSignal {
	trigger: TriggerRecord;
	bar: WatchBar;
	/** 봉 마감 시각 */
	closeAt: number;
	/** 봉 평가가 아닌 현재 호가 로스컷 조회 */
	rangeRisk?: boolean;
}

export interface RunnerDeps {
	store: TriggerStore;
	trades: TradeStore;
	/** 트리거 대상 계좌의 체결 어댑터 — 키가 없거나 계좌가 켤 때와 다르면 throw (주문하지 않는다) */
	venue: (user: string, target: OrderTarget, symbol: string) => Promise<ExecVenue>;
	/** 매도 가능 수량 */
	sellable: (user: string, target: OrderTarget, symbol: string) => Promise<number>;
	deliver: (ev: WatchEvent) => Promise<unknown>;
	/** 자동 매매를 할 수 없으면 이유 (서버 설정·모의투자 키) */
	disabled: () => string | null;
	now?: () => number;
	/** 테스트 — 체결기 시계·간격 */
	exec?: Pick<ExecDeps, "sleep" | "now" | "pollMs" | "stepMs" | "settleMs">;
}

const money = (v: number, c: Currency): string => (c === "KRW" ? `${Math.round(v).toLocaleString("en-US")}원` : c === "USD" ? `$${v.toFixed(2)}` : moneyText(v, c));
const SIDE = { BUY: "매수", SELL: "매도" } as const;
const STATUS: Record<ExecReport["status"], string> = { filled: "체결", partial: "일부 체결", none: "미체결", unknown: "결과 모름" };

export function reportLines(r: ExecReport, plan: Pick<ExecPlan, "side" | "quantity">, currency: Currency, unit = "주"): string[] {
	const qty = unit === "주" ? `${r.filledQty}/${plan.quantity}주` : `${r.filledQty}/${qtyText(plan.quantity, unit)}`;
	const lines = [`${SIDE[plan.side]} ${qty}${r.avgPrice !== null ? ` · 평균 ${money(r.avgPrice, currency)}` : ""}`];
	if (r.slippageBps !== null && r.arrivalPrice !== null) lines.push(`신호 때 중간가 ${money(r.arrivalPrice, currency)} 대비 ${r.slippageBps >= 0 ? "+" : ""}${r.slippageBps}bp`);
	if (r.reason) lines.push(r.reason);
	return lines;
}

export class OrderRunner {
	private readonly d: RunnerDeps;
	private readonly range: RangeRunner;
	private readonly queues = new Map<string, Promise<void>>();
	/** 비상 정지 시각 — 그 전에 시작한 체결은 멈춘다 */
	private readonly stoppedAt = new Map<string, number>();
	/** 보호 트리거의 마지막 "주문 안 함" 이유 — 참인 봉마다 같은 알림을 보내지 않게 (재기동하면 한 번 더 온다) */
	private readonly lastSkip = new Map<string, string>();

	constructor(deps: RunnerDeps) {
		this.d = deps;
		this.range = new RangeRunner(deps);
	}

	startRangeRisk(isActive: (user: string) => boolean): void {
		this.range.start((signal) => this.submit(signal), isActive);
	}

	stopRangeRisk(): void {
		this.range.stop();
	}

	async tickRangeRisk(isActive: (user: string) => boolean): Promise<void> {
		await this.range.tickRisk((signal) => this.submit(signal), isActive);
	}

	private now(): number {
		return this.d.now?.() ?? Date.now();
	}

	/** 감시기가 부른다 — 기다리지 않는다 (체결이 1분 넘게 걸려도 다른 감시 평가를 막지 않게). 반환값은 테스트용 */
	submit(sig: OrderSignal): Promise<void> {
		const user = sig.trigger.member;
		const prev = this.queues.get(user) ?? Promise.resolve();
		const next = prev.then(() => this.handle(sig)).catch((err) => console.warn(`[trade] ${sig.trigger.id} 처리 실패: ${err instanceof Error ? err.message : err}`));
		this.queues.set(user, next);
		void next.finally(() => {
			if (this.queues.get(user) === next) this.queues.delete(user);
		});
		return next;
	}

	/** 비상 정지 — 진행 중인 체결은 걸린 주문을 취소하고 끝낸다 */
	stop(user: string): void {
		this.stoppedAt.set(user, this.now());
	}

	/** 이 사용자의 처리가 다 끝날 때까지 (테스트·종료) */
	async idle(user: string): Promise<void> {
		await this.queues.get(user);
	}

	private async skip(t: TriggerRecord, sig: OrderSignal, reason: string): Promise<void> {
		const at = this.now();
		// 보호 트리거는 참인 봉마다 온다 — 같은 이유(종가 단일가 등)로 매 봉 알리지 않는다
		if (t.action.kind === "order" && t.action.position) {
			if (this.lastSkip.get(t.id) === reason) {
				console.log(`[trade] 주문 안 함(같은 이유) user=${t.member} ${t.id} — ${reason}`);
				return;
			}
			this.lastSkip.set(t.id, reason);
		}
		const message: NotifyMessage = {
			level: "important",
			title: `${t.name} — 주문하지 않았습니다`,
			lines: [`${kstShort(sig.closeAt)} 마감에 조건 충족`, reason],
			path: t.conversationId ? `/c/${t.conversationId}` : "/settings/watch",
		};
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "skipped", at, message });
		await this.d.store.addEvent({ triggerId: t.id, member: t.member, at, kind: "skipped", barT: sig.bar.t, detail: { name: t.name, reason }, notified });
		console.log(`[trade] 주문 안 함 user=${t.member} ${t.id} — ${reason}`);
	}

	private async handle(sig: OrderSignal): Promise<void> {
		const t = this.d.store.get(sig.trigger.member, sig.trigger.id);
		if (!t || t.action.kind !== "order") return;
		if (t.action.range) return this.range.handle(sig, (started) => (this.stoppedAt.get(t.member) ?? 0) >= started);
		const { target, order } = t.action;
		const c = t.source.condition;
		const venueId = c.market.venue;
		const symbol = c.market.symbol;
		const crypto = venueId === "binance";
		const unsupported = crypto ? cryptoAutoProblem(symbol) : null;
		if (unsupported) return this.skip(t, sig, unsupported);
		if (t.state !== "armed") return this.skip(t, sig, `감시가 켜져 있지 않습니다 (${t.state})`);
		const off = this.d.disabled();
		if (off) return this.skip(t, sig, off);
		const closed = sessionProblem(venueId, this.now());
		if (closed) return this.skip(t, sig, closed);

		let venue: ExecVenue;
		try {
			venue = await this.d.venue(t.member, target, symbol);
		} catch (err) {
			return this.skip(t, sig, `증권사 연결 실패: ${err instanceof Error ? err.message : err}`);
		}
		const book = await venue.book().catch(() => null);
		const ref = (book && midPrice(book)) || sig.bar.close;
		let sellable: number | undefined;
		if (order.side === "SELL") {
			try {
				sellable = await this.d.sellable(t.member, target, symbol);
			} catch (err) {
				return this.skip(t, sig, `매도 가능 수량 조회 실패: ${err instanceof Error ? err.message : err}`);
			}
		}
		const position = t.action.position;
		if (position && sellable !== undefined && sellable <= 0) return this.closePosition(t, sig, "매도 가능 수량이 없습니다 (직접 팔았거나 옮겼습니다) — 보호를 끕니다");
		let grid: Grid;
		try {
			grid = gridOf(venue);
		} catch (err) {
			return this.skip(t, sig, err instanceof Error ? err.message : String(err));
		}
		// 보호 트리거는 남은 포지션만 판다 (보유 전체가 아니라)
		const rule = position ? { ...order, size: crypto ? { qty: position.shares } : { shares: position.shares } } : order;
		const plan = planOrder(rule, { grid, ref, sellable });
		if ("error" in plan) {
			// 코인·소수점 주식 보호 — 남은 게 최소 주문 단위보다 작다 (수수료로 빠진 부스러기). 팔 수 없으니 끝낸다
			if (position && plan.small && grid.minNotional > 0) return this.closePosition(t, sig, `${plan.error} — 남은 부스러기는 팔 수 없어 보호를 끝냅니다`);
			return this.skip(t, sig, plan.error);
		}
		const currency: Currency = currencyOf(venueId);
		const day = tradingDay(venueId, this.now());
		if (order.side === "BUY") {
			const limits = await this.d.trades.limits(t.member);
			const spent = await this.d.trades.spentToday(t.member, currency, day);
			const over = dailyLimitProblem(plan.maxAmount, spent, limits[currency], currency);
			if (over) return this.skip(t, sig, over);
		}

		const id = `x${randomBytes(8).toString("hex")}`;
		const full: ExecPlan = {
			side: order.side,
			quantity: plan.quantity,
			worstPrice: plan.worstPrice,
			urgency: order.urgency,
			// 장이 끝나기(국장은 종가 단일가) 전까지만 — 기다리는 매수가 단일가 시간으로 넘어가지 않게
			deadlineMs: Math.min(order.deadlineSec * 1000, sessionRemainingMs(venueId, this.now())),
			nonce: id,
			target,
			symbol,
			ref,
			maxAmount: plan.maxAmount,
		};
		if (!(await this.d.trades.begin({ id, triggerId: t.id, member: t.member, barT: sig.bar.t, currency, day, plan: full }))) {
			console.log(`[trade] 같은 봉 신호 — 건너뜀 ${t.id} bar=${kstShort(sig.bar.t)}`);
			return;
		}
		console.log(`[trade] 시작 user=${t.member} ${t.id} ${SIDE[order.side]} ${symbol} ${qtyText(plan.quantity, grid.unit)} 최악 ${plan.worstPrice} (${venue.label})`);

		const started = this.now();
		const children: ChildOrder[] = [];
		let report: ExecReport;
		try {
			report = await execute(full, venue, {
				...this.d.exec,
				record: async (ch) => {
					const i = children.findIndex((x) => x.n === ch.n);
					if (i >= 0) children[i] = ch;
					else children.push(ch);
					await this.d.trades.saveChildren(id, children);
				},
				shouldStop: () => (this.stoppedAt.get(t.member) ?? 0) >= started,
			});
		} catch (err) {
			// 아무것도 보내기 전의 실패 (첫 호가 조회·첫 기록) — 주문 없음
			const msg = err instanceof Error ? err.message : String(err);
			report = { status: "none", filledQty: 0, avgPrice: null, arrivalPrice: null, slippageBps: null, children, reason: `주문 전 실패: ${msg}` };
		}
		await this.d.trades.finish(id, report);
		const leg = position ? protectLeg(position, sig.bar.close) : null;
		await this.conclude(t, sig.bar.t, full, report, currency, leg ? [`${leg === "stop" ? "손절" : "익절"} — ${kstShort(sig.closeAt)} 마감 종가 ${sig.bar.close.toLocaleString("en-US")}`] : [], leg, grid);
	}

	/** 보호할 포지션이 없다 — 트리거를 끄고 알린다 */
	private async closePosition(t: TriggerRecord, sig: OrderSignal, reason: string): Promise<void> {
		await this.d.store.mark(t.id, { state: "off", lastError: reason });
		await this.skip(t, sig, reason);
	}

	/** 매수 체결 → 보호 트리거 (손절·익절 한 트리거, 체결 수량·평단으로). 사람 승인은 매수 트리거를 켤 때 이미 받았다 */
	private async armProtect(t: TriggerRecord, report: ExecReport, currency: Currency, grid?: Grid): Promise<string> {
		if (t.action.kind !== "order" || !t.action.protect || report.avgPrice === null || report.filledQty <= 0) return "";
		const p = t.action.protect;
		const avg = report.avgPrice;
		const base = t.source.condition;
		const crypto = base.market.venue === "binance";
		const unit = unitOf(base.market.venue, base.market.symbol);
		const { stopPrice, takePrice } = protectPrices(p, avg, crypto ? (grid ?? LOOSE_GRID) : currency === "KRW" ? "KR" : "US");
		const until = Math.max(Date.parse(t.expiresAt), this.now()) + PROTECT_EXTRA_DAYS * 86_400_000;
		const spec: TriggerSpec = {
			name: `${t.name} · 보호`,
			condition: protectCondition(base, p.interval, { stopPrice, takePrice }),
			action: {
				kind: "order",
				target: t.action.target,
				order: { ...PROTECT_SELL, size: crypto ? { qty: report.filledQty } : { shares: report.filledQty } },
				position: { shares: report.filledQty, avgPrice: avg, stopPrice, takePrice, parentId: t.id },
			},
			limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(until).toISOString() },
			conversationId: t.conversationId,
		};
		const rec = await this.d.store.create(t.member, spec);
		await this.d.store.addEvent({ triggerId: rec.id, member: t.member, at: this.now(), kind: "armed", barT: null, detail: { name: rec.name, by: "auto", parentId: t.id }, notified: null });
		console.log(`[trade] 보호 켬 user=${t.member} ${rec.id} ${qtyText(report.filledQty, unit)} 손절 ${stopPrice ?? "-"} 익절 ${takePrice ?? "-"}`);
		return `보호 켬 (${rec.id}): ${qtyText(report.filledQty, unit)} — ${protectText({ stopPrice, takePrice, avgPrice: avg }, p.interval)}`;
	}

	/** 보고 → 발동 횟수·상태 → 알림 (기동 복구도 여기로) */
	private async conclude(
		t0: TriggerRecord,
		barT: number,
		plan: ExecPlan,
		report: ExecReport,
		currency: Currency,
		extra: string[] = [],
		leg: "stop" | "take" | null = null,
		grid?: Grid,
	): Promise<void> {
		const t = this.d.store.get(t0.member, t0.id) ?? t0;
		const counted = report.filledQty > 0 || report.status === "unknown";
		const fires = counted ? t.fires + 1 : t.fires;
		const unit = plan.target.broker === "binance" ? unitOf("binance", plan.symbol) : "주";
		// 보호 트리거는 횟수가 아니라 남은 수량으로 끝난다 — 다 팔면 끝 (손절·익절이 한 트리거라 다른 쪽도 같이)
		const position = t.action.kind === "order" ? t.action.position : undefined;
		// 소수점 수량(코인·Binance 미국 주식)은 격자로 — 정수 주식은 그대로
		const g = grid && grid.minNotional > 0 ? grid : unit === "주" ? null : LOOSE_GRID;
		let left = position ? Math.max(0, g ? g.floorQty(position.shares - report.filledQty) : position.shares - report.filledQty) : null;
		// 코인 — 남은 게 최소 수량·최소 주문금액 미만이면 더 팔 수 없다 (수수료 부스러기)
		if (left !== null && left > 0 && g && report.filledQty > 0 && (left < g.minQty || left * (report.avgPrice ?? plan.ref) < g.minNotional)) left = 0;
		const done = position ? left === 0 : counted && t.maxFires !== null && fires >= t.maxFires;
		const alive = !!this.d.store.get(t.member, t.id);
		if (alive) {
			if (position && t.action.kind === "order" && report.filledQty > 0 && left !== null && left > 0) {
				await this.d.store.setAction(t.id, { ...t.action, position: { ...position, shares: left } });
			}
			this.lastSkip.delete(t.id);
			const patch: Parameters<TriggerStore["mark"]>[1] = { fires };
			if (report.status === "unknown") {
				patch.lastError = report.reason;
				if (t.state === "armed") patch.state = "paused";
			} else if (done && t.state === "armed") patch.state = "done";
			await this.d.store.mark(t.id, patch);
		}
		let protectLine = "";
		if (alive && plan.side === "BUY") {
			try {
				protectLine = await this.armProtect(t, report, currency, grid);
			} catch (err) {
				protectLine = `⚠ 보호(손절·익절)를 켜지 못했습니다: ${err instanceof Error ? err.message : err} — 직접 걸어 주세요`;
			}
		}
		const at = this.now();
		const lines = [
			...extra,
			...reportLines(report, plan, currency, unit),
			...(protectLine ? [protectLine] : []),
			...(report.status === "unknown" ? ["⚠ 이 감시를 일시정지했습니다 — 증권사 앱에서 주문을 확인한 뒤 다시 켜 주세요."] : []),
			...(done ? [position ? "포지션을 다 팔아 보호를 끝냈습니다." : `최대 ${t.maxFires}번을 채워 감시를 끝냈습니다.`] : []),
			...(position && !done && left !== null && report.status !== "unknown" ? [`남은 ${qtyText(left, unit)} — 다음 봉에도 조건이 맞으면 다시 팝니다.`] : []),
		];
		const what = leg === "stop" ? "손절 매도" : leg === "take" ? "익절 매도" : SIDE[plan.side];
		const message: NotifyMessage = {
			level: "important",
			title: `${t.name} — ${what} ${STATUS[report.status]}`,
			lines,
			path: t.conversationId ? `/c/${t.conversationId}` : "/settings/watch",
		};
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "ordered", at, message });
		await this.d.store.addEvent({
			triggerId: t.id,
			member: t.member,
			at,
			kind: "ordered",
			barT,
			detail: {
				name: t.name,
				side: plan.side,
				symbol: plan.symbol,
				status: report.status,
				quantity: plan.quantity,
				filledQty: report.filledQty,
				avgPrice: report.avgPrice,
				slippageBps: report.slippageBps,
				reason: report.reason,
				size: sizeText(unit === "주" ? { shares: plan.quantity } : { qty: plan.quantity }, currency, unit),
			},
			notified,
		});
		console.log(`[trade] ${report.status} user=${t.member} ${t.id} ${report.filledQty}/${plan.quantity}${unit === "주" ? "" : ` ${unit}`} avg=${report.avgPrice ?? "-"} ${report.reason ?? ""}`);
	}

	/**
	 * 기동 복구 — 이전 프로세스가 끝내지 못한 신호. 새 주문은 내지 않는다:
	 * 접수된 자식 주문은 상태를 보고 살아 있으면 취소, "보내는 중"(접수됐는지 모름)이 있으면 결과 모름.
	 */
	async recover(): Promise<number> {
		const list = await this.d.trades.running();
		let rangeRecoveryFailed = false;
		for (const rec of list) {
			try {
				await this.recoverOne(rec);
			} catch (err) {
				console.warn(`[trade] 복구 실패 ${rec.id}: ${err instanceof Error ? err.message : err}`);
				if (rec.plan.rangeLeg) rangeRecoveryFailed = true;
			}
		}
		if (rangeRecoveryFailed) throw new Error("반복매매 체결을 복구하지 못해 신규 주문을 차단합니다");
		return list.length;
	}

	private async recoverOne(rec: ExecRecord): Promise<void> {
		const children = rec.children.map((c) => ({ ...c }));
		let problem: string | null = null;
		let venue: ExecVenue | null = null;
		if (rec.plan.rangeLeg || children.some((c) => c.state === "open")) {
			try {
				venue = await this.d.venue(rec.member, rec.plan.target, rec.symbol);
			} catch (err) {
				problem = `증권사 연결 실패: ${err instanceof Error ? err.message : err}`;
			}
		}
		for (const c of children) {
			if (c.state === "sending") {
				c.state = "unknown";
				c.reason = "보내는 중에 서버가 멈췄습니다 — 접수됐는지 모릅니다";
				continue;
			}
			if (c.state !== "open" || !c.orderId) continue;
			if (!venue) {
				c.state = "unknown";
				c.reason = problem;
				continue;
			}
			try {
				venue.adopt?.({ orderId: c.orderId, ref: c.ref, side: rec.side, quantity: c.quantity, price: c.price });
				let st = await venue.status(c.orderId);
				if (st.open) {
					await venue.cancel(c.orderId);
					st = await venue.status(c.orderId);
				}
				c.filledQty = Math.min(c.quantity, st.filledQty);
				c.avgPrice = st.avgPrice;
				c.state = st.open ? "unknown" : "done";
				if (st.open) c.reason = "잔량 취소를 확인하지 못했습니다";
			} catch (err) {
				c.state = "unknown";
				c.reason = `상태 확인 실패: ${err instanceof Error ? err.message : err}`;
			}
		}
		const filled = Number(children.reduce((s, c) => s + c.filledQty, 0).toFixed(12));
		const amount = children.reduce((s, c) => s + (c.avgPrice ?? 0) * c.filledQty, 0);
		const unknown = children.some((c) => c.state === "unknown");
		const avg = filled > 0 ? amount / filled : null;
		const report: ExecReport = {
			status: unknown ? "unknown" : filled >= rec.plan.quantity ? "filled" : filled > 0 ? "partial" : "none",
			filledQty: filled,
			avgPrice: avg,
			arrivalPrice: rec.plan.ref,
			slippageBps: null,
			children,
			reason: unknown ? (children.find((c) => c.state === "unknown")?.reason ?? "결과 모름") : "서버 재시작으로 체결을 중단했습니다 (잔량 취소)",
		};
		if (rec.plan.rangeLeg) {
			await this.range.recover(rec, report, venue);
			return;
		}
		await this.d.trades.finish(rec.id, report);
		const t = this.d.store.get(rec.member, rec.triggerId);
		const stub = t ?? ({ id: rec.triggerId, member: rec.member, name: rec.symbol, conversationId: null, fires: 0, maxFires: null, state: "off" } as unknown as TriggerRecord);
		await this.conclude(stub, rec.barT, rec.plan, report, rec.currency, ["⚠ 서버가 체결 도중 멈췄습니다 — 다시 시작하면서 정리했습니다."]);
	}
}
