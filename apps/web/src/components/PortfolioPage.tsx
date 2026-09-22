/**
 * 투자 화면 — 에이전트를 거치지 않는 직접 경로 (PLAN.md §3.2).
 *
 * 챗은 "삼성전자 얼마야" 같은 질문에 강하고, 이 화면은 보유 현황을 훑어보는 데 강하다.
 * 둘은 같은 증권 계정을 본다.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.ts";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

function moveClass(n: number): string {
	if (n > 0) return "text-up";
	if (n < 0) return "text-down";
	return "text-muted";
}

const sign = (n: number): string => (n > 0 ? "+" : "");

export function PortfolioPage() {
	const [symbol, setSymbol] = useState("");
	const [lookup, setLookup] = useState<string | null>(null);

	const qc = useQueryClient();
	const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio, retry: false });
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
	const quote = useQuery({
		queryKey: ["quote", lookup],
		queryFn: () => api.quote(lookup as string),
		enabled: lookup !== null,
		retry: false,
	});

	const p = portfolio.data;
	const total = (p?.stockValueKrw ?? 0) + (p?.cashKrw ?? 0);

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				{/* 시세 조회 */}
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

				{quote.isError && (
					<p className="text-sm text-danger">{(quote.error as Error).message}</p>
				)}
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
								{quote.data.currency === "KRW"
									? won(quote.data.price)
									: `$${quote.data.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
							</div>
							<div className={`text-xs ${moveClass(quote.data.change)}`}>
								{sign(quote.data.changePct)}
								{quote.data.changePct}%
							</div>
						</div>
					</div>
				)}

				{/* 보유 현황 */}
				{portfolio.isLoading && <p className="text-sm text-muted">불러오는 중…</p>}

				{portfolio.isError && (
					<div className="rounded-xl border border-line bg-inset p-4">
						<p className="text-sm text-danger">{(portfolio.error as Error).message}</p>
						<p className="mt-2 text-xs text-faint">
							설정 &gt; 증권 (KIS) 또는 증권 (토스) 에서 키를 입력하세요. 키는 사용자별로 저장됩니다.
						</p>
					</div>
				)}

				{p && (
					<>
						<div className="flex items-baseline justify-between">
							<span className="text-sm text-muted">
								{p.holdings.length}종목
								{p.brokers.length > 0
									? ` · ${p.brokers.map((b) => (b === "kis" ? "KIS" : "토스")).join(" + ")}`
									: ""}
								{p.usdKrw > 0 ? ` · 환율 ${Math.round(p.usdKrw).toLocaleString("ko-KR")}원` : ""}
							</span>
							<div className="text-right">
								<div className="text-xl font-semibold text-ink">{won(total)}</div>
								<div className={`text-xs ${moveClass(p.profitKrw)}`}>
									평가손익 {sign(p.profitKrw)}
									{won(p.profitKrw)} · 예수금 {won(p.cashKrw)}
								</div>
							</div>
						</div>

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

						<section>
							<h2 className="mb-2 text-sm font-medium text-muted">보유 종목</h2>
							<div className="overflow-hidden rounded-xl border border-line">
								{p.holdings.map((h) => (
									<div
										key={`${h.broker}-${h.market}-${h.symbol}`}
										className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0"
									>
										<div className="min-w-0">
											<div className="truncate text-sm text-ink">{h.name}</div>
											<div className="text-xs text-muted">
												{h.quantity.toLocaleString("ko-KR")}주 · 평단{" "}
												{h.currency === "KRW"
													? won(h.avgPrice)
													: `$${h.avgPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
												{h.market === "overseas" ? " · 해외" : ""}
												{` · ${h.broker === "kis" ? "KIS" : "토스"}`}
											</div>
										</div>
										<div className="shrink-0 text-right">
											<div className="text-sm text-ink">{won(h.valueKrw)}</div>
											<div className={`text-xs ${moveClass(h.profitPct)}`}>
												{sign(h.profitPct)}
												{h.profitPct}%
											</div>
										</div>
									</div>
								))}
								{p.holdings.length === 0 && (
									<p className="px-4 py-6 text-center text-sm text-muted">보유 종목이 없습니다.</p>
								)}
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}
