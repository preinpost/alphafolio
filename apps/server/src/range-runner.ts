/**
 * 반복매매 실행기. OrderRunner의 사용자별 직렬 큐를 공유한다.
 * 설정·포지션은 triggers.action JSON, 체결 의도·자식 주문은 기존 TradeStore에 영속화한다.
 * 보고 반영을 먼저 저장하고 실행을 완료한다. 마지막 실행 id로 복구 시 이중 반영을 막는다.
 */
import { randomBytes } from "node:crypto";
import {
	applyRangeReport, currencyOf, dailyLimitProblem, evalDelay, execute, gridOf, lateAfter,
	moneyText, planOrder, qtyText, rangeFillCost, rangeStopHit, rangeValuation,
	RANGE_PHASE_LABEL, RANGE_RISK_MS, sessionProblem, sessionRemainingMs, tradingDay, validateRange,
	type ChildOrder, type ExecReport, type ExecVenue, type Grid,
	type OrderRule, type RangeState, type RangeTrade, type TriggerAction,
} from "@alphafolio/broker";
import type { OrderSignal, RunnerDeps } from "./order-runner.ts";
import type { ExecPlan, ExecRecord } from "./trade-store.ts";
import type { TriggerRecord } from "./triggers.ts";

type RangeAction = Extract<TriggerAction, { kind: "order" }> & { range: RangeTrade };
type RangeRecord = TriggerRecord & { action: RangeAction };
interface RangeQuote {
	venue: ExecVenue;
	bid: number;
	ask: number;
}

const isRange = (t: TriggerRecord): t is RangeRecord => t.action.kind === "order" && !!t.action.range;

function withRangeState(action: RangeAction, patch: Partial<RangeState>): RangeAction {
	return { ...action, range: { ...action.range, state: { ...action.range.state, ...patch } } };
}

function orderBoundary(range: RangeTrade, side: "BUY" | "SELL", lossCut: boolean, worstPrice: number): number {
	if (side === "BUY") return Math.min(worstPrice, range.buyPrice);
	if (lossCut) return worstPrice;
	return Math.max(worstPrice, range.sellPrice);
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const BOOK_MAX_AGE_MS = 15_000;

export class RangeRunner {
	private readonly d: RunnerDeps;
	private timer: ReturnType<typeof setInterval> | undefined;
	private riskRunning = false;
	private readonly quoteFailures = new Set<string>();

	constructor(deps: RunnerDeps) {
		this.d = deps;
	}

	private now(): number {
		return this.d.now?.() ?? Date.now();
	}

	start(submit: (signal: OrderSignal) => Promise<void>, isActive: (user: string) => boolean): void {
		if (this.timer) return;
		const tick = () => void this.tickRisk(submit, isActive).catch((error) => console.warn("[range] 로스컷 감시 실패:", errorText(error)));
		tick();
		this.timer = setInterval(tick, RANGE_RISK_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** 신호를 큐에 넣기 전에 사용자별로 하나씩만 처리한다. 느린 조회 중 타이머가 중첩되지 않는다. */
	async tickRisk(submit: (signal: OrderSignal) => Promise<void>, isActive: (user: string) => boolean): Promise<void> {
		if (this.riskRunning) return;
		this.riskRunning = true;
		try {
			const byUser = new Map<string, TriggerRecord[]>();
			for (const t of this.d.store.armed()) {
				if (!isRange(t) || !isActive(t.member) || t.action.range.state.qty <= 0) continue;
				const list = byUser.get(t.member) ?? [];
				list.push(t);
				byUser.set(t.member, list);
			}
			await Promise.all([...byUser.values()].map(async (list) => {
				for (const trigger of list) {
					const now = this.now();
					// 음수 키는 봉 신호와 충돌하지 않는다. 손절 잔량 재시도도 각각 선기록한다.
					const bar = { t: -now, open: 0, high: 0, low: 0, close: 0, volume: 0 };
					await submit({ trigger, bar, closeAt: now, rangeRisk: true });
				}
			}));
		} finally {
			this.riskRunning = false;
		}
	}

	async handle(signal: OrderSignal, stopped: (startedAt: number) => boolean): Promise<void> {
		const current = this.active(signal.trigger.member, signal.trigger.id);
		if (!current || !this.canEvaluate(current, signal)) return;
		if (validateRange(current.action.range).length) return this.block(current, "반복매매 설정이 올바르지 않습니다");

		const quote = await this.readQuote(current);
		if (!quote) return;
		const t = await this.latchLossCut(current, quote.bid);
		if (!t) return;
		const side = this.chooseSide(t.action.range, signal, quote.bid);
		if (!side) return;

		const plan = await this.buildPlan(t, side, quote);
		if (!plan || !this.active(t.member, t.id)) return;
		const currency = currencyOf(t.source.condition.market.venue);
		const day = tradingDay(t.source.condition.market.venue, this.now());
		const id = plan.nonce;
		const begun = await this.d.trades.begin({
			id, triggerId: t.id, member: t.member, barT: signal.bar.t, currency, day, plan,
		});
		if (!begun) return;

		await this.d.store.setAction(t.id, withRangeState(t.action, { pendingExecId: id }));
		const report = await this.executePlan(t, id, plan, quote.venue, stopped);
		await this.complete(t, id, signal.bar.t, plan, report, gridOf(quote.venue));
	}

	private active(user: string, id: string): RangeRecord | undefined {
		const record = this.d.store.get(user, id);
		return record && isRange(record) && record.state === "armed" ? record : undefined;
	}

	private canEvaluate(t: RangeRecord, signal: OrderSignal): boolean {
		const state = t.action.range.state;
		if (state.phase === "stopped" || state.phase === "blocked" || state.pendingExecId) return false;
		if (this.d.disabled()) return false;
		const condition = t.source.condition;
		if (sessionProblem(condition.market.venue, this.now())) return false;
		if (signal.rangeRisk) return true;
		if (!Number.isFinite(signal.bar.close) || signal.bar.close <= 0) return false;
		if (state.lastTradeBarT !== null && signal.bar.t <= state.lastTradeBarT) return false;
		return this.now() - signal.closeAt <= lateAfter(condition) + evalDelay(condition);
	}

	private async readQuote(t: RangeRecord): Promise<RangeQuote | null> {
		try {
			const venue = await this.d.venue(t.member, t.action.target, t.source.condition.market.symbol);
			const book = await venue.book();
			const bid = book.bids[0]?.price ?? 0;
			const ask = book.asks[0]?.price ?? 0;
			const age = this.now() - book.at;
			const validPrices = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && bid <= ask;
			const fresh = Number.isFinite(age) && age >= -1_000 && age <= BOOK_MAX_AGE_MS;
			if (!validPrices || !fresh) throw new Error("신선한 양방향 호가를 확인하지 못했습니다");
			this.quoteFailures.delete(t.id);
			if (t.lastError?.startsWith("로스컷·주문 호가 조회 실패:")) await this.d.store.mark(t.id, { lastError: null });
			return { venue, bid, ask };
		} catch (error) {
			await this.quoteFailure(t, errorText(error));
			return null;
		}
	}

	private async quoteFailure(t: RangeRecord, reason: string): Promise<void> {
		await this.d.store.mark(t.id, { lastError: `로스컷·주문 호가 조회 실패: ${reason}` });
		if (t.action.range.state.qty <= 0 || this.quoteFailures.has(t.id)) return;
		this.quoteFailures.add(t.id);
		const at = this.now();
		const message = {
			level: "important" as const,
			title: `${t.name} — 로스컷 감시가 지연되고 있습니다`,
			lines: [reason, "현재 호가를 확인할 수 없어 주문하지 않았습니다. 보유분과 계좌를 확인해 주세요. 조회가 복구되면 감시를 계속합니다."],
			path: "/settings/watch",
		};
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "error", at, message });
		await this.d.store.addEvent({ triggerId: t.id, member: t.member, at, kind: "error", barT: null, detail: { name: t.name, reason }, notified });
	}

	/** 손절 여부는 주문 전에 영속화한다. 가격이 회복되거나 재시작해도 손절을 취소하지 않는다. */
	private async latchLossCut(t0: RangeRecord, bid: number): Promise<RangeRecord | undefined> {
		const t = this.active(t0.member, t0.id);
		if (!t) return undefined;
		const range = t.action.range;
		if (range.state.phase === "liquidating" || !rangeStopHit(range, bid)) return t;
		await this.d.store.setAction(t.id, withRangeState(t.action, { phase: "liquidating" }));
		return this.active(t.member, t.id);
	}

	private chooseSide(range: RangeTrade, signal: OrderSignal, bid: number): "BUY" | "SELL" | null {
		if (range.state.phase === "liquidating") return "SELL";
		if (signal.rangeRisk) return null;
		if (range.state.phase === "holding") return signal.bar.close >= range.sellPrice ? "SELL" : null;
		if (range.state.phase !== "buying" || signal.bar.close > range.buyPrice) return null;
		// 이미 고정 손절가 아래로 이탈한 박스권에는 새로 진입하지 않는다.
		if ("price" in range.stop && bid <= range.stop.price) return null;
		return "BUY";
	}

	private async sellable(t: RangeRecord, grid: Grid): Promise<number | null> {
		try {
			const qty = await this.d.sellable(t.member, t.action.target, t.source.condition.market.symbol);
			if (!Number.isFinite(qty) || qty < 0) throw new Error("매도 가능 수량이 올바르지 않습니다");
			if (grid.floorQty(qty) >= grid.floorQty(t.action.range.state.qty)) return qty;
			await this.block(t, "전략 보유분과 매도 가능 수량이 다릅니다 — 외부 주문·이체·수수료를 확인해 주세요");
		} catch (error) {
			await this.d.store.mark(t.id, { lastError: `매도 가능 수량 조회 실패: ${errorText(error)}` });
		}
		return null;
	}

	private async buyWithinLimit(t: RangeRecord, amount: number): Promise<boolean> {
		const venue = t.source.condition.market.venue;
		const currency = currencyOf(venue);
		const limits = await this.d.trades.limits(t.member);
		const spent = await this.d.trades.spentToday(t.member, currency, tradingDay(venue, this.now()));
		const problem = dailyLimitProblem(amount, spent, limits[currency], currency);
		if (!problem) return true;
		await this.d.store.mark(t.id, { lastError: problem });
		return false;
	}

	private async buildPlan(t: RangeRecord, side: "BUY" | "SELL", quote: RangeQuote): Promise<ExecPlan | null> {
		const range = t.action.range;
		const grid = gridOf(quote.venue);
		const ref = side === "BUY" ? quote.ask : quote.bid;
		const available = side === "SELL" ? await this.sellable(t, grid) : undefined;
		if (available === null) return null;
		const rule = this.orderRule(t.action, range, side);
		const orderPlan = planOrder(rule, { grid, ref, sellable: available });
		if ("error" in orderPlan) {
			if (side === "SELL" && orderPlan.small && await this.finishUntradable(t, grid, ref, orderPlan.error)) return null;
			await this.d.store.mark(t.id, { lastError: orderPlan.error });
			return null;
		}
		const lossCut = range.state.phase === "liquidating";
		const boundary = orderBoundary(range, side, lossCut, orderPlan.worstPrice);
		const worstPrice = grid.roundPrice(boundary, side === "BUY" ? "down" : "up");
		const maxAmount = orderPlan.quantity * worstPrice * (side === "BUY" ? 1 + range.buyCostPct / 100 : 1);
		if (side === "BUY" && !await this.buyWithinLimit(t, maxAmount)) return null;

		return {
			side,
			quantity: orderPlan.quantity,
			worstPrice,
			urgency: "immediate",
			deadlineMs: Math.min(30_000, sessionRemainingMs(t.source.condition.market.venue, this.now())),
			nonce: `x${randomBytes(8).toString("hex")}`,
			target: t.action.target,
			symbol: t.source.condition.market.symbol,
			ref,
			maxAmount,
			rangeLeg: lossCut ? "stop" : "normal",
		};
	}
	private orderRule(action: RangeAction, range: RangeTrade, side: "BUY" | "SELL"): OrderRule {
		if (side === "SELL") {
			const size = "qty" in action.order.size || action.target.broker === "binance" ? { qty: range.state.qty } : { shares: range.state.qty };
			return { ...action.order, side, size, worstPct: 2 };
		}
		const size = "amount" in action.order.size ? { amount: action.order.size.amount / (1 + range.buyCostPct / 100) } : action.order.size;
		return { ...action.order, size };
	}

	private async executePlan(t: TriggerRecord, id: string, plan: ExecPlan, venue: ExecVenue, stopped: (startedAt: number) => boolean): Promise<ExecReport> {
		const started = this.now();
		const children: ChildOrder[] = [];
		let report: ExecReport;
		try {
			report = await execute(plan, venue, {
				...this.d.exec,
				record: async (child) => {
					const index = children.findIndex((old) => old.n === child.n);
					if (index < 0) children.push(child);
					else children[index] = child;
					await this.d.trades.saveChildren(id, children);
				},
				shouldStop: () => stopped(started) || this.d.store.get(t.member, t.id)?.state !== "armed",
			});
		} catch (error) {
			report = { status: children.length ? "unknown" : "none", filledQty: 0, avgPrice: null, arrivalPrice: null, slippageBps: null, children, reason: errorText(error) };
		}
		await this.collectCosts(id, report, venue);
		return report;
	}

	/** 비용 정보는 보고 반영 전에 자식 주문과 함께 저장한다. 금액 비용은 추정 가능, 순수량은 추측하지 않는다. */
	async collectCosts(id: string, report: ExecReport, venue: ExecVenue | null): Promise<void> {
		if (report.status === "unknown") return;
		try {
			if (report.filledQty > 0 && !venue) throw new Error("체결 비용 조회용 계좌에 연결할 수 없습니다");
			for (const child of report.children) {
				if (child.filledQty <= 0 || child.settlement || !venue?.settlement || !child.orderId) continue;
				child.settlement = await venue.settlement(child.orderId, child.filledQty);
			}
			await this.d.trades.saveChildren(id, report.children);
		} catch (error) {
			report.status = "unknown";
			report.reason = `체결 비용·순수량 확인 실패: ${errorText(error)} — 전략을 정지하고 확인해야 합니다`;
		}
	}

	/** 복구에서도 호출. 현재 레코드를 다시 읽어 사용자의 일시정지 상태를 보존한다. */
	async complete(t0: TriggerRecord, id: string, barT: number, plan: ExecPlan, report: ExecReport, grid?: Grid): Promise<void> {
		const t = this.d.store.get(t0.member, t0.id);
		if (!t || !isRange(t)) {
			// 선기록 중 삭제된 전략에는 주문을 보내지 않는다. 빈 실행 기록만 안전하게 정리한다.
			if (report.children.length === 0 && report.filledQty === 0 && report.status !== "unknown") {
				await this.d.trades.finish(id, report);
				return;
			}
			throw new Error("반복매매 체결의 전략 레코드가 없습니다");
		}
		let next: RangeTrade;
		try {
			const fill = rangeFillCost(report, plan.side, plan.side === "BUY" ? t.action.range.buyCostPct : t.action.range.sellCostPct);
			if (plan.side === "BUY") report.buyCostAmount = fill.amount;
			next = applyRangeReport(t.action.range, id, plan.side, report, barT);
			if (grid && plan.side === "SELL" && report.status !== "unknown" && next.state.qty > 0) next = this.recordDust(next, grid, report.avgPrice ?? plan.ref);
		} catch (error) {
			report.status = "unknown";
			report.reason = `체결 회계 확인 실패: ${errorText(error)}`;
			const state = t.action.range.state;
			next = withRangeState(t.action, {
				phase: "blocked",
				lastExecId: id,
				pendingExecId: null,
				executions: state.executions + (state.lastExecId === id ? 0 : 1),
			}).range;
		}
		await this.d.store.setAction(t.id, { ...t.action, range: next });
		await this.d.trades.finish(id, report);
		const state = next.state;
		const patch = {
			fires: state.executions,
			lastFiredAt: this.now(),
			lastError: report.reason,
			...(state.phase === "blocked" ? { state: "paused" as const } : state.phase === "stopped" ? { state: "off" as const } : {}),
		};
		await this.d.store.mark(t.id, patch);
		await this.notify(t, barT, plan, report, next);
	}

	private recordDust(range: RangeTrade, grid: Grid, price: number): RangeTrade {
		const state = range.state;
		const tradable = grid.floorQty(state.qty);
		if (tradable >= grid.minQty && tradable > 0 && tradable * price >= grid.minNotional) return range;
		return {
			...range,
			state: {
				...state, qty: 0, cost: 0, cycles: state.cycles + 1,
				dustQty: state.dustQty + state.qty, dustCost: state.dustCost + state.cost,
				phase: state.phase === "liquidating" ? "stopped" : "buying",
			},
		};
	}

	/** 전체 보유분이 최소 주문 단위 미만이면 주문 없이 별도 잔량으로 남기고 명시적으로 알린다. */
	private async finishUntradable(t: RangeRecord, grid: Grid, price: number, reason: string): Promise<boolean> {
		const range = this.recordDust(t.action.range, grid, price);
		if (range.state.qty > 0) return false;
		await this.d.store.setAction(t.id, { ...t.action, range });
		await this.d.store.mark(t.id, {
			lastError: reason,
			...(range.state.phase === "stopped" ? { state: "off" as const } : {}),
		});
		const at = this.now();
		const message = {
			level: "important" as const,
			title: `${t.name} — 잔량을 매도할 수 없습니다`,
			lines: [reason, `최소 주문 단위 미만 잔량 ${qtyText(range.state.dustQty, grid.unit)}을 별도 보유로 기록했습니다.`, ...(range.state.phase === "stopped" ? ["로스컷 전략을 종료했습니다. 매도하지 못한 잔량은 계좌에 남아 있습니다."] : [])],
			path: "/settings/watch",
		};
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "error", at, message });
		await this.d.store.addEvent({ triggerId: t.id, member: t.member, kind: "error", at, barT: null, detail: { name: t.name, reason }, notified });
		return true;
	}

	private async block(t: RangeRecord, reason: string): Promise<void> {
		await this.d.store.setAction(t.id, withRangeState(t.action, { phase: "blocked" }));
		await this.d.store.mark(t.id, { state: "paused", lastError: reason });
		const at = this.now();
		const message = { level: "important" as const, title: `${t.name} — 확인이 필요합니다`, lines: [reason, "자동 재매수와 재개를 차단했습니다. 계좌의 주문·잔고를 확인해 주세요."], path: "/settings/watch" };
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "error", at, message });
		await this.d.store.addEvent({ triggerId: t.id, member: t.member, kind: "error", at, barT: null, detail: { name: t.name, reason }, notified });
	}

	private async notify(t: TriggerRecord, barT: number, plan: ExecPlan, report: ExecReport, range: RangeTrade): Promise<void> {
		const currency = currencyOf(t.source.condition.market.venue);
		const unit = plan.target.broker === "binance" ? t.source.condition.market.symbol.replace(/USDT$/, "") : "주";
		const state = range.state;
		const value = rangeValuation(range, plan.ref);
		const lines = [
			`${plan.side === "BUY" ? "매수" : "매도"} ${qtyText(report.filledQty, unit)}${report.avgPrice ? ` · 평균 ${moneyText(report.avgPrice, currency)}` : ""}`,
			`전략 상태: ${RANGE_PHASE_LABEL[state.phase]} · 종료된 회차 ${state.cycles}회`,
			`실현 순손익 ${moneyText(state.realizedPnl, currency)}${state.pnlEstimated ? " (비용 추정 포함)" : ""}`,
			...(plan.side === "BUY" && state.qty > 0 ? [`매입원가 ${moneyText(state.cost, currency)}${state.buyEstimated ? " (매수 비용 추정)" : " (확인된 매수 비용 포함)"}`] : []),
			...(value ? [`예상 순평가손익률 ${value.pnlPct.toFixed(2)}% (매도 비용 추정 포함)`] : []),
			...(state.dustQty > 0 ? [`최소 주문 단위 미만 잔량 ${qtyText(state.dustQty, unit)}은 매도하지 못해 별도 보유로 기록했습니다.`] : []),
			...(report.reason ? [report.reason] : []),
			...(state.phase === "stopped" ? ["로스컷으로 반복매매를 종료했습니다. 자동으로 다시 시작하지 않습니다."] : []),
			...(state.phase === "blocked" ? ["주문·잔고 확인이 필요해 전략을 일시정지했습니다. 자동 재매수와 일반 재개를 차단했습니다."] : []),
		];
		const at = this.now();
		const message = { level: "important" as const, title: `${t.name} — ${plan.rangeLeg === "stop" ? "로스컷" : "반복매매"} ${report.status}`, lines, path: t.conversationId ? `/c/${t.conversationId}` : "/settings/watch" };
		const notified = await this.d.deliver({ user: t.member, triggerId: t.id, name: t.name, kind: "ordered", at, message });
		await this.d.store.addEvent({ triggerId: t.id, member: t.member, at, kind: "ordered", barT: barT < 0 ? null : barT, detail: { name: t.name, side: plan.side, symbol: plan.symbol, status: report.status, filledQty: report.filledQty, avgPrice: report.avgPrice, range: state, reason: report.reason }, notified });
	}

	/** OrderRunner가 정리한 보고를 반영한다. 새 주문은 내지 않는다. */
	async recover(rec: ExecRecord, report: ExecReport, venue: ExecVenue | null): Promise<void> {
		const t = this.d.store.get(rec.member, rec.triggerId);
		if (!t || !isRange(t)) {
			if (report.children.length === 0 && report.filledQty === 0 && report.status !== "unknown") {
				await this.d.trades.finish(rec.id, report);
				return;
			}
			throw new Error("체결 기록이 있으나 반복매매 전략을 찾지 못했습니다");
		}
		if (rec.plan.rangeLeg === "stop" && t.action.range.state.lastExecId !== rec.id) {
			await this.d.store.setAction(t.id, withRangeState(t.action, { phase: "liquidating" }));
		}
		await this.collectCosts(rec.id, report, venue);
		await this.complete(t, rec.id, rec.barT, rec.plan, report, venue ? gridOf(venue) : undefined);
	}
}
