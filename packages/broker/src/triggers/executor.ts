/**
 * 체결기 (PLAN §40 2단계) — 체결 의도 하나를 **최악 허용가 안의 지정가**로 체결한다. 그것만.
 *
 * 언제·무엇을·얼마나는 규칙·리스크가 정한다. 체결기는 가격을 어떻게 낼지만 안다:
 *   immediate  qty 를 채우는 반대편 호가(최악 허용가까지)에 지정가 — IOC 가 되면 IOC, 아니면 잠깐 기다렸다 잔량 취소.
 *              최대 3번 (호가를 다시 보고). 매도·손절 기본
 *   patient    우리 쪽 최우선 호가에 걸고 stepMs 마다 한 호가씩 반대편으로 (최악 허용가까지). 기한이 되면 잔량 취소. 매수 기본
 *
 * 정정 대신 **취소 → 체결량 확인 → 새 주문** 이다. 토스·KIS 모두 정정하면 새 주문번호가 나와 어차피 따로 따라가야 하고,
 * 토스 미장은 수량을 정정할 수 없다.
 *
 * 안전 규칙:
 *   - 자식 주문은 **보내기 전에** record (D1 선기록 — 서버가 죽어도 "보내는 중" 이 남는다)
 *   - 보낸 뒤 결과를 모르면(VenueUnknown) 멈추고 unknown 으로 보고한다. 다시 보내지 않는다 —
 *     멱등성 키가 있는 곳(토스)만 **같은 clientId 로** 한 번 다시 보낸다 (주문이 하나로 유지된다)
 *   - 잔량 취소를 확인하지 못하면 unknown (살아 있는 주문이 더 체결될 수 있다)
 *   - 가격은 절대 최악 허용가를 넘지 않는다 (매수는 그 이하, 매도는 그 이상)
 *
 * 가격·수량 단위는 어댑터의 격자(grid)를 따른다 — 주식은 호가 단위표·정수 주, 코인은 거래소 규칙(tickSize·stepSize).
 * 코인은 남은 수량이 최소 수량·최소 주문금액보다 작으면 더 내지 않는다 (거래소가 거절한다).
 */
import type { OrderSide } from "../orders.ts";
import { gridOf } from "./venues/tick.ts";
import { VenueRejected, VenueUnknown, type Book, type BookLevel, type ExecVenue, type VenueOrderState } from "./venues/types.ts";

export type Urgency = "immediate" | "patient";

export interface ExecIntent {
	side: OrderSide;
	/** 주식은 정수 주, 코인은 수량 단위(stepSize)의 배수 */
	quantity: number;
	/** 매수 상한 · 매도 하한 */
	worstPrice: number;
	urgency: Urgency;
	/** 전체 제한 시간 */
	deadlineMs: number;
	/** 자식 주문 clientId 의 앞부분 (최대 30자, 영숫자·-·_) — 신호마다 하나 */
	nonce: string;
}

export type ChildState = "sending" | "open" | "done" | "rejected" | "unknown";

export interface ChildOrder {
	/** 0부터 */
	n: number;
	clientId: string;
	orderId: string | null;
	/** 어댑터가 준 값 (KIS 조직번호·주문일) — 기동 복구 때 adopt */
	ref: string | null;
	price: number;
	quantity: number;
	ioc: boolean;
	state: ChildState;
	filledQty: number;
	avgPrice: number | null;
	reason: string | null;
}

export type ExecStatus = "filled" | "partial" | "none" | "unknown";

export interface ExecReport {
	status: ExecStatus;
	filledQty: number;
	avgPrice: number | null;
	/** 시작 때 중간가 (한쪽 호가만 있으면 그 값) */
	arrivalPrice: number | null;
	/** 도착가 대비 불리한 쪽이 양수 (bp) */
	slippageBps: number | null;
	children: ChildOrder[];
	reason: string | null;
}

export interface ExecDeps {
	/** 자식 주문이 바뀔 때마다 (보내기 전 · 접수 · 끝). 실패하면 체결기를 멈춘다 — 기록 없이 주문하지 않는다 */
	record?: (c: ChildOrder) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** 주문 상태 조회 간격 (기본 1초) */
	pollMs?: number;
	/** patient 한 호가 움직이는 간격 (기본 10초) */
	stepMs?: number;
	/** immediate 에서 IOC 가 아닐 때 잔량을 기다리는 시간 (기본 3초) */
	settleMs?: number;
	/** 비상 정지 — 참이면 새 주문을 내지 않고 걸린 주문을 취소한 뒤 끝낸다 */
	shouldStop?: () => boolean;
}

const IMMEDIATE_ATTEMPTS = 3;
const STOPPED = "비상 정지로 멈췄습니다 (걸린 주문은 취소)";
/** 취소 뒤 상태가 닫힐 때까지 확인하는 횟수 */
const CANCEL_CHECKS = 5;
/** 상태 조회가 연달아 실패해도 되는 횟수 */
const STATUS_TRIES = 3;

const better = (side: OrderSide, a: number, b: number): boolean => (side === "BUY" ? a < b : a > b);
/** 최악 허용가 안인가 */
const within = (side: OrderSide, price: number, worst: number): boolean => (side === "BUY" ? price <= worst + 1e-9 : price >= worst - 1e-9);
const clamp = (side: OrderSide, price: number, worst: number): number => (within(side, price, worst) ? price : worst);

export function midPrice(book: Book): number | null {
	const b = book.bids[0]?.price;
	const a = book.asks[0]?.price;
	if (b && a) return (a + b) / 2;
	return a ?? b ?? null;
}

/** qty 를 채우는 반대편 호가 (누적 잔량), 최악 허용가로 자른다. 호가가 모자라거나 비면 최악 허용가 */
export function sweepPrice(book: Book, side: OrderSide, qty: number, worst: number): number {
	const levels: BookLevel[] = side === "BUY" ? book.asks : book.bids;
	let cum = 0;
	for (const l of levels) {
		if (!within(side, l.price, worst)) return worst;
		cum += l.volume;
		if (cum >= qty) return l.price;
	}
	return worst;
}

/** patient 시작 가격 — 우리 쪽 최우선 호가. 없으면 반대편 최우선, 그것도 없으면 최악 허용가 */
export function joinPrice(book: Book, side: OrderSide, worst: number): number {
	const own = side === "BUY" ? book.bids[0]?.price : book.asks[0]?.price;
	const other = side === "BUY" ? book.asks[0]?.price : book.bids[0]?.price;
	return clamp(side, own ?? other ?? worst, worst);
}

export function slippageBps(side: OrderSide, avg: number | null, arrival: number | null): number | null {
	if (avg === null || arrival === null || arrival <= 0) return null;
	const d = side === "BUY" ? avg - arrival : arrival - avg;
	return Math.round((d / arrival) * 10_000 * 10) / 10;
}

class Stop extends Error {
	readonly status: "unknown" | "rejected";
	constructor(status: "unknown" | "rejected", message: string) {
		super(message);
		this.status = status;
	}
}

export async function execute(intent: ExecIntent, venue: ExecVenue, deps: ExecDeps = {}): Promise<ExecReport> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? 1_000;
	const stepMs = deps.stepMs ?? 10_000;
	const settleMs = deps.settleMs ?? 3_000;
	const { side } = intent;
	const grid = gridOf(venue);

	if (!(intent.quantity > 0) || grid.floorQty(intent.quantity) !== intent.quantity) throw new Error(`수량이 올바르지 않습니다: ${intent.quantity}`);
	if (!/^[A-Za-z0-9_-]{1,30}$/.test(intent.nonce)) throw new Error(`nonce 형식이 올바르지 않습니다: ${intent.nonce}`);
	// 최악 허용가도 호가 단위로 — 매수는 내림, 매도는 올림 (허용 범위 안쪽으로)
	const worst = grid.roundPrice(intent.worstPrice, side === "BUY" ? "down" : "up");
	if (!(worst > 0)) throw new Error(`최악 허용가가 올바르지 않습니다: ${intent.worstPrice}`);

	const start = now();
	const deadline = start + intent.deadlineMs;
	const children: ChildOrder[] = [];
	let remaining = intent.quantity;
	let arrival: number | null = null;
	/** 더 낼 수 있는 잔량인가 — 주식은 1주 이상, 코인은 최소 수량 이상 */
	const more = (): boolean => remaining > 0 && remaining >= grid.minQty;
	/** 거래소 최소 주문금액 미만이면 이유 (보내면 거절된다) */
	const tooSmall = (price: number, qty: number): string | null =>
		grid.minNotional > 0 && price * qty < grid.minNotional ? `남은 수량이 최소 주문금액(${grid.minNotional})보다 작아 더 내지 않았습니다` : null;

	const record = async (c: ChildOrder) => {
		if (deps.record) await deps.record({ ...c });
	};
	const applyState = (c: ChildOrder, s: VenueOrderState) => {
		c.filledQty = Math.min(c.quantity, s.filledQty);
		c.avgPrice = s.avgPrice;
		if (s.rejected) {
			c.state = "rejected";
			c.reason = s.rejected;
		} else if (!s.open) c.state = "done";
	};

	/** 자식 주문 하나 — 보내기 전 기록 → 보내기 → 접수 기록 */
	const send = async (price: number, qty: number, ioc: boolean): Promise<ChildOrder> => {
		const n = children.length;
		if (deps.shouldStop?.()) throw new Stop("rejected", STOPPED);
		const c: ChildOrder = { n, clientId: `${intent.nonce}-${n}`, orderId: null, ref: null, price, quantity: qty, ioc, state: "sending", filledQty: 0, avgPrice: null, reason: null };
		await record(c); // 기록이 안 되면 보내지 않는다
		children.push(c);
		const req = { side, quantity: qty, price, ioc, clientId: c.clientId };
		try {
			let placed: { orderId: string; ref?: string };
			try {
				placed = await venue.place(req);
			} catch (err) {
				if (!(err instanceof VenueUnknown) || !venue.idempotent) throw err;
				// 같은 clientId 로 한 번 — 이미 접수됐으면 그 주문을 돌려받는다
				await sleep(pollMs);
				placed = await venue.place(req);
			}
			c.orderId = placed.orderId;
			c.ref = placed.ref ?? null;
			c.state = "open";
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (err instanceof VenueRejected) {
				c.state = "rejected";
				c.reason = msg;
				await record(c);
				throw new Stop("rejected", `주문 거절: ${msg}`);
			}
			c.state = "unknown";
			c.reason = msg;
			await record(c);
			throw new Stop("unknown", `주문 결과를 알 수 없습니다 (${msg}) — 증권사 앱에서 확인해 주세요`);
		}
		await record(c);
		return c;
	};

	/** 상태 조회 — 잠깐 끊기면 몇 번 더 (조회는 다시 해도 안전하다). 끝내 안 되면 결과 모름 */
	const readState = async (c: ChildOrder): Promise<VenueOrderState> => {
		let last: unknown;
		for (let i = 0; i < STATUS_TRIES; i++) {
			try {
				return await venue.status(c.orderId as string);
			} catch (err) {
				last = err;
				await sleep(pollMs);
			}
		}
		const msg = last instanceof Error ? last.message : String(last);
		c.state = "unknown";
		c.reason = `주문 상태 조회 실패: ${msg}`;
		await record(c);
		throw new Stop("unknown", `${c.reason} — 주문번호 ${c.orderId} 을(를) 증권사 앱에서 확인해 주세요`);
	};

	/** until 까지 상태를 본다. 닫히면 일찍 끝 */
	const watch = async (c: ChildOrder, until: number): Promise<void> => {
		for (;;) {
			applyState(c, await readState(c));
			if (c.state !== "open" || c.filledQty >= c.quantity) return;
			if (now() >= until || deps.shouldStop?.()) return;
			await sleep(Math.min(pollMs, Math.max(0, until - now())));
		}
	};

	/** 잔량 취소 → 닫힌 것을 확인 (그 사이 체결된 것까지 반영) */
	const close = async (c: ChildOrder): Promise<void> => {
		if (c.state !== "open") return;
		let cancelErr: string | null = null;
		try {
			await venue.cancel(c.orderId as string);
		} catch (err) {
			// 이미 다 체결됐거나 닫혔으면 취소가 거절된다 — 상태로 판단한다
			cancelErr = err instanceof Error ? err.message : String(err);
		}
		for (let i = 0; i < CANCEL_CHECKS; i++) {
			applyState(c, await readState(c));
			if (c.state !== "open") {
				await record(c);
				return;
			}
			await sleep(pollMs);
		}
		c.state = "unknown";
		c.reason = `잔량 취소를 확인하지 못했습니다${cancelErr ? ` (${cancelErr})` : ""}`;
		await record(c);
		throw new Stop("unknown", `${c.reason} — 미체결 주문이 남아 있을 수 있습니다 (주문번호 ${c.orderId})`);
	};

	const finish = async (c: ChildOrder): Promise<void> => {
		if (c.state === "open") await close(c);
		else await record(c);
		remaining = grid.floorQty(remaining - c.filledQty);
		if (c.state === "rejected") throw new Stop("rejected", `주문 거절: ${c.reason ?? "이유 없음"}`);
	};

	let reason: string | null = null;
	let stopped: Stop | null = null;
	try {
		let book = await venue.book();
		arrival = midPrice(book);

		if (intent.urgency === "immediate") {
			for (let k = 0; k < IMMEDIATE_ATTEMPTS && more(); k++) {
				if (k > 0) {
					if (now() >= deadline) break;
					const fresh = await venue.book().catch(() => null);
					if (!fresh) {
						reason = "호가 조회에 실패해 잔량을 더 내지 않았습니다";
						break;
					}
					book = fresh;
				}
				const top = side === "BUY" ? book.asks[0]?.price : book.bids[0]?.price;
				if (k > 0 && (top === undefined || !within(side, top, worst))) {
					reason = "최악 허용가 안에 남은 호가가 없습니다";
					break;
				}
				const price = sweepPrice(book, side, remaining, worst);
				const small = tooSmall(price, remaining);
				if (small) {
					reason = small;
					break;
				}
				const c = await send(price, remaining, venue.supportsIoc);
				await watch(c, venue.supportsIoc ? now() : Math.min(deadline, now() + settleMs));
				await finish(c);
			}
		} else {
			let price = joinPrice(book, side, worst);
			while (more()) {
				const small = tooSmall(price, remaining);
				if (small) {
					reason = small;
					break;
				}
				const c = await send(price, remaining, false);
				await watch(c, Math.min(deadline, now() + stepMs));
				if (c.state === "done" && c.filledQty < c.quantity) {
					// 우리가 취소하지 않았는데 닫혔다 (증권사가 닫음) — 다시 내지 않는다 (같은 일이 되풀이되면 주문을 쏟아낸다)
					await finish(c);
					reason = "증권사가 주문을 닫았습니다 (체결되지 않은 잔량)";
					break;
				}
				if (deps.shouldStop?.()) {
					await finish(c);
					throw new Stop("rejected", STOPPED);
				}
				if (c.state === "open" && c.filledQty < c.quantity && now() < deadline) {
					// 한 호가 반대편으로 (시장이 우리 쪽으로 밀려났으면 최우선 호가까지 따라간다), 최악 허용가까지
					// 호가 조회가 실패하면 호가 없이 한 칸만 (주문은 살아 있으니 멈추지 않는다)
					const fresh = await venue.book().catch(() => null);
					if (fresh) book = fresh;
					const own = fresh ? (side === "BUY" ? fresh.bids[0]?.price : fresh.asks[0]?.price) : undefined;
					let next = grid.stepPrice(price, side === "BUY" ? 1 : -1);
					if (own !== undefined && better(side, next, own)) next = own;
					next = clamp(side, next, worst);
					if (next === price) {
						// 더 움직일 수 없다 — 이 주문을 기한까지 그대로 둔다
						await watch(c, deadline);
					} else {
						await finish(c);
						price = next;
						continue;
					}
				}
				await finish(c);
				if (now() >= deadline) break;
			}
		}
		if (more() && !reason) reason = now() >= deadline ? "기한 안에 다 체결되지 않아 잔량을 취소했습니다" : "잔량을 취소했습니다";
	} catch (err) {
		if (err instanceof Stop) stopped = err;
		else if (children.length === 0) throw err; // 아무것도 보내기 전 — 호출부가 "주문 안 함" 으로 처리한다
		else stopped = new Stop("unknown", `체결 중 오류: ${err instanceof Error ? err.message : String(err)} — 증권사 앱에서 확인해 주세요`);
		reason = stopped.message;
	}

	const filled = grid.floorQty(children.reduce((s, c) => s + c.filledQty, 0));
	const amount = children.reduce((s, c) => s + (c.avgPrice ?? 0) * c.filledQty, 0);
	const avg = filled > 0 ? amount / filled : null;
	const status: ExecStatus = stopped?.status === "unknown" ? "unknown" : filled >= intent.quantity ? "filled" : filled > 0 ? "partial" : "none";
	return {
		status,
		filledQty: filled,
		avgPrice: avg,
		arrivalPrice: arrival,
		slippageBps: slippageBps(side, avg, arrival),
		children,
		reason: status === "filled" ? null : reason,
	};
}
