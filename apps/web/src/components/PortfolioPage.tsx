/**
 * 투자 화면 — 에이전트를 거치지 않는 직접 경로 (PLAN.md §3.2).
 *
 * 챗은 "삼성전자 얼마야" 같은 질문에 강하고, 이 화면은 여러 계좌(KIS·토스·Binance …)에
 * 흩어진 자산을 한 번에 훑어보는 데 강하다. 둘은 같은 계좌를 본다.
 *
 * 금액은 서버가 환율 하나로 원화 환산해 준다 — 화면은 합치거나 환산하지 않는다.
 * 달러 자산은 달러로, 코인은 USDT 로 먼저 보이고 원화 환산은 곁에 둔다 (원화만으로는 달러·코인이 얼마인지 알기 어렵다).
 *
 * 화면당 큰 숫자 하나 — 총자산. 계좌를 누르면 보유 자산이 그 계좌로 좁혀진다.
 */
import type { BrokerHolding, CryptoHoldingDto, ManualAssetDto, PortfolioDto, PortfolioSourceDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { changeSince, compactWon, compositionOf, daysBefore, groupHoldings, historySeries, kstDate, type Change, type GroupedHolding } from "../lib/portfolio.ts";
import { toast } from "../lib/toast.ts";
import { AlertIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon, RefreshIcon, SearchIcon, XIcon } from "./icons.tsx";
import { MANUAL_KIND_LABEL, ManualAssetEditor } from "./ManualAssetEditor.tsx";
import { NetWorthChart, RANGES, type RangeId } from "./NetWorthChart.tsx";
import { Topbar } from "./Topbar.tsx";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;
/** 예수금 — 센트까지 ($1,234.50) */
const usdCash = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** 코인 평가 — USDT 환산 (스테이블 포함) */
const usdt = (n: number): string => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
/** 원래 통화 금액 곁에 붙이는 원화 환산 — 환율이 없으면 (0) 빈 문자열 */
const approxWon = (n: number): string => (n > 0 ? `≈ ${won(n)}` : "");
const approxShort = (n: number): string => (n > 0 ? `≈ ${compactWon(n)}` : "");
const money = (n: number, currency: "KRW" | "USD"): string => (currency === "KRW" ? won(n) : usd(n));
/** 코인 단가 — 1달러 미만은 유효숫자 4자리 ($0.00001234) */
const usdPrice = (n: number): string => (n >= 1 ? usd(n) : `$${Number(n.toPrecision(4))}`);
const qty = (n: number): string => Number(n.toPrecision(8)).toLocaleString("en-US", { maximumFractionDigits: 8 });
const sign = (n: number): string => (n > 0 ? "+" : n < 0 ? "−" : "");
const move = (n: number): string => (n > 0 ? "up" : n < 0 ? "down" : "flat");
const pctOf = (part: number, total: number): string => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");
const signedPct = (n: number): string => `${sign(n)}${Math.abs(n).toFixed(2)}%`;

const WALLET: Record<string, string> = { SPOT: "현물", FUNDING: "펀딩", EARN: "Earn 유연", EARN_LOCKED: "Earn 고정" };
const BROKER_LABEL: Record<string, string> = { kis: "한국투자", toss: "토스", binance: "Binance", manual: "직접 입력" };

/** 배분 막대 — 순서가 곧 범례 순서. 색은 데이터 팔레트 토큰 */
const SLICES: Array<{ key: keyof PortfolioDto["allocation"]; label: string; color: string }> = [
	{ key: "domesticStock", label: "국내주식", color: "var(--d1)" },
	{ key: "overseasStock", label: "해외주식", color: "var(--d2)" },
	{ key: "crypto", label: "코인", color: "var(--d3)" },
	{ key: "cash", label: "현금성", color: "var(--d4)" },
	{ key: "other", label: "기타", color: "var(--d5)" },
];

type Kind = "domesticStock" | "overseasStock" | "crypto" | "manual";
const KIND_CHIPS: Array<{ key: Kind | "all"; label: string }> = [
	{ key: "all", label: "전체" },
	{ key: "domesticStock", label: "국내주식" },
	{ key: "overseasStock", label: "해외주식" },
	{ key: "crypto", label: "코인" },
	{ key: "manual", label: "직접 입력" },
];
type Sort = "value" | "pnl" | "name";

/** 1달러 미만 코인 — 기본은 접어 둔다 (거래하고 남은 잔돈) */
const isDust = (c: CryptoHoldingDto): boolean => c.valueUsd !== null && c.valueUsd < 1;

/** 보유 자산 표의 한 줄 — 주식·합친 종목·코인·직접 입력을 같은 모양으로 */
interface HoldRow {
	key: string;
	kind: Kind;
	name: string;
	sym: string | null;
	meta: string;
	metaWarn?: boolean;
	price: string | null;
	value: string;
	valueSub: string;
	valueKrw: number;
	pnl: string | null;
	pnlPct: number | null;
	pnlNote?: string;
	pnlTitle?: string;
	manual?: ManualAssetDto & { valueKrw: number };
}

/** 평단 — 0 이면 모른다 (Binance 체결 내역에 없던 것·bStock 토큰) */
const avgText = (h: BrokerHolding): string => (h.avgPrice > 0 ? money(h.avgPrice, h.currency) : "—");

function stockRow(h: BrokerHolding, total: number): HoldRow {
	const known = h.avgPrice > 0;
	return {
		key: `${h.broker}-${h.market}-${h.symbol}`,
		kind: h.market === "domestic" ? "domesticStock" : "overseasStock",
		name: h.name,
		sym: h.name !== h.symbol ? h.symbol : null,
		meta: [`${qty(h.quantity)}주`, `평단 ${avgText(h)}`, BROKER_LABEL[h.broker] ?? h.broker, h.note].filter(Boolean).join(" · "),
		price: money(h.price, h.currency),
		value: money(h.value, h.currency),
		valueSub: h.currency === "USD" ? approxShort(h.valueKrw) : pctOf(h.valueKrw, total),
		valueKrw: h.valueKrw,
		pnl: known ? `${sign(h.profit)}${money(Math.abs(h.profit), h.currency)}` : null,
		pnlPct: known ? h.profitPct : null,
	};
}

function groupedRow(g: GroupedHolding, total: number): HoldRow {
	const known = g.parts.filter((h) => h.avgPrice > 0);
	const profit = known.reduce((s, h) => s + h.profit, 0);
	return {
		key: g.key,
		kind: g.market === "domestic" ? "domesticStock" : "overseasStock",
		name: g.name,
		sym: g.name !== g.symbol ? g.symbol : null,
		meta: `${qty(g.quantity)}주 · ${g.parts.map((h) => `${BROKER_LABEL[h.broker] ?? h.broker} ${qty(h.quantity)}`).join(" + ")}`,
		price: g.parts[0] ? money(g.parts[0].price, g.currency) : null,
		value: money(g.value, g.currency),
		valueSub: g.currency === "USD" ? approxShort(g.valueKrw) : pctOf(g.valueKrw, total),
		valueKrw: g.valueKrw,
		pnl: g.profitPct !== null ? `${sign(profit)}${money(Math.abs(profit), g.currency)}` : null,
		pnlPct: g.profitPct,
	};
}

function cryptoRow(c: CryptoHoldingDto): HoldRow {
	// 평단은 현물 체결로 추정 — 입금·보상분이 섞이면 "일부"
	const partial = c.costCoverage !== null && c.costCoverage < 0.95;
	return {
		key: `${c.source}-${c.asset}`,
		kind: "crypto",
		name: c.asset,
		sym: c.stable ? "스테이블" : null,
		meta: [qty(c.quantity), c.avgPriceUsd !== null ? `평단 ${usdPrice(c.avgPriceUsd)}` : null, c.wallets.map((w) => WALLET[w.wallet] ?? w.wallet).join("·"), BROKER_LABEL[c.source]]
			.filter(Boolean)
			.join(" · "),
		price: c.priceUsd !== null ? usdPrice(c.priceUsd) : null,
		value: c.valueUsd === null ? "시세 없음" : usdt(c.valueUsd),
		valueSub: approxShort(c.valueKrw),
		valueKrw: c.valueKrw,
		pnl: c.profitUsd !== null && c.profitPct !== null ? `${sign(c.profitUsd)}${usd(Math.abs(c.profitUsd))}` : null,
		pnlPct: c.profitPct,
		...(partial ? { pnlNote: "일부" } : {}),
		...(c.avgPriceUsd !== null
			? { pnlTitle: `평단 ${usdPrice(c.avgPriceUsd)} (현물 체결 추정${partial ? `, 보유의 ${Math.round((c.costCoverage ?? 0) * 100)}%만 설명됨` : ""})` }
			: {}),
	};
}

/** 며칠 전에 고쳤나 — 시세가 없는 값이라 오래되면 알린다 */
function ageText(iso: string): string {
	const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
	if (!(days >= 1)) return "오늘 갱신";
	return days >= 30 ? `${Math.floor(days / 30)}개월 전 갱신` : `${days}일 전 갱신`;
}

function manualRow(m: ManualAssetDto & { valueKrw: number }, total: number): HoldRow {
	return {
		key: `manual-${m.id}`,
		kind: "manual",
		name: m.name,
		sym: null,
		meta: [MANUAL_KIND_LABEL[m.kind], ageText(m.updatedAt), m.memo].filter(Boolean).join(" · "),
		metaWarn: Date.now() - Date.parse(m.updatedAt) > 90 * 86_400_000,
		price: null,
		value: m.currency === "KRW" ? won(m.valueKrw) : usd(m.amount),
		valueSub: m.currency === "USD" ? approxShort(m.valueKrw) : pctOf(m.valueKrw, total),
		valueKrw: m.valueKrw,
		pnl: null,
		pnlPct: null,
		manual: m,
	};
}

/** "10월 8일 14:32" */
function stamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function PortfolioPage({ onAskChat }: { onAskChat?: () => void } = {}) {
	/** 보유 목록 계좌 필터 — null 이면 전체 */
	const [only, setOnly] = useState<string | null>(null);
	const [showDust, setShowDust] = useState(false);
	/** 보유 목록 — 계좌별(account) 또는 같은 종목 합치기(symbol) */
	const [view, setView] = useState<"account" | "symbol">("account");
	const [kind, setKind] = useState<Kind | "all">("all");
	const [q, setQ] = useState("");
	const [sort, setSort] = useState<Sort>("value");
	const [range, setRange] = useState<RangeId>("3m");
	/** 직접 입력 자산 — 고치는 중인 id, "new" = 추가 중 */
	const [editing, setEditing] = useState<string | null>(null);
	const today = kstDate();

	const qc = useQueryClient();
	// 계좌마다 여러 API 를 부르므로 화면 복귀마다 다시 읽지 않는다 (새로고침 버튼은 있다)
	const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio, retry: false, staleTime: 30_000 });
	// 미체결은 주문 직후 바뀌므로 짧게 캐시한다
	const openOrders = useQuery({ queryKey: ["orders", "OPEN"], queryFn: () => api.orders("OPEN"), retry: false, staleTime: 5_000 });
	const cancel = useMutation({
		mutationFn: api.cancelOrder,
		onSuccess: () => {
			toast("주문을 취소했습니다");
			void qc.invalidateQueries({ queryKey: ["orders"] });
			void qc.invalidateQueries({ queryKey: ["portfolio"] });
		},
		onError: (e: Error) => toast(`취소하지 못했습니다: ${e.message}`),
	});
	// 추이 — 합계만 (보유 종목 없이). D1 이 없으면 실패하는데, 그러면 차트만 숨긴다
	const history = useQuery({
		queryKey: ["portfolio-history", today],
		queryFn: () => api.portfolioHistory(daysBefore(today, 366), today),
		retry: false,
		staleTime: 10 * 60_000,
	});
	const points = useMemo(() => historySeries(history.data?.items ?? []), [history.data]);
	const rangeFrom = daysBefore(today, RANGES.find((r) => r.id === range)!.days);
	const ranged = useMemo(() => points.filter((p) => p.date >= rangeFrom), [points, rangeFrom]);

	const p = portfolio.data;
	const total = p?.netWorthKrw ?? 0;
	const composition = p ? compositionOf(p.sources) : "";
	const daily = p ? changeSince(points, p.netWorthKrw, composition, today) : null;
	const monthly = p ? changeSince(points, p.netWorthKrw, composition, `${today.slice(0, 7)}-01`) : null;

	// ── 보유 자산 표 ──
	const holdings = (p?.holdings ?? []).filter((h) => !only || h.broker === only);
	const crypto = (p?.crypto ?? []).filter((c) => !only || c.source === only);
	const manual = (p?.manual ?? []).filter(() => !only || only === "manual");
	const dust = crypto.filter(isDust);
	const allRows: HoldRow[] = [
		...(view === "symbol" ? groupHoldings(holdings).map((g) => groupedRow(g, total)) : holdings.map((h) => stockRow(h, total))),
		...(showDust ? crypto : crypto.filter((c) => !isDust(c))).map(cryptoRow),
		...manual.map((m) => manualRow(m, total)),
	];
	const needle = q.trim().toLowerCase();
	const rows = allRows
		.filter((r) => kind === "all" || r.kind === kind)
		.filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.sym ?? "").toLowerCase().includes(needle))
		.sort(
			sort === "name"
				? (a, b) => a.name.localeCompare(b.name, "ko")
				: sort === "pnl"
					? (a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity)
					: (a, b) => b.valueKrw - a.valueKrw,
		);
	const canAddManual = (!only || only === "manual") && (kind === "all" || kind === "manual");

	async function refresh(): Promise<void> {
		const r = await portfolio.refetch();
		void openOrders.refetch();
		if (r.isError) toast(`불러오지 못했습니다: ${(r.error as Error).message}`);
		else {
			const failed = r.data?.sources.filter((s) => s.status === "failed" || s.status === "partial").map((s) => s.label) ?? [];
			toast("시세와 잔고를 새로 불러왔습니다", failed.length ? { sub: `${failed.join(" · ")} 일부 실패` } : {});
		}
	}

	const sub = p
		? [`${stamp(portfolio.dataUpdatedAt)} 갱신`, p.usdKrw > 0 ? `환율 ${Math.round(p.usdKrw).toLocaleString("ko-KR")}원${p.fxSource ? ` (${p.fxSource})` : ""}` : null]
				.filter(Boolean)
				.join(" · ")
		: undefined;

	return (
		<>
			<Topbar title="투자" sub={sub}>
				<button className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={portfolio.isFetching} aria-label="새로고침">
					{portfolio.isFetching ? <span className="spin" /> : <RefreshIcon size={15} />}
					<span className="desktop-only">새로고침</span>
				</button>
			</Topbar>

			<div className="page">
				<div className="wrap portfolio">
					{portfolio.isLoading && <p className="empty">불러오는 중…</p>}

					{portfolio.isError && (
						<div className="section-gap" style={{ maxWidth: 720 }}>
							<div className="notice bad" role="alert">
								<AlertIcon size={16} />
								<div>
									<b>{(portfolio.error as Error).message}</b>
									<p className="mt-1 text-muted">
										설정 → 연결에서 증권(KIS·토스)·코인(Binance) 키를 입력하세요. 키는 사용자별로 저장됩니다. API 가 없는 자산(예금·연금·부동산)은 아래에서 직접 입력할 수
										있습니다.
									</p>
								</div>
							</div>
							<section className="card">
								<div className="card-h">
									<h2>직접 입력 자산</h2>
								</div>
								<AddManual editing={editing} setEditing={setEditing} />
							</section>
						</div>
					)}

					{p && (
						<>
							{p.warnings.length > 0 && (
								<div className="notice warn mb-5">
									<AlertIcon size={16} />
									<div className="flex flex-col gap-1">
										{p.warnings.map((w) => (
											<span key={w}>{w}</span>
										))}
									</div>
								</div>
							)}

							<div className="grid-main">
								<div className="col">
									{/* 총자산 — 화면의 큰 숫자 하나 */}
									<section className="card fade-up o-1" aria-labelledby="nw-label">
										<div className="hero-top">
											<div className="grow">
												<div className="eyebrow" id="nw-label">
													총자산 (원화 환산)
												</div>
												<div className="big-num">
													{Math.round(p.netWorthKrw).toLocaleString("ko-KR")}
													<span className="unit">원</span>
												</div>
												<div className="hero-delta">
													{daily && <Delta label="전일 대비" c={daily} />}
													{monthly && <Delta label="이번 달" c={monthly} />}
													<span>
														<span className="muted">주식 평가손익</span>{" "}
														<b className={move(p.profitKrw)}>
															{sign(p.profitKrw)}
															{won(Math.abs(p.profitKrw))}
														</b>
													</span>
												</div>
											</div>
											{history.isSuccess && (
												<div className="seg" role="group" aria-label="차트 기간">
													{RANGES.map((r) => (
														<button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
															{r.label}
														</button>
													))}
												</div>
											)}
										</div>
										{history.isSuccess ? <NetWorthChart points={ranged} long={range === "1y"} /> : <div className="h-4" />}
									</section>

									{(openOrders.data?.orders.length ?? 0) > 0 && (
										<section className="card fade-up o-4">
											<div className="card-h">
												<h2>
													미체결 주문<span className="count">{openOrders.data?.orders.length}</span>
												</h2>
											</div>
											<div className="rows border-t border-line">
												{openOrders.data?.orders.map((o) => (
													<div key={o.orderId} className="row">
														<span className={`side-tag ${o.side === "BUY" ? "buy" : "sell"}`}>{o.side === "BUY" ? "매수" : "매도"}</span>
														<span className="grow">
															<span className="name">{o.symbol}</span>
															<span className="meta">
																{o.quantity}주 · {o.price ? Number(o.price).toLocaleString("ko-KR") : "시장가"} · {o.status}
															</span>
														</span>
														<button
															className="btn btn-secondary btn-sm"
															onClick={() => {
																if (confirm(`${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.quantity}주 주문을 취소할까요?`)) cancel.mutate(o.orderId);
															}}
															disabled={cancel.isPending}
														>
															취소
														</button>
													</div>
												))}
											</div>
										</section>
									)}

									<section className="card fade-up o-4" aria-labelledby="hold-title">
										<div className="card-h flex-wrap">
											<h2 id="hold-title">
												보유 자산<span className="count">{rows.length}</span>
											</h2>
											{only && (
												<span className="filter-pill">
													{BROKER_LABEL[only] ?? only}만
													<button onClick={() => setOnly(null)} aria-label="계좌 필터 해제">
														<XIcon size={13} />
													</button>
												</span>
											)}
											<span className="spacer" />
											<div className="seg" role="group" aria-label="보기 방식">
												<button aria-pressed={view === "account"} onClick={() => setView("account")}>
													계좌별
												</button>
												<button aria-pressed={view === "symbol"} onClick={() => setView("symbol")}>
													종목별
												</button>
											</div>
										</div>
										<div className="hold-tools">
											<label className="search-field">
												<SearchIcon size={15} />
												<span className="sr-only">종목 검색</span>
												<input className="input input-sm" type="search" placeholder="종목명·티커 검색" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
											</label>
											<div className="hscroll" role="group" aria-label="자산 종류">
												{KIND_CHIPS.map((k) => (
													<button key={k.key} className="chip" aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
														{k.label}
													</button>
												))}
											</div>
											<label>
												<span className="sr-only">정렬</span>
												<select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
													<option value="value">평가금액순</option>
													<option value="pnl">수익률순</option>
													<option value="name">이름순</option>
												</select>
											</label>
										</div>
										<div className="hold-grid hold-head" aria-hidden="true">
											<span>종목</span>
											<span className="c-price">현재가</span>
											<span className="c-val">평가금액</span>
											<span>
												<span className="desktop-only">손익</span>
												<span className="mobile-only">평가 · 손익</span>
											</span>
										</div>
										<div className="hold-list" role="list">
											{rows.map((r) =>
												r.manual && editing === r.manual.id ? (
													<ManualAssetEditor key={r.key} asset={r.manual} onDone={() => setEditing(null)} />
												) : (
													<HoldingRow key={r.key} r={r} onEdit={r.manual ? () => setEditing(r.manual!.id) : undefined} />
												),
											)}
											{rows.length === 0 && editing !== "new" && (
												<div className="empty">{allRows.length ? "조건에 맞는 자산이 없습니다." : "보유 자산이 없습니다."}</div>
											)}
										</div>
										{dust.length > 0 && (kind === "all" || kind === "crypto") && (
											<button className="row-add" onClick={() => setShowDust((v) => !v)}>
												{showDust ? <ArrowUpIcon size={14} /> : <ChevronDownIcon size={14} />}
												{showDust ? "1달러 미만 코인 접기" : `1달러 미만 코인 ${dust.length}개 더 보기`}
											</button>
										)}
										{canAddManual && <AddManual editing={editing} setEditing={setEditing} />}
									</section>
								</div>

								<div className="col">
									<AllocationCard allocation={p.allocation} total={total} />

									<section className="card fade-up o-3">
										<div className="card-h">
											<h2>계좌</h2>
											<span className="spacer" />
											<span className="eyebrow font-medium">누르면 해당 계좌만</span>
										</div>
										<div className="rows border-t border-line">
											{p.sources.map((s) => (
												<SourceRow key={s.id} s={s} total={total} active={only === s.id} onClick={() => setOnly((cur) => (cur === s.id ? null : s.id))} />
											))}
										</div>
									</section>

									<CurrencyCard p={p} showCash={!only} />

									<QuoteCard onAskChat={onAskChat} />
								</div>
							</div>
						</>
					)}

					{/* 계좌를 하나도 못 읽어도 시세 조회는 된다 */}
					{portfolio.isError && (
						<div className="mt-5" style={{ maxWidth: 720 }}>
							<QuoteCard onAskChat={onAskChat} />
						</div>
					)}
				</div>
			</div>
		</>
	);
}

function Delta({ label, c }: { label: string; c: Change }) {
	return (
		<span title={`${c.baseDate} 스냅샷 ${won(c.base)} 기준 (입출금 포함)`}>
			<span className="muted">{label}</span>{" "}
			<b className={move(c.diff)}>
				{sign(c.diff)}
				{won(Math.abs(c.diff))} ({signedPct(c.pct)})
			</b>
		</span>
	);
}

function HoldingRow({ r, onEdit }: { r: HoldRow; onEdit: (() => void) | undefined }) {
	const body = (
		<>
			<div className="min-w-0">
				<div className="name">
					<span>{r.name}</span>
					{r.sym && <span className="mono">{r.sym}</span>}
				</div>
				<div className={`meta ${r.metaWarn ? "danger-text" : ""}`} title={r.meta}>
					{r.meta}
				</div>
			</div>
			<div className="c-price">
				<div className="v sm">{r.price ?? "—"}</div>
			</div>
			<div className="c-val">
				<div className="v">{r.value}</div>
				<div className="s muted" title={approxWon(r.valueKrw) || undefined}>
					{r.valueSub}
				</div>
			</div>
			<div>
				<div className="v mobile-only">{r.valueKrw > 0 ? compactWon(r.valueKrw) : r.value}</div>
				{r.pnlPct === null ? (
					<div className="s muted">{r.manual ? "직접 입력" : "손익 없음"}</div>
				) : (
					<>
						<div className={`v desktop-only ${move(r.pnlPct)}`}>{r.pnl}</div>
						<div className={`s ${move(r.pnlPct)}`} title={r.pnlTitle}>
							{signedPct(r.pnlPct)}
							{r.pnlNote ? ` ${r.pnlNote}` : ""}
						</div>
					</>
				)}
			</div>
		</>
	);
	if (onEdit)
		return (
			<button className="hold-grid hold-row" role="listitem" onClick={onEdit} title="눌러서 금액 고치기">
				{body}
			</button>
		);
	return (
		<div className="hold-grid hold-row" role="listitem">
			{body}
		</div>
	);
}

function AddManual({ editing, setEditing }: { editing: string | null; setEditing: (v: string | null) => void }) {
	if (editing === "new") return <ManualAssetEditor onDone={() => setEditing(null)} />;
	return (
		<button className="row-add" onClick={() => setEditing("new")}>
			<PlusIcon size={14} />
			직접 입력 자산 추가 (예금·연금·부동산 등)
		</button>
	);
}

function AllocationCard({ allocation, total }: { allocation: PortfolioDto["allocation"]; total: number }) {
	const slices = SLICES.filter((s) => allocation[s.key] > 0);
	if (total <= 0 || slices.length === 0) return null;
	return (
		<section className="card fade-up o-2">
			<div className="card-h">
				<h2>자산 배분</h2>
			</div>
			<div className="card-b">
				<div className="bar" role="img" aria-label={slices.map((s) => `${s.label} ${pctOf(allocation[s.key], total)}`).join(", ")}>
					{slices.map((s) => (
						<i key={s.key} style={{ width: `${(allocation[s.key] / total) * 100}%`, background: s.color }} title={`${s.label} ${pctOf(allocation[s.key], total)}`} />
					))}
				</div>
				<div className="mt-3">
					{slices.map((s) => (
						<div key={s.key} className="alloc-row">
							<span className="sw" style={{ background: s.color }} />
							<span>{s.label}</span>
							<span className="pct">{pctOf(allocation[s.key], total)}</span>
							<span className="amt" title={won(allocation[s.key])}>
								{compactWon(allocation[s.key])}
							</span>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

const STATUS: Record<PortfolioSourceDto["status"], { text: string; tone: string } | null> = {
	ok: null,
	partial: { text: "일부 누락", tone: "warn" },
	failed: { text: "조회 실패", tone: "bad" },
	skipped: { text: "제외", tone: "" },
};

function SourceRow({ s, total, active, onClick }: { s: PortfolioSourceDto; total: number; active: boolean; onClick: () => void }) {
	const status = STATUS[s.status];
	// 화폐별 원래 통화 — 계좌 합계(원화 환산)만으로는 달러·코인이 얼마인지 모른다
	const parts = [s.byCurrency.krw !== 0 && won(s.byCurrency.krw), s.byCurrency.usd !== 0 && usdCash(s.byCurrency.usd), s.byCurrency.usdt !== 0 && usdt(s.byCurrency.usdt)].filter(
		Boolean,
	);
	const usable = s.status === "ok" || s.status === "partial";
	const detail = usable ? [...parts, ...s.warnings].join(" · ") || "잔고 없음" : (s.error ?? "");
	return (
		<button className="row row-btn" aria-pressed={active} disabled={!usable} onClick={onClick}>
			<span className="grow">
				<span className="name flex items-center gap-2">
					{s.label}
					{status && <span className={`badge ${status.tone}`}>{status.text}</span>}
				</span>
				<span className={`meta ${usable ? "" : "danger-text"}`} title={detail}>
					{detail}
				</span>
			</span>
			{usable && (
				<span className="amt">
					<b>{compactWon(s.valueKrw)}</b>
					<small className="muted">{pctOf(s.valueKrw, total)}</small>
				</span>
			)}
		</button>
	);
}

/** 화폐별 — 원화 · 달러 · 코인(USDT). 아래에 예수금 (계좌 필터 중에는 숨긴다 — 계좌별로 나뉘지 않는다) */
function CurrencyCard({ p, showCash }: { p: PortfolioDto; showCash: boolean }) {
	const tiles = [
		{ key: "krw", label: "원화", main: won(p.byCurrency.krw), sub: "", share: p.byCurrencyKrw.krw, show: p.byCurrency.krw !== 0 },
		{ key: "usd", label: "달러", main: usdCash(p.byCurrency.usd), sub: approxWon(p.byCurrencyKrw.usd), share: p.byCurrencyKrw.usd, show: p.byCurrency.usd !== 0 },
		{ key: "usdt", label: "코인 (USDT 환산)", main: usdt(p.byCurrency.usdt), sub: approxWon(p.byCurrencyKrw.usdt), share: p.byCurrencyKrw.usdt, show: p.byCurrency.usdt !== 0 },
	].filter((t) => t.show);
	const cash = showCash && (p.cashKrw > 0 || p.cashUsd > 0);
	if (tiles.length === 0 && !cash) return null;
	return (
		<section className="card fade-up o-5">
			<div className="card-h">
				<h2>화폐별</h2>
			</div>
			<div className="rows border-t border-line">
				{tiles.map((t) => (
					<div key={t.key} className="row">
						<span className="grow">
							<span className="name">{t.label}</span>
							<span className="meta">총자산의 {pctOf(t.share, p.netWorthKrw)}</span>
						</span>
						<span className="amt">
							<b>{t.main}</b>
							{t.sub && <small className="muted">{t.sub}</small>}
						</span>
					</div>
				))}
				{cash && (
					<div className="row">
						<span className="grow">
							<span className="name">예수금</span>
							<span className="meta">주문에 바로 쓸 수 있는 현금</span>
						</span>
						<span className="amt">
							{p.cashKrw > 0 && <b>{won(p.cashKrw)}</b>}
							{p.cashUsd > 0 && (p.cashKrw > 0 ? <small className="muted">{usdCash(p.cashUsd)}</small> : <b>{usdCash(p.cashUsd)}</b>)}
						</span>
					</div>
				)}
			</div>
		</section>
	);
}

function QuoteCard({ onAskChat }: { onAskChat: (() => void) | undefined }) {
	const [symbol, setSymbol] = useState("");
	const [lookup, setLookup] = useState<string | null>(null);
	const [empty, setEmpty] = useState(false);
	const quote = useQuery({
		queryKey: ["quote", lookup],
		queryFn: () => api.quote(lookup as string),
		enabled: lookup !== null,
		retry: false,
	});
	const d = quote.data;

	return (
		<section className="card fade-up o-6">
			<div className="card-h">
				<h2>시세 조회</h2>
			</div>
			<div className="card-b">
				<form
					className="quote-form"
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						const s = symbol.trim();
						setEmpty(!s);
						if (s) setLookup(s);
					}}
				>
					<label className="sr-only" htmlFor="quote-q">
						종목코드 또는 티커
					</label>
					<input
						id="quote-q"
						className="input"
						placeholder="종목코드 또는 티커 (예: 005930, AAPL)"
						autoComplete="off"
						value={symbol}
						aria-invalid={empty}
						onChange={(e) => {
							setSymbol(e.target.value);
							setEmpty(false);
						}}
					/>
					<button className="btn btn-secondary" type="submit">
						조회
					</button>
				</form>
				<div className="quote-out" aria-live="polite">
					{empty && <div className="field-err">종목코드나 티커를 입력하세요.</div>}
					{quote.isFetching && (
						<div className="flex items-center gap-2 text-[13px] text-muted">
							<span className="spin" />
							불러오는 중…
						</div>
					)}
					{!quote.isFetching && quote.isError && (
						<div className="notice">
							<AlertIcon size={16} />
							<span>
								{(quote.error as Error).message} — 국내는 6자리 종목코드, 해외는 티커로 입력하세요.
							</span>
						</div>
					)}
					{!quote.isFetching && d && (
						<>
							<div className="q-name">
								<b>{d.name}</b>
								<span className="mono muted">{d.symbol}</span>
								{d.exchange && <span className="badge">{d.exchange}</span>}
							</div>
							<div className="q-price">{d.currency === "KRW" ? won(d.price) : usd(d.price)}</div>
							<div className={`num text-[13px] font-semibold ${move(d.changePct)}`}>전일 대비 {signedPct(d.changePct)}</div>
							{onAskChat && (
								<div className="mt-3">
									<button className="text-link text-[13px]" onClick={onAskChat}>
										챗에서 분석·주문 준비하기
									</button>
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</section>
	);
}
