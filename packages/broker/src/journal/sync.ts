/**
 * 체결 가져오기 계획 (순수) — 증권사 체결 내역과 이미 있는 일지를 맞춘다.
 *
 * 1. 체결을 묶는다 — 정정 주문(parentRef)은 원주문과 한 묶음 (주문번호가 바뀌어도 한 번의 매매다)
 * 2. 묶음의 ref 가 일지에 있으면 그 줄 (앱에서 정정한 주문은 원주문·새 주문이 따로 와도 같은 줄의 ref 라 함께 센다):
 *      order·import → 수량·평단·수수료·상태를 증권사 값으로 다시 맞춘다 (pending → filled/canceled)
 *      auto·manual  → 건드리지 않는다 (자동 매매는 체결기 보고가, 직접 기록은 사람이 맞다)
 * 3. 없으면 새 줄 (import) — 체결이 있고 더 체결될 여지가 없을 때만. 미체결·체결 0 은 넣지 않는다
 *    claimed(이미 쓴 ref 전부)에 있으면 넣지 않는다 — 사용자가 지운 기록이 다시 살아나지 않게 (지워도 ref 는 남긴다)
 */
import type { BrokerFill, JournalInput, JournalSource, JournalStatus } from "./types.ts";

export interface KnownEntry {
	id: string;
	source: JournalSource;
	status: JournalStatus;
	quantity: number;
	price: number | null;
	fee: number | null;
	name: string | null;
	refs: string[];
}

export interface SyncUpdate {
	id: string;
	addRefs: string[];
	patch: { status: JournalStatus; quantity: number; price: number | null; fee: number | null; name?: string };
}

export interface SyncInsert {
	refs: string[];
	input: JournalInput;
}

export interface SyncPlan {
	updates: SyncUpdate[];
	inserts: SyncInsert[];
}

interface Aggregate {
	refs: string[];
	filled: number;
	price: number | null;
	fee: number | null;
	open: boolean;
	first: BrokerFill;
	at: number;
	name: string | null;
}

/** 소수 수량(코인)의 덧셈 오차를 지운다 */
const clean = (v: number): number => Number(v.toPrecision(12));

/** 정정 사슬을 한 묶음으로 (union-find) */
function groups(fills: readonly BrokerFill[]): BrokerFill[][] {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r)!;
		parent.set(x, r);
		return r;
	};
	const add = (x: string): void => {
		if (!parent.has(x)) parent.set(x, x);
	};
	for (const f of fills) {
		add(f.ref);
		if (f.parentRef) {
			add(f.parentRef);
			parent.set(find(f.ref), find(f.parentRef));
		}
	}
	const by = new Map<string, BrokerFill[]>();
	for (const f of fills) {
		const k = find(f.ref);
		by.set(k, [...(by.get(k) ?? []), f]);
	}
	return [...by.values()];
}

function aggregate(group: readonly BrokerFill[]): Aggregate {
	const filled = clean(group.reduce((s, f) => s + f.filled, 0));
	const priced = group.filter((f) => f.filled > 0 && f.price !== null);
	const pricedQty = priced.reduce((s, f) => s + f.filled, 0);
	const price = pricedQty > 0 ? Number((priced.reduce((s, f) => s + f.filled * f.price!, 0) / pricedQty).toPrecision(10)) : null;
	const fees = group.filter((f) => f.fee !== null);
	const withFills = group.filter((f) => f.filled > 0);
	const refs = new Set<string>();
	for (const f of group) {
		refs.add(f.ref);
		if (f.parentRef) refs.add(f.parentRef);
	}
	return {
		refs: [...refs],
		filled,
		price,
		fee: fees.length ? clean(fees.reduce((s, f) => s + f.fee!, 0)) : null,
		open: group.some((f) => f.open),
		// 원주문(정정 전)을 대표로 — 매수·매도와 종목은 묶음 안에서 같다
		first: group.find((f) => !f.parentRef) ?? group[0]!,
		at: withFills.length ? Math.min(...withFills.map((f) => f.at)) : Math.min(...group.map((f) => f.at)),
		name: group.find((f) => f.name)?.name ?? null,
	};
}

const statusOf = (a: Aggregate): JournalStatus => (a.open ? "pending" : a.filled > 0 ? "filled" : "canceled");

export function planSync(fills: readonly BrokerFill[], known: readonly KnownEntry[], claimed: ReadonlySet<string> = new Set()): SyncPlan {
	const byRef = new Map<string, KnownEntry>();
	for (const e of known) for (const r of e.refs) byRef.set(r, e);
	const plan: SyncPlan = { updates: [], inserts: [] };

	// 일지 줄마다 체결을 모은다 — 정정을 앱에서 했으면 원주문·새 주문이 parentRef 없이 따로 와도 같은 줄의 ref 다
	const perEntry = new Map<string, { entry: KnownEntry; fills: BrokerFill[] }>();
	const loose: BrokerFill[][] = [];
	for (const g of groups(fills)) {
		const refs = g.flatMap((f) => (f.parentRef ? [f.ref, f.parentRef] : [f.ref]));
		const entry = refs.map((r) => byRef.get(r)).find((e): e is KnownEntry => !!e);
		if (!entry) {
			loose.push(g);
			continue;
		}
		const slot = perEntry.get(entry.id) ?? { entry, fills: [] };
		slot.fills.push(...g);
		perEntry.set(entry.id, slot);
	}

	for (const { entry, fills: mine } of perEntry.values()) {
		const a = aggregate(mine);
		const addRefs = a.refs.filter((r) => !entry.refs.includes(r));
		if (entry.source !== "order" && entry.source !== "import") {
			// 자동 매매·직접 기록 — 숫자는 그대로, 새 주문번호만 이어 둔다 (다음에 새 줄로 들어오지 않게)
			if (addRefs.length) plan.updates.push({ id: entry.id, addRefs, patch: { status: entry.status, quantity: entry.quantity, price: entry.price, fee: entry.fee } });
			continue;
		}
		const patch: SyncUpdate["patch"] = {
			status: statusOf(a),
			// 체결이 없으면 주문 수량을 그대로 둔다 (취소됨·대기 — 얼마를 주문했는지는 남긴다)
			quantity: a.filled > 0 ? a.filled : entry.quantity,
			price: a.price ?? entry.price,
			fee: a.fee ?? entry.fee,
			...(!entry.name && a.name ? { name: a.name } : {}),
		};
		const same = patch.status === entry.status && patch.quantity === entry.quantity && patch.price === entry.price && patch.fee === entry.fee && !patch.name;
		if (!same || addRefs.length) plan.updates.push({ id: entry.id, addRefs, patch });
	}

	for (const g of loose) {
		const a = aggregate(g);
		if (a.open || a.filled <= 0 || a.refs.some((r) => claimed.has(r))) continue;
		const f = a.first;
		plan.inserts.push({
			refs: a.refs,
			input: {
				at: a.at,
				broker: f.broker,
				symbol: f.symbol,
				name: a.name,
				side: f.side,
				quantity: a.filled,
				price: a.price,
				currency: f.currency,
				fee: a.fee,
				status: "filled",
				source: "import",
				thesis: null,
				targetPrice: null,
				stopPrice: null,
				tags: [],
				emotion: null,
				review: null,
				context: null,
				conversationId: null,
			},
		});
	}
	plan.inserts.sort((x, y) => x.input.at - y.input.at);
	return plan;
}
