/**
 * 자동 매매 기록 — D1 `trigger_execs` · `trade_limits` (PLAN §40 2단계).
 *
 * 신호 하나 = 한 줄. (trigger_id, bar_t) 유니크라 같은 봉으로 두 번 주문하지 않는다 (재기동·중복 발동).
 * 체결기의 자식 주문은 **보내기 전에** 여기 기록된다 — 서버가 죽어도 "보내는 중" 이 남아 기동 복구가 본다.
 * 하루 매수 한도는 체결 금액(amount) + 진행 중인 신호의 최대 금액(reserved) 합으로 센다.
 */
import { d1Query, type D1Config } from "@alphafolio/ledger";
import { TRADE_CURRENCIES, type ChildOrder, type ExecIntent, type ExecReport, type ExecStatus, type OrderTarget, type TradeCurrency } from "@alphafolio/broker";

export type ExecState = "running" | ExecStatus;
/** 국장 KRW · 미장 USD · 코인 USDT (Binance 현물 USDT 마켓) */
export type Currency = TradeCurrency;

/** 체결 의도 + 어디로 (기동 복구가 이것만으로 어댑터를 다시 만든다) */
export interface ExecPlan extends ExecIntent {
	target: OrderTarget;
	symbol: string;
	/** 신호 때 기준가 (중간가 또는 봉 종가) */
	ref: number;
	maxAmount: number;
	/** 반복매매 복구에서 손절·정상매도를 구분 */
	rangeLeg?: "normal" | "stop";
}

export interface ExecRecord {
	id: string;
	triggerId: string;
	member: string;
	barT: number;
	broker: OrderTarget["broker"];
	symbol: string;
	side: "BUY" | "SELL";
	currency: Currency;
	day: string;
	state: ExecState;
	plan: ExecPlan;
	children: ChildOrder[];
	report: ExecReport | null;
	filledQty: number;
	amount: number;
	reserved: number;
	createdAt: number;
	updatedAt: number;
}

interface Row {
	id: string;
	trigger_id: string;
	member: string;
	bar_t: number;
	broker: string;
	symbol: string;
	side: string;
	currency: string;
	day: string;
	state: string;
	intent: string;
	children: string;
	report: string | null;
	filled_qty: number;
	amount: number;
	reserved: number;
	created_at: number;
	updated_at: number;
}

const fromRow = (r: Row): ExecRecord => ({
	id: r.id,
	triggerId: r.trigger_id,
	member: r.member,
	barT: r.bar_t,
	broker: r.broker as ExecRecord["broker"],
	symbol: r.symbol,
	side: r.side as ExecRecord["side"],
	currency: r.currency as Currency,
	day: r.day,
	state: r.state as ExecState,
	plan: JSON.parse(r.intent) as ExecPlan,
	children: JSON.parse(r.children) as ChildOrder[],
	report: r.report ? (JSON.parse(r.report) as ExecReport) : null,
	filledQty: r.filled_qty,
	amount: r.amount,
	reserved: r.reserved,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export class TradeStore {
	private readonly d1: () => D1Config;
	private readonly now: () => number;
	/** 체결이 있는 신호가 끝났다 — 매매일지 (PLAN §42). 기다리지 않고, 실패해도 체결 기록은 그대로다 */
	onFilled: ((rec: ExecRecord) => Promise<unknown>) | null = null;

	constructor(d1: () => D1Config, now: () => number = Date.now) {
		this.d1 = d1;
		this.now = now;
	}

	/**
	 * 신호 시작 — 이미 같은 (트리거, 봉) 이 있으면 false (주문하지 않는다).
	 * 매수는 최대 금액을 예약해 둔다 — 같은 사용자의 다음 신호가 한도를 계산할 때 진행 중인 것도 센다.
	 */
	async begin(e: Pick<ExecRecord, "id" | "triggerId" | "member" | "barT" | "currency" | "day" | "plan">): Promise<boolean> {
		const t = this.now();
		const reserved = e.plan.side === "BUY" ? e.plan.maxAmount : 0;
		const r = await d1Query(
			this.d1(),
			`INSERT OR IGNORE INTO trigger_execs (id, trigger_id, member, bar_t, broker, symbol, side, currency, day, state, intent, children, reserved, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, '[]', ?, ?, ?)`,
			[e.id, e.triggerId, e.member, e.barT, e.plan.target.broker, e.plan.symbol, e.plan.side, e.currency, e.day, JSON.stringify(e.plan), reserved, t, t],
		);
		return (r.meta.changes ?? 0) === 1;
	}

	/** 체결기의 record — 자식 주문이 바뀔 때마다. 실패하면 체결기가 멈춘다 (기록 없이 주문하지 않는다) */
	async saveChildren(id: string, children: ChildOrder[]): Promise<void> {
		await d1Query(this.d1(), "UPDATE trigger_execs SET children = ?, updated_at = ? WHERE id = ?", [JSON.stringify(children), this.now(), id]);
	}

	async finish(id: string, report: ExecReport): Promise<void> {
		const amount = report.buyCostAmount ?? (report.avgPrice ?? 0) * report.filledQty;
		await d1Query(
			this.d1(),
			"UPDATE trigger_execs SET state = ?, report = ?, children = ?, filled_qty = ?, amount = ?, reserved = 0, updated_at = ? WHERE id = ?",
			[report.status, JSON.stringify(report), JSON.stringify(report.children), report.filledQty, amount, this.now(), id],
		);
		const onFilled = this.onFilled;
		if (onFilled && report.filledQty > 0) {
			void d1Query<Row>(this.d1(), "SELECT * FROM trigger_execs WHERE id = ?", [id])
				.then((r) => (r.results[0] ? onFilled(fromRow(r.results[0])) : null))
				.catch((err: unknown) => console.warn(`[journal] 자동 매매 기록 실패 ${id}: ${err instanceof Error ? err.message : err}`));
		}
	}

	/** 오늘(시장 현지 날짜) 매수에 쓴 금액 — 체결 금액 + 진행 중 예약 */
	async spentToday(member: string, currency: Currency, day: string): Promise<number> {
		const r = await d1Query<{ s: number | null }>(
			this.d1(),
			"SELECT SUM(amount + reserved) AS s FROM trigger_execs WHERE member = ? AND currency = ? AND day = ? AND side = 'BUY'",
			[member, currency, day],
		);
		return Number(r.results[0]?.s ?? 0);
	}

	/** 기동 복구 — 끝나지 않은 신호 */
	async running(): Promise<ExecRecord[]> {
		const r = await d1Query<Row>(this.d1(), "SELECT * FROM trigger_execs WHERE state = 'running'");
		return r.results.map(fromRow);
	}

	async recent(member: string, limit = 20): Promise<ExecRecord[]> {
		const r = await d1Query<Row>(this.d1(), "SELECT * FROM trigger_execs WHERE member = ? ORDER BY created_at DESC LIMIT ?", [member, Math.min(Math.max(limit, 1), 100)]);
		return r.results.map(fromRow);
	}

	// ── 하루 매수 한도 ──

	async limits(member: string): Promise<Record<Currency, number | null>> {
		const r = await d1Query<{ currency: string; daily_buy: number }>(this.d1(), "SELECT currency, daily_buy FROM trade_limits WHERE member = ?", [member]);
		const out: Record<Currency, number | null> = { KRW: null, USD: null, USDT: null };
		for (const x of r.results) if ((TRADE_CURRENCIES as readonly string[]).includes(x.currency)) out[x.currency as Currency] = x.daily_buy;
		return out;
	}

	/** null = 한도 지움 (그 통화 매수 트리거는 신호가 와도 매수하지 않는다) */
	async setLimit(member: string, currency: Currency, dailyBuy: number | null): Promise<void> {
		if (dailyBuy === null) {
			await d1Query(this.d1(), "DELETE FROM trade_limits WHERE member = ? AND currency = ?", [member, currency]);
			return;
		}
		await d1Query(
			this.d1(),
			`INSERT INTO trade_limits (member, currency, daily_buy, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (member, currency) DO UPDATE SET daily_buy = excluded.daily_buy, updated_at = excluded.updated_at`,
			[member, currency, dailyBuy, new Date(this.now()).toISOString()],
		);
	}
}
