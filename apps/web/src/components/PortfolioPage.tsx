/**
 * 투자 화면 — 에이전트를 거치지 않는 직접 경로 (PLAN.md §3.2).
 *
 * 챗은 "삼성전자 얼마야" 같은 질문에 강하고, 이 화면은 여러 계좌(KIS·토스·Binance …)에
 * 흩어진 자산을 한 번에 훑어보는 데 강하다. 둘은 같은 계좌를 본다.
 *
 * 금액은 서버가 환율 하나로 원화 환산해 준다 — 화면은 합치거나 환산하지 않는다.
 */
import type { BrokerHolding, CryptoHoldingDto, ManualAssetDto, PortfolioDto, PortfolioSourceDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import {
	changeSince,
	compositionOf,
	daysBefore,
	groupHoldings,
	historySeries,
	kstDate,
	type Change,
	type GroupedHolding,
} from "../lib/portfolio.ts";
import { MANUAL_KIND_LABEL, ManualAssetEditor } from "./ManualAssetEditor.tsx";
import { NetWorthChart } from "./NetWorthChart.tsx";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 예수금 — 센트까지 ($1,234.50). 원화로 환산하지 않는다 (미국 주식은 달러로 주문) */
function usdCash(value: number): string {
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** 코인 단가 — 1달러 미만은 유효숫자 4자리 ($0.00001234) */
const usdPrice = (n: number): string => (n >= 1 ? usd(n) : `$${Number(n.toPrecision(4))}`);
const qty = (n: number): string => Number(n.toPrecision(8)).toLocaleString("en-US", { maximumFractionDigits: 8 });

function moveClass(n: number): string {
	if (n > 0) return "text-up";
	if (n < 0) return "text-down";
	return "text-muted";
}

const sign = (n: number): string => (n > 0 ? "+" : "");

const pct = (part: number, total: number): string => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");

const WALLET: Record<string, string> = { SPOT: "현물", FUNDING: "펀딩", EARN: "Earn 유연", EARN_LOCKED: "Earn 고정" };

const BROKER_LABEL: Record<string, string> = { kis: "KIS", toss: "토스", binance: "Binance", manual: "직접 입력" };

/** 배분 막대 — 순서가 곧 범례 순서 */
const SLICES: Array<{ key: keyof PortfolioDto["allocation"]; label: string; color: string }> = [
	{ key: "domesticStock", label: "국내주식", color: "#2563eb" },
	{ key: "overseasStock", label: "해외주식", color: "#8b5cf6" },
	{ key: "crypto", label: "코인", color: "#f59e0b" },
	{ key: "cash", label: "현금성", color: "#14b8a6" },
	{ key: "other", label: "기타", color: "#94a3b8" },
];

/** 1달러 미만 코인 — 기본은 접어 둔다 (거래하고 남은 잔돈) */
const isDust = (c: CryptoHoldingDto): boolean => c.valueUsd !== null && c.valueUsd < 1;

export function PortfolioPage() {
	const [symbol, setSymbol] = useState("");
	const [lookup, setLookup] = useState<string | null>(null);
	/** 보유 목록 계좌 필터 — null 이면 전체 */
	const [only, setOnly] = useState<string | null>(null);
	const [showDust, setShowDust] = useState(false);
	/** 보유 목록 — 계좌별(account) 또는 같은 종목 합치기(symbol) */
	const [view, setView] = useState<"account" | "symbol">("account");
	/** 직접 입력 자산 — 고치는 중인 id, "new" = 추가 중 */
	const [editing, setEditing] = useState<string | null>(null);
	const today = kstDate();

	const qc = useQueryClient();
	// 계좌마다 여러 API 를 부르므로 화면 복귀마다 다시 읽지 않는다 (새로고침 버튼은 있다)
	const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio, retry: false, staleTime: 30_000 });
	// 미체결은 주문 직후 바뀌므로 짧게 캐시한다
	const openOrders = useQuery({
		queryKey: ["orders", "OPEN"],
		queryFn: () => api.orders("OPEN"),
		retry: false,
		staleTime: 5_000,
	});
	const cancel = useMutation({
		mutationFn: api.cancelOrder,
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["orders"] });
			void qc.invalidateQueries({ queryKey: ["portfolio"] });
		},
	});
	// 추이 — 합계만 (보유 종목 없이). D1 이 없으면 실패하는데, 그러면 차트만 숨긴다
	const history = useQuery({
		queryKey: ["portfolio-history", today],
		queryFn: () => api.portfolioHistory(daysBefore(today, 366), today),
		retry: false,
		staleTime: 10 * 60_000,
	});
	const points = useMemo(() => historySeries(history.data?.items ?? []), [history.data]);
	const quote = useQuery({
		queryKey: ["quote", lookup],
		queryFn: () => api.quote(lookup as string),
		enabled: lookup !== null,
		retry: false,
	});

	const p = portfolio.data;
	const holdings = (p?.holdings ?? []).filter((h) => !only || h.broker === only);
	const grouped = view === "symbol" ? groupHoldings(holdings) : null;
	const composition = p ? compositionOf(p.sources) : "";
	const daily = p ? changeSince(points, p.netWorthKrw, composition, today) : null;
	const monthly = p ? changeSince(points, p.netWorthKrw, composition, `${today.slice(0, 7)}-01`) : null;
	const crypto = (p?.crypto ?? []).filter((c) => !only || c.source === only);
	const manual = (p?.manual ?? []).filter(() => !only || only === "manual");
	const dust = crypto.filter(isDust);
	const shownCrypto = showDust ? crypto : crypto.filter((c) => !isDust(c));

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				{portfolio.isLoading && <p className="text-sm text-muted">불러오는 중…</p>}

				{portfolio.isError && (
					<div className="rounded-xl border border-line bg-inset p-4">
						<p className="text-sm text-danger">{(portfolio.error as Error).message}</p>
						<p className="mt-2 text-xs text-faint">
							설정 &gt; 증권 (KIS)·증권 (토스)·코인 (Binance) 에서 키를 입력하세요. 키는 사용자별로 저장됩니다.
							API 가 없는 자산(예금·연금·부동산)은 아래에서 직접 입력할 수 있습니다.
						</p>
						<div className="mt-3 overflow-hidden rounded-xl border border-line bg-card">
							<AddManual editing={editing} setEditing={setEditing} />
						</div>
					</div>
				)}

				{p && (
					<>
						{/* 총자산 */}
						<div className="flex items-end justify-between gap-3">
							<div className="min-w-0">
								<div className="text-xs text-muted">총자산 (원화 환산)</div>
								<div className="text-2xl font-semibold text-ink">{won(p.netWorthKrw)}</div>
								{(daily || monthly) && (
									<div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
										{daily && <ChangeText label="전일 대비" c={daily} />}
										{monthly && <ChangeText label="이번 달" c={monthly} />}
									</div>
								)}
								<div className="mt-0.5 text-xs text-muted">
									<span className={moveClass(p.profitKrw)}>
										주식 평가손익 {sign(p.profitKrw)}
										{won(p.profitKrw)}
									</span>
									{p.usdKrw > 0
										? ` · 환율 ${Math.round(p.usdKrw).toLocaleString("ko-KR")}원${p.fxSource ? ` (${p.fxSource})` : ""}`
										: ""}
								</div>
							</div>
							<button
								onClick={() => void portfolio.refetch()}
								disabled={portfolio.isFetching}
								className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-50"
							>
								{portfolio.isFetching ? "불러오는 중…" : "새로고침"}
							</button>
						</div>

						<AllocationBar allocation={p.allocation} total={p.netWorthKrw} />

						{history.isSuccess && <NetWorthChart points={points} today={today} />}

						{/* 계좌별 */}
						<section>
							<h2 className="mb-2 text-sm font-medium text-muted">계좌</h2>
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
								{p.sources.map((s) => (
									<SourceCard
										key={s.id}
										source={s}
										total={p.netWorthKrw}
										active={only === s.id}
										onClick={() => setOnly((cur) => (cur === s.id ? null : s.id))}
									/>
								))}
							</div>
						</section>

						{p.warnings.map((w) => (
							<p key={w} className="rounded-lg border border-danger/40 bg-inset p-2 text-xs text-danger">
								{w}
							</p>
						))}

						{(openOrders.data?.orders.length ?? 0) > 0 && (
							<section>
								<h2 className="mb-2 text-sm font-medium text-muted">
									미체결 주문 {openOrders.data?.orders.length}건
								</h2>
								<div className="overflow-hidden rounded-xl border border-line">
									{openOrders.data?.orders.map((o) => (
										<div
											key={o.orderId}
											className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0"
										>
											<div className="min-w-0">
												<div className="truncate text-sm text-ink">
													{o.symbol}{" "}
													<span className={o.side === "BUY" ? "text-up" : "text-down"}>
														{o.side === "BUY" ? "매수" : "매도"}
													</span>
												</div>
												<div className="text-xs text-muted">
													{o.quantity}주 ·{" "}
													{o.price ? `${Number(o.price).toLocaleString("ko-KR")}` : "시장가"} · {o.status}
												</div>
											</div>
											<button
												onClick={() => cancel.mutate(o.orderId)}
												disabled={cancel.isPending}
												className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-50"
											>
												취소
											</button>
										</div>
									))}
								</div>
							</section>
						)}

						{/* 보유 */}
						<section>
							<div className="mb-2 flex items-center justify-between gap-2">
								<h2 className="min-w-0 truncate text-sm font-medium text-muted">
									보유 자산{only ? ` · ${BROKER_LABEL[only] ?? only}` : ""}
									{only && (
										<button onClick={() => setOnly(null)} className="ml-2 text-xs text-accent">
											전체 보기
										</button>
									)}
								</h2>
								<div className="flex shrink-0 gap-1">
									{(
										[
											["account", "계좌별"],
											["symbol", "종목별"],
										] as const
									).map(([id, label]) => (
										<button
											key={id}
											onClick={() => setView(id)}
											className={`rounded-md px-2 py-0.5 text-xs ${view === id ? "bg-accent-soft text-ink" : "text-muted"}`}
										>
											{label}
										</button>
									))}
								</div>
							</div>
							<div className="overflow-hidden rounded-xl border border-line">
								{grouped
									? grouped.map((g) => <GroupedRow key={g.key} g={g} />)
									: holdings.map((h) => <HoldingRow key={`${h.broker}-${h.market}-${h.symbol}`} h={h} />)}

								{shownCrypto.map((c) => (
									<CryptoRow key={`${c.source}-${c.asset}`} c={c} />
								))}

								{dust.length > 0 && (
									<button
										onClick={() => setShowDust((v) => !v)}
										className="w-full px-4 py-2 text-center text-xs text-muted active:bg-hover"
									>
										{showDust ? "1달러 미만 코인 접기" : `1달러 미만 코인 ${dust.length}개 더 보기`}
									</button>
								)}

								{!only && (p.cashKrw > 0 || p.cashUsd > 0) && (
									<div className="flex items-center justify-between px-4 py-2.5">
										<div className="text-sm text-ink">예수금</div>
										<div className="text-right text-sm text-ink">
											{won(p.cashKrw)}
											{p.cashUsd > 0 && <div className="text-xs text-muted">{usdCash(p.cashUsd)}</div>}
										</div>
									</div>
								)}

								{manual.map((m) =>
									editing === m.id ? (
										<ManualAssetEditor key={m.id} asset={m} onDone={() => setEditing(null)} />
									) : (
										<ManualRow key={m.id} m={m} onEdit={() => setEditing(m.id)} />
									),
								)}

								{holdings.length === 0 && crypto.length === 0 && manual.length === 0 && editing !== "new" && (
									<p className="px-4 py-6 text-center text-sm text-muted">보유 자산이 없습니다.</p>
								)}

								{(!only || only === "manual") && <AddManual editing={editing} setEditing={setEditing} />}
							</div>
						</section>
					</>
				)}

				{/* 시세 조회 */}
				<section className="space-y-3">
					<h2 className="text-sm font-medium text-muted">시세 조회</h2>
					<div className="flex gap-2">
						<input
							placeholder="종목코드 또는 티커 (예: 005930, AAPL)"
							value={symbol}
							onChange={(e) => setSymbol(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && symbol.trim()) setLookup(symbol.trim());
							}}
							className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
						/>
						<button
							onClick={() => symbol.trim() && setLookup(symbol.trim())}
							disabled={!symbol.trim()}
							className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
						>
							조회
						</button>
					</div>

					{quote.isError && <p className="text-sm text-danger">{(quote.error as Error).message}</p>}
					{quote.data && (
						<div className="flex items-baseline justify-between rounded-xl border border-line bg-inset px-4 py-3">
							<div className="min-w-0">
								<div className="truncate text-sm font-medium text-ink">{quote.data.name}</div>
								<div className="text-xs text-faint">
									{quote.data.symbol}
									{quote.data.exchange ? ` · ${quote.data.exchange}` : ""}
								</div>
							</div>
							<div className="shrink-0 text-right">
								<div className="text-base font-semibold text-ink">
									{quote.data.currency === "KRW" ? won(quote.data.price) : usd(quote.data.price)}
								</div>
								<div className={`text-xs ${moveClass(quote.data.change)}`}>
									{sign(quote.data.changePct)}
									{quote.data.changePct}%
								</div>
							</div>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function AllocationBar({ allocation, total }: { allocation: PortfolioDto["allocation"]; total: number }) {
	const slices = SLICES.filter((s) => allocation[s.key] > 0);
	if (total <= 0 || slices.length === 0) return null;
	return (
		<section className="space-y-2">
			<div className="flex h-2.5 overflow-hidden rounded-full bg-inset">
				{slices.map((s) => (
					<div
						key={s.key}
						style={{ width: `${(allocation[s.key] / total) * 100}%`, backgroundColor: s.color }}
						title={`${s.label} ${pct(allocation[s.key], total)}`}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
				{slices.map((s) => (
					<span key={s.key} className="flex items-center gap-1.5">
						<span className="inline-block size-2 rounded-full" style={{ backgroundColor: s.color }} />
						{s.label} <span className="text-ink">{pct(allocation[s.key], total)}</span>
						<span className="text-faint">{won(allocation[s.key])}</span>
					</span>
				))}
			</div>
		</section>
	);
}

const STATUS: Record<PortfolioSourceDto["status"], { text: string; className: string } | null> = {
	ok: null,
	partial: { text: "일부 누락", className: "text-danger" },
	failed: { text: "조회 실패", className: "text-danger" },
	skipped: { text: "제외", className: "text-faint" },
};

function SourceCard({
	source: s,
	total,
	active,
	onClick,
}: {
	source: PortfolioSourceDto;
	total: number;
	active: boolean;
	onClick: () => void;
}) {
	const status = STATUS[s.status];
	const parts = [
		s.stockKrw > 0 && `주식 ${won(s.stockKrw)}`,
		s.cryptoKrw > 0 && `코인 ${won(s.cryptoKrw)}`,
		s.cashKrw > 0 && `현금 ${won(s.cashKrw)}`,
		s.otherKrw > 0 && `기타 ${won(s.otherKrw)}`,
	].filter(Boolean);
	const usable = s.status === "ok" || s.status === "partial";
	return (
		<button
			onClick={onClick}
			disabled={!usable}
			className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition ${
				active ? "border-accent bg-accent-soft" : "border-line bg-card active:bg-hover"
			} disabled:opacity-70`}
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="truncate text-sm font-medium text-ink">{s.label}</span>
				{status ? (
					<span className={`shrink-0 text-[11px] ${status.className}`}>{status.text}</span>
				) : (
					<span className="shrink-0 text-xs text-muted">{pct(s.valueKrw, total)}</span>
				)}
			</div>
			{usable ? (
				<>
					<div className="mt-1 text-base font-semibold text-ink">{won(s.valueKrw)}</div>
					<div className="truncate text-[11px] text-faint">{parts.join(" · ") || "잔고 없음"}</div>
				</>
			) : (
				<div className="mt-1 line-clamp-2 text-xs text-faint" title={s.error}>
					{s.error}
				</div>
			)}
		</button>
	);
}

function ChangeText({ label, c }: { label: string; c: Change }) {
	return (
		<span className={moveClass(c.diff)} title={`${c.baseDate} 스냅샷 ${won(c.base)} 기준 (입출금 포함)`}>
			{label} {sign(c.diff)}
			{won(c.diff)} ({sign(c.pct)}
			{c.pct}%)
		</span>
	);
}

/** 평단 — 0 이면 모른다 (Binance 체결 내역에 없던 것·bStock 토큰) */
const avgText = (h: BrokerHolding): string => (h.avgPrice > 0 ? (h.currency === "KRW" ? won(h.avgPrice) : usd(h.avgPrice)) : "—");

function HoldingRow({ h }: { h: BrokerHolding }) {
	return (
		<div className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0">
			<div className="min-w-0">
				<div className="truncate text-sm text-ink">{h.name}</div>
				<div className="truncate text-xs text-muted">
					{qty(h.quantity)}주 · 평단 {avgText(h)}
					{h.market === "overseas" ? " · 해외" : ""}
					{` · ${BROKER_LABEL[h.broker] ?? h.broker}`}
					{h.note ? ` · ${h.note}` : ""}
				</div>
			</div>
			<div className="shrink-0 text-right">
				<div className="text-sm text-ink">{won(h.valueKrw)}</div>
				{h.avgPrice > 0 && (
					<div className={`text-xs ${moveClass(h.profitPct)}`}>
						{sign(h.profitPct)}
						{h.profitPct}%
					</div>
				)}
			</div>
		</div>
	);
}

function GroupedRow({ g }: { g: GroupedHolding }) {
	return (
		<div className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0">
			<div className="min-w-0">
				<div className="truncate text-sm text-ink">
					{g.name}
					{g.name !== g.symbol && <span className="ml-1.5 text-[11px] text-faint">{g.symbol}</span>}
				</div>
				<div className="truncate text-xs text-muted">
					{qty(g.quantity)}주{g.market === "overseas" ? " · 해외" : ""} ·{" "}
					{g.parts.map((h) => `${BROKER_LABEL[h.broker] ?? h.broker} ${qty(h.quantity)}`).join(" + ")}
				</div>
			</div>
			<div className="shrink-0 text-right">
				<div className="text-sm text-ink">{won(g.valueKrw)}</div>
				{g.profitPct !== null && (
					<div className={`text-xs ${moveClass(g.profitPct)}`}>
						{sign(g.profitPct)}
						{g.profitPct}%
					</div>
				)}
			</div>
		</div>
	);
}

function AddManual({ editing, setEditing }: { editing: string | null; setEditing: (v: string | null) => void }) {
	if (editing === "new") return <ManualAssetEditor onDone={() => setEditing(null)} />;
	return (
		<button onClick={() => setEditing("new")} className="w-full px-4 py-2.5 text-center text-xs text-accent active:bg-hover">
			+ 직접 입력 자산 추가 (예금·연금·부동산 등)
		</button>
	);
}

/** 며칠 전에 고쳤나 — 시세가 없는 값이라 오래되면 알린다 */
function ageText(iso: string): string {
	const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
	if (!(days >= 1)) return "오늘 갱신";
	return days >= 30 ? `${Math.floor(days / 30)}개월 전 갱신` : `${days}일 전 갱신`;
}

function ManualRow({ m, onEdit }: { m: ManualAssetDto & { valueKrw: number }; onEdit: () => void }) {
	const stale = Date.now() - Date.parse(m.updatedAt) > 90 * 86_400_000;
	return (
		<button onClick={onEdit} className="flex w-full items-center justify-between border-b border-line px-4 py-2.5 text-left last:border-0 active:bg-hover">
			<div className="min-w-0">
				<div className="truncate text-sm text-ink">{m.name}</div>
				<div className="truncate text-xs text-muted">
					{MANUAL_KIND_LABEL[m.kind]} · 직접 입력 · <span className={stale ? "text-danger" : ""}>{ageText(m.updatedAt)}</span>
					{m.memo ? ` · ${m.memo}` : ""}
				</div>
			</div>
			<div className="shrink-0 text-right">
				<div className="text-sm text-ink">{m.valueKrw > 0 || m.currency === "KRW" ? won(m.valueKrw) : usd(m.amount)}</div>
				{m.currency === "USD" && m.valueKrw > 0 && <div className="text-xs text-muted">{usd(m.amount)}</div>}
			</div>
		</button>
	);
}

/** 코인 손익 — 평단은 현물 체결로 추정, 입금·보상분이 섞이면 "일부" */
function cryptoPnl(c: CryptoHoldingDto) {
	if (c.profitPct === null || c.avgPriceUsd === null) return null;
	const partial = c.costCoverage !== null && c.costCoverage < 0.95;
	return (
		<span
			className={moveClass(c.profitPct)}
			title={`평단 ${usdPrice(c.avgPriceUsd)} (현물 체결 추정${partial ? `, 보유의 ${Math.round((c.costCoverage ?? 0) * 100)}%만 설명됨` : ""})`}
		>
			{sign(c.profitPct)}
			{c.profitPct}%{partial ? " 일부" : ""}
		</span>
	);
}

function CryptoRow({ c }: { c: CryptoHoldingDto }) {
	return (
		<div className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0">
			<div className="min-w-0">
				<div className="truncate text-sm text-ink">
					{c.asset}
					{c.stable && <span className="ml-1.5 text-[11px] text-faint">스테이블</span>}
				</div>
				<div className="truncate text-xs text-muted">
					{qty(c.quantity)}
					{c.avgPriceUsd !== null ? ` · 평단 ${usdPrice(c.avgPriceUsd)}` : ""} · {c.wallets.map((w) => WALLET[w.wallet] ?? w.wallet).join("·")} ·{" "}
					{BROKER_LABEL[c.source]}
				</div>
			</div>
			<div className="shrink-0 text-right">
				{c.valueUsd === null ? (
					<div className="text-xs text-faint">시세 없음</div>
				) : (
					<>
						<div className="text-sm text-ink">{c.valueKrw > 0 ? won(c.valueKrw) : usd(c.valueUsd)}</div>
						<div className="text-xs text-muted">
							{c.valueKrw > 0 ? usd(c.valueUsd) : ""}
							{cryptoPnl(c) ? (
								<>
									{c.valueKrw > 0 ? " · " : ""}
									{cryptoPnl(c)}
								</>
							) : c.priceUsd !== null && !c.stable ? (
								`${c.valueKrw > 0 ? " · " : ""}@${usdPrice(c.priceUsd)}`
							) : (
								""
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
