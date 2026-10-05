/**
 * 포트폴리오 집계 — 여러 계좌(증권사·코인 거래소) 잔고를 합쳐 원화 기준으로 정리한다.
 *
 * 계좌별 조회는 `sources/` 의 어댑터가 하고, 여기서는 환율 하나를 골라 환산·합계·배분만 한다.
 *
 * 한 곳이 실패해도(계좌 미개설, 권한 없음 등) 전체를 실패시키지 않는다.
 * 대신 warnings 에 담아 **무엇이 빠졌는지 그대로 알린다** — 조용히 0원으로
 * 처리하면 자산이 줄어든 것처럼 보여서 더 위험하다.
 *
 * 설정하지 않은 계좌는 경고를 내지 않는다 (안 쓰는 계좌를 매번 알릴 이유가 없다).
 */
import type { KisContext } from "./kis/client.ts";
import type {
	Allocation,
	BrokerId,
	CryptoHolding,
	CurrencySplit,
	Holding,
	ManualAsset,
	ManualHolding,
	PortfolioSummary,
	SourceId,
	SourceSummary,
} from "./normalize.ts";
import { ASSET_SOURCES, type AssetSource, type SourceResult } from "./sources/index.ts";
import { publicUsdKrw } from "./sources/fx.ts";
import { reason } from "./sources/types.ts";
import type { TossContext } from "./toss/client.ts";

/**
 * 사용 가능한 계좌 접근자. **설정된 것만** 넘긴다.
 * 컨텍스트 생성이 호출 시점에 일어나므로, 사용자가 키를 나중에 넣어도 재시작이 필요 없다.
 */
export interface BrokerAccess {
	kis?: () => KisContext;
	toss?: () => TossContext;
	/** Binance — 거래와 잔고 조회에 쓴다. 키가 없으면 만들 때 throw */
	binance?: () => { key: string; secret: string; testnet?: boolean };
	/** 직접 입력 자산 목록 (서버 D1) — 저장소가 없으면 넘기지 않는다 */
	manual?: () => Promise<ManualAsset[]>;
}

export class NoBrokerConfiguredError extends Error {
	constructor(withCrypto = true) {
		super(
			(withCrypto ? "연결된 계좌가 없습니다. 설정 화면의 '증권 (KIS)'·'증권 (토스)'·'코인 (Binance)' 에서 키를 입력하세요. " : "연결된 증권 계정이 없습니다. 설정 화면의 '증권 (KIS)' 또는 '증권 (토스)' 에서 키를 입력하세요. ") +
				"키는 사용자별로 저장됩니다.",
		);
		this.name = "NoBrokerConfiguredError";
	}
}

/** 주식만 보는 곳(주문·타점·리서치·보유 점검·스냅샷)이 쓰는 출처 — 코인 거래소를 부르지 않는다 */
export const STOCK_SOURCES: readonly SourceId[] = ["kis", "toss"];

/** 환율은 이 순서로 하나만 고른다 — 토스는 실시간, KIS 는 고시 환율이라 해외 종목이 낮게 잡힌다 (TODO.md) */
const FX_PRIORITY: readonly SourceId[] = ["toss", "kis"];

const SOURCE_TIMEOUT_MS = 20_000;

export interface PortfolioOptions {
	/** 조회할 출처 — 생략하면 연결된 전부 */
	sources?: readonly SourceId[];
	/** 출처 하나의 제한 시간 — 느린 계좌가 전체를 막지 않게 */
	timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${Math.round(ms / 1000)}초 안에 응답이 없어 건너뛰었습니다`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const isStockBroker = (id: SourceId): id is BrokerId => id === "kis" || id === "toss";

/** 출처별 결과 → 환율 하나 (순수) */
export function pickUsdKrw(results: ReadonlyArray<{ id: SourceId; usdKrw: number }>): number {
	return pickFx(results)?.rate ?? 0;
}

function pickFx(results: ReadonlyArray<{ id: SourceId; usdKrw: number }>): { rate: number; id: SourceId } | null {
	const order = [...FX_PRIORITY, ...results.map((r) => r.id).filter((id) => !FX_PRIORITY.includes(id))];
	for (const id of order) {
		const r = results.find((x) => x.id === id && x.usdKrw > 0);
		if (r) return { rate: r.usdKrw, id };
	}
	return null;
}

/** 직접 입력 자산 → 원화 (순수). USD 인데 환율이 없으면 0 */
export function manualKrw(m: ManualAsset, usdKrw: number): number {
	return m.currency === "KRW" ? Math.round(m.amount) : Math.round(m.amount * usdKrw);
}

/** 자산 배분 (순수) — 합계가 총자산이다 */
export function allocationOf(p: {
	holdings: readonly Holding[];
	crypto: readonly CryptoHolding[];
	manual?: readonly ManualAsset[];
	cashKrw: number;
	cashUsd: number;
	usdKrw: number;
}): Allocation {
	const a: Allocation = { domesticStock: 0, overseasStock: 0, crypto: 0, cash: 0, other: 0 };
	for (const h of p.holdings) {
		if (h.market === "domestic") a.domesticStock += h.valueKrw;
		else a.overseasStock += h.valueKrw;
	}
	for (const c of p.crypto) {
		if (c.stable) a.cash += c.valueKrw;
		else a.crypto += c.valueKrw;
	}
	for (const m of p.manual ?? []) {
		if (m.kind === "deposit") a.cash += manualKrw(m, p.usdKrw);
		else a.other += manualKrw(m, p.usdKrw);
	}
	a.cash += p.cashKrw + Math.round(p.cashUsd * p.usdKrw);
	return a;
}

/**
 * 화폐별 금액 (순수) — 원래 통화(amount)와 원화 환산(krw). krw 는 allocationOf 와 같은 값을 더하므로 합계가 총자산과 맞는다.
 * 코인은 USDT 환산 (valueUsd — USDT 마켓 우선, USDC·FDUSD 는 1:1)
 */
export function currencySplit(p: {
	holdings: readonly Holding[];
	crypto: readonly CryptoHolding[];
	manual?: readonly ManualAsset[];
	cashKrw: number;
	cashUsd: number;
	usdKrw: number;
}): { amount: CurrencySplit; krw: CurrencySplit } {
	const amount: CurrencySplit = { krw: p.cashKrw, usd: p.cashUsd, usdt: 0 };
	const krw: CurrencySplit = { krw: p.cashKrw, usd: Math.round(p.cashUsd * p.usdKrw), usdt: 0 };
	for (const h of p.holdings) {
		const k = h.currency === "USD" ? "usd" : "krw";
		amount[k] += h.value;
		krw[k] += h.valueKrw;
	}
	for (const c of p.crypto) {
		amount.usdt += c.valueUsd ?? 0;
		krw.usdt += c.valueKrw;
	}
	for (const m of p.manual ?? []) {
		const k = m.currency === "USD" ? "usd" : "krw";
		amount[k] += m.amount;
		krw[k] += manualKrw(m, p.usdKrw);
	}
	// 원은 정수, 달러·USDT 는 센트 (합산 부동소수점 잡음 제거)
	return {
		amount: { krw: Math.round(amount.krw), usd: Math.round(amount.usd * 100) / 100, usdt: Math.round(amount.usdt * 100) / 100 },
		krw,
	};
}

const sumAllocation = (a: Allocation): number => a.domesticStock + a.overseasStock + a.crypto + a.cash + a.other;

interface Settled {
	source: AssetSource;
	/** null = 실패·제외 · "empty" = 조회해 보니 쓸 게 없음 (카드 없음) */
	result: SourceResult | null | "empty";
	status: SourceSummary["status"];
	error?: string;
}

export async function fetchPortfolio(access: BrokerAccess, opts: PortfolioOptions = {}): Promise<PortfolioSummary> {
	const wanted = ASSET_SOURCES.filter((s) => !opts.sources || opts.sources.includes(s.id));
	const timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS;

	const pending: Array<Promise<Settled>> = [];
	for (const source of wanted) {
		let conn: ReturnType<AssetSource["connect"]>;
		// 접근자가 throw 하면(자격증명 누락) 미설정으로 본다
		try {
			conn = source.connect(access);
		} catch {
			conn = null;
		}
		if (!conn) continue;
		if ("skipped" in conn) {
			pending.push(Promise.resolve({ source, result: null, status: "skipped", error: conn.skipped }));
			continue;
		}
		const run = conn.run;
		pending.push(
			withTimeout(Promise.resolve().then(run), timeoutMs).then(
				(result): Settled =>
					result === null ? { source, result: "empty", status: "ok" } : { source, result, status: result.warnings.length > 0 ? "partial" : "ok" },
				(err: unknown): Settled => ({ source, result: null, status: "failed", error: reason(err) }),
			),
		);
	}

	const noAccount = (): NoBrokerConfiguredError => new NoBrokerConfiguredError(!opts.sources || opts.sources.includes("binance"));
	if (pending.length === 0) throw noAccount();

	const settled = (await Promise.all(pending)).filter((s) => s.result !== "empty");
	// 직접 입력만 연결돼 있고 그마저 비었으면 — 연결된 계좌가 없는 것과 같다
	if (settled.length === 0) throw noAccount();
	const ok = settled.filter((s): s is Settled & { result: SourceResult } => s.result !== null && s.result !== "empty");

	const needsFx = ok.some(
		({ result: r }) =>
			r.holdings.some((h) => h.currency === "USD") ||
			r.cashUsd > 0 ||
			r.crypto.some((c) => c.valueUsd !== null) ||
			r.manual.some((m) => m.currency === "USD"),
	);
	const picked = pickFx(ok.map((s) => ({ id: s.source.id, usdKrw: s.result.usdKrw })));
	let usdKrw = picked?.rate ?? 0;
	let fxSource: string | null = picked ? (ok.find((s) => s.source.id === picked.id)?.source.label ?? picked.id) : null;
	// 증권 계좌 환율이 없을 때만 공개 환율 (Binance 만 연결한 경우 등)
	if (!picked && needsFx) {
		const pub = await publicUsdKrw();
		if (pub) {
			usdKrw = pub.rate;
			fxSource = `ECB ${pub.date}`;
		}
	}

	// 환율 하나로 다시 환산한다 — 출처마다 다른 환율이 섞이면 같은 종목이 계좌마다 다른 원화가 된다
	for (const { result } of ok) {
		if (usdKrw > 0) {
			for (const h of result.holdings) if (h.currency === "USD") h.valueKrw = Math.round(h.value * usdKrw);
		}
		for (const c of result.crypto) c.valueKrw = c.valueUsd !== null && usdKrw > 0 ? Math.round(c.valueUsd * usdKrw) : 0;
	}

	const warnings: string[] = [];
	const sources: SourceSummary[] = settled.map(({ source, result, status, error }) => {
		if (!result || result === "empty") {
			if (status === "failed") warnings.push(`${source.label} 조회 실패: ${error}`);
			return {
				id: source.id,
				label: source.label,
				status,
				valueKrw: 0,
				stockKrw: 0,
				cashKrw: 0,
				cryptoKrw: 0,
				otherKrw: 0,
				byCurrency: { krw: 0, usd: 0, usdt: 0 },
				warnings: [],
				...(error ? { error } : {}),
			};
		}
		warnings.push(...result.warnings);
		const a = allocationOf({ ...result, usdKrw });
		return {
			id: source.id,
			label: source.label,
			status,
			valueKrw: sumAllocation(a),
			stockKrw: a.domesticStock + a.overseasStock,
			cashKrw: a.cash,
			cryptoKrw: a.crypto,
			otherKrw: a.other,
			byCurrency: currencySplit({ ...result, usdKrw }).amount,
			warnings: [...result.warnings],
		};
	});

	const holdings = ok.flatMap((s) => s.result.holdings).sort((a, b) => b.valueKrw - a.valueKrw);
	const crypto = ok.flatMap((s) => s.result.crypto).sort((a, b) => b.valueKrw - a.valueKrw || (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
	const manual: ManualHolding[] = ok
		.flatMap((s) => s.result.manual)
		.map((m) => ({ ...m, valueKrw: manualKrw(m, usdKrw) }))
		.sort((a, b) => b.valueKrw - a.valueKrw);
	const cashKrw = ok.reduce((s, x) => s + x.result.cashKrw, 0);
	// 달러는 센트 단위로 (합산 부동소수점 잡음 제거)
	const cashUsd = Math.round(ok.reduce((s, x) => s + x.result.cashUsd, 0) * 100) / 100;

	if (usdKrw === 0 && needsFx) {
		warnings.push("환율을 얻지 못해 달러 자산(해외 주식·달러 예수금·코인·달러 직접 입력)을 원화로 환산하지 못했습니다 — 총자산에서 빠졌습니다.");
	}

	const stockValueKrw = holdings.reduce((s, h) => s + h.valueKrw, 0);
	const profitKrw = holdings.reduce((s, h) => s + (h.currency === "USD" ? Math.round(h.profit * usdKrw) : h.profit), 0);
	const allocation = allocationOf({ holdings, crypto, manual, cashKrw, cashUsd, usdKrw });
	const split = currencySplit({ holdings, crypto, manual, cashKrw, cashUsd, usdKrw });

	return {
		holdings,
		brokers: ok.map((s) => s.source.id).filter(isStockBroker),
		stockValueKrw,
		cashKrw,
		cashUsd,
		profitKrw,
		usdKrw,
		fxSource,
		warnings,
		crypto,
		manual,
		cryptoValueKrw: crypto.reduce((s, c) => s + c.valueKrw, 0),
		netWorthKrw: sumAllocation(allocation),
		allocation,
		byCurrency: split.amount,
		byCurrencyKrw: split.krw,
		sources,
	};
}
