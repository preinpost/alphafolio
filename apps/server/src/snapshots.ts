/**
 * 일별 포트폴리오 스냅샷.
 *
 * 브로커 API 는 "지금" 잔고만 준다. 월초 평가금액 같은 과거 값은 나중에 되살릴 방법이
 * 없으므로, 월간·주간 수익률을 보여주려면 **매일 직접 찍어 쌓아야 한다.**
 *
 * 시점: 평일 KST 16:00 이후 하루 1회. 장 마감(15:30)과 시간외 단일가 이후라 국내 종가가
 * 확정돼 있다. 해외 종목은 이 시각 기준 직전 미국 종가다 (매일 같은 기준이라 비교에는 문제없다).
 * 서버가 그 시각에 꺼져 있었으면 켜진 뒤 첫 점검에서 찍는다. 빠진 날은 복원하지 않는다.
 *
 * 연결된 계좌 전부(코인 포함)를 찍는다 (PLAN §41). 코인은 24시간 움직이지만 같은 시각에 찍으니 비교에는 문제없다.
 */
import { d1Query, ensureMigrated, type D1Config } from "@alphafolio/ledger";
import { fetchPortfolio, NoBrokerConfiguredError, type BrokerAccess, type PortfolioSummary } from "@alphafolio/broker";

// ── 시간 판단 (순수 함수) ────────────────────────────────────────────────

const KST_OFFSET_MS = 9 * 3600_000;
/** 이 시각(KST) 이후에만 찍는다 — 장 마감 15:30 + 시간외 단일가 16:00 */
export const SNAPSHOT_HOUR_KST = 16;

export interface KstParts {
	/** YYYY-MM-DD */
	date: string;
	hour: number;
	/** 0=일 … 6=토 */
	weekday: number;
}

/** 서버 시간대와 무관하게 KST 로 환산한다 (컨테이너는 보통 UTC 다). */
export function kstParts(now: Date): KstParts {
	const k = new Date(now.getTime() + KST_OFFSET_MS);
	return {
		date: k.toISOString().slice(0, 10),
		hour: k.getUTCHours(),
		weekday: k.getUTCDay(),
	};
}

/** 종가가 확정된 시간대인가 (평일 16시 이후). */
export function inWindow(now: Date): boolean {
	const k = kstParts(now);
	return k.weekday !== 0 && k.weekday !== 6 && k.hour >= SNAPSHOT_HOUR_KST;
}

/**
 * 지금 찍어야 하는가.
 * @param lastDate 이 사용자의 마지막 스냅샷 날짜 (없으면 null)
 */
export function shouldSnapshot(now: Date, lastDate: string | null): boolean {
	// 주말은 가격이 안 바뀌고, 16시 전 값은 종가가 아니다
	if (!inWindow(now)) return false;
	return lastDate !== kstParts(now).date;
}

// ── 저장소 ──────────────────────────────────────────────────────────────

export interface SnapshotHolding {
	broker: string;
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	quantity: number;
	avgPrice: number;
	price: number;
	valueKrw: number;
}

/** 계좌별 합계 — 계좌 구성이 바뀐 날·일부 계좌가 빠진 날을 추이 차트가 구분한다 */
export interface SnapshotSource {
	id: string;
	status: string;
	valueKrw: number;
}

export interface PortfolioSnapshot {
	member: string;
	date: string;
	/** 주식 + 원화 예수금 — 0011 부터 주식에 Binance 미국 주식·bStock 이 들어간다 (추이는 netKrw 로 본다) */
	totalKrw: number;
	stockKrw: number;
	cashKrw: number;
	profitKrw: number;
	usdKrw: number;
	brokers: string[];
	holdings: SnapshotHolding[];
	/** 총자산 — 주식·예수금·달러·코인 원화 환산 (0011 이전 행은 null) */
	netKrw: number | null;
	cryptoKrw: number | null;
	sources: SnapshotSource[] | null;
}

interface Row {
	member: string;
	date: string;
	total_krw: number;
	stock_krw: number;
	cash_krw: number;
	profit_krw: number;
	usd_krw: number;
	brokers: string;
	holdings_json?: string;
	net_krw: number | null;
	crypto_krw: number | null;
	sources_json: string | null;
}

function fromRow(r: Row): PortfolioSnapshot {
	return {
		member: r.member,
		date: r.date,
		totalKrw: r.total_krw,
		stockKrw: r.stock_krw,
		cashKrw: r.cash_krw,
		profitKrw: r.profit_krw,
		usdKrw: r.usd_krw,
		brokers: r.brokers ? r.brokers.split(",") : [],
		holdings: r.holdings_json ? (JSON.parse(r.holdings_json) as SnapshotHolding[]) : [],
		netKrw: r.net_krw ?? null,
		cryptoKrw: r.crypto_krw ?? null,
		sources: r.sources_json ? (JSON.parse(r.sources_json) as SnapshotSource[]) : null,
	};
}

/**
 * 저장하면 안 되는 상태인가 (순수). 환율이 없으면 달러·코인 자산이 0원으로 들어가 그날 총자산이 푹 꺼진다 —
 * 틀린 점을 남기느니 다음 점검(30분 뒤)에 다시 찍는다.
 */
export function snapshotProblem(p: PortfolioSummary): string | null {
	const usdAssets =
		p.holdings.some((h) => h.currency === "USD") || p.cashUsd > 0 || p.crypto.some((c) => c.valueUsd !== null) || p.manual.some((m) => m.currency === "USD");
	if (p.usdKrw === 0 && usdAssets) return "환율을 얻지 못해 달러·코인 자산을 원화로 환산할 수 없어 저장하지 않았습니다.";
	return null;
}

export function toSnapshot(member: string, date: string, p: PortfolioSummary): PortfolioSnapshot {
	return {
		member,
		date,
		totalKrw: p.stockValueKrw + p.cashKrw,
		stockKrw: p.stockValueKrw,
		cashKrw: p.cashKrw,
		profitKrw: p.profitKrw,
		usdKrw: p.usdKrw,
		brokers: [...p.brokers],
		netKrw: p.netWorthKrw,
		cryptoKrw: p.cryptoValueKrw,
		sources: p.sources.map((x) => ({ id: x.id, status: x.status, valueKrw: x.valueKrw })),
		holdings: p.holdings.map((h) => ({
			broker: h.broker,
			symbol: h.symbol,
			name: h.name,
			currency: h.currency,
			quantity: h.quantity,
			avgPrice: h.avgPrice,
			price: h.price,
			valueKrw: h.valueKrw,
		})),
	};
}

export class SnapshotStore {
	private readonly d1: () => D1Config;

	constructor(d1: () => D1Config) {
		this.d1 = d1;
	}

	private async cfg(): Promise<D1Config> {
		const cfg = this.d1();
		await ensureMigrated(cfg);
		return cfg;
	}

	/** 같은 날 다시 찍으면 덮어쓴다 (수동 재촬영·장중 테스트 후 정정). */
	async save(s: PortfolioSnapshot): Promise<void> {
		await d1Query(
			await this.cfg(),
			`INSERT INTO portfolio_snapshots
			   (member, date, total_krw, stock_krw, cash_krw, profit_krw, usd_krw, brokers, holdings_json, created_at,
			    net_krw, crypto_krw, sources_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(member, date) DO UPDATE SET
			   total_krw = excluded.total_krw, stock_krw = excluded.stock_krw, cash_krw = excluded.cash_krw,
			   profit_krw = excluded.profit_krw, usd_krw = excluded.usd_krw, brokers = excluded.brokers,
			   holdings_json = excluded.holdings_json, created_at = excluded.created_at,
			   net_krw = excluded.net_krw, crypto_krw = excluded.crypto_krw, sources_json = excluded.sources_json`,
			[
				s.member,
				s.date,
				s.totalKrw,
				s.stockKrw,
				s.cashKrw,
				s.profitKrw,
				s.usdKrw,
				s.brokers.join(","),
				JSON.stringify(s.holdings),
				new Date().toISOString(),
				s.netKrw,
				s.cryptoKrw,
				s.sources ? JSON.stringify(s.sources) : null,
			],
		);
	}

	async lastDate(member: string): Promise<string | null> {
		const r = await d1Query<{ date: string }>(
			await this.cfg(),
			"SELECT date FROM portfolio_snapshots WHERE member = ? ORDER BY date DESC LIMIT 1",
			[member],
		);
		return r.results[0]?.date ?? null;
	}

	/** 기준일 당일 또는 그 이전 가장 가까운 스냅샷 — "월초 기준값" 조회용. */
	async onOrBefore(member: string, date: string): Promise<PortfolioSnapshot | null> {
		const r = await d1Query<Row>(
			await this.cfg(),
			"SELECT * FROM portfolio_snapshots WHERE member = ? AND date <= ? ORDER BY date DESC LIMIT 1",
			[member, date],
		);
		const row = r.results[0];
		return row ? fromRow(row) : null;
	}

	/** summary 면 보유 종목(holdings_json)을 읽지 않는다 — 추이 차트는 합계만 쓴다 */
	async range(member: string, from: string, to: string, opts: { summary?: boolean } = {}): Promise<PortfolioSnapshot[]> {
		const cols = opts.summary
			? "member, date, total_krw, stock_krw, cash_krw, profit_krw, usd_krw, brokers, net_krw, crypto_krw, sources_json"
			: "*";
		const r = await d1Query<Row>(
			await this.cfg(),
			`SELECT ${cols} FROM portfolio_snapshots WHERE member = ? AND date >= ? AND date <= ? ORDER BY date`,
			[member, from, to],
		);
		return r.results.map(fromRow);
	}
}

// ── 스케줄러 ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30 * 60_000;

export interface SnapshotSchedulerOptions {
	store: SnapshotStore;
	users: () => string[];
	brokerAccess: (user: string) => BrokerAccess;
	/** 테스트용 시계 */
	now?: () => Date;
}

/**
 * 30분마다 점검해 찍을 때가 된 사용자만 찍는다.
 * 실패는 로그만 남기고 다음 점검에서 다시 시도한다 (같은 점검 안에서 재시도하지 않는다 —
 * 브로커 장애 시 레이트 리밋을 두드리지 않기 위해).
 */
export class SnapshotScheduler {
	private readonly opts: SnapshotSchedulerOptions;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;

	constructor(opts: SnapshotSchedulerOptions) {
		this.opts = opts;
	}

	start(): void {
		void this.tick();
		this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	/**
	 * 한 사용자 즉시 촬영.
	 *
	 * **유효 시간대(평일 KST 16시 이후)가 아니면 저장하지 않고 미리보기만 돌려준다.**
	 * 새벽에 찍어 "오늘자"로 저장하면 ① 해외 종목이 장중 가격이고 ② 그날 16시 스케줄러가
	 * "이미 찍었다"며 진짜 종가 스냅샷을 건너뛴다.
	 */
	async takeNow(user: string): Promise<{ saved: boolean; reason?: string; snapshot: PortfolioSnapshot }> {
		const now = this.opts.now?.() ?? new Date();
		const k = kstParts(now);
		const portfolio = await fetchPortfolio(this.opts.brokerAccess(user));
		const snapshot = toSnapshot(user, k.date, portfolio);

		if (!inWindow(now)) {
			return {
				saved: false,
				reason: `저장은 평일 ${SNAPSHOT_HOUR_KST}시(KST) 이후에만 합니다 — 종가가 확정되기 전 값이라 미리보기만 보여줍니다.`,
				snapshot,
			};
		}
		const problem = snapshotProblem(portfolio);
		if (problem) return { saved: false, reason: problem, snapshot };
		await this.opts.store.save(snapshot);
		return { saved: true, snapshot };
	}

	async tick(): Promise<void> {
		if (this.running) return; // 이전 점검이 아직 돌고 있으면 겹치지 않는다
		this.running = true;
		try {
			const now = this.opts.now?.() ?? new Date();
			for (const user of this.opts.users()) {
				try {
					const last = await this.opts.store.lastDate(user);
					if (!shouldSnapshot(now, last)) continue;
					const { saved, reason, snapshot: snap } = await this.takeNow(user);
					if (!saved) {
						console.warn(`[snapshot] ${user} ${snap.date} 건너뜀: ${reason}`);
						continue;
					}
					console.log(
						`[snapshot] ${user} ${snap.date} 총자산 ${Math.round(snap.netKrw ?? snap.totalKrw).toLocaleString("ko-KR")}원 · ${snap.holdings.length}종목`,
					);
				} catch (err) {
					// 증권 키가 없는 사용자는 조용히 건너뛴다 (가계부만 쓰는 구성원)
					if (err instanceof NoBrokerConfiguredError) continue;
					console.warn(`[snapshot] ${user} 실패: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} finally {
			this.running = false;
		}
	}
}
