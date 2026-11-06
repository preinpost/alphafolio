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
import { AlertIcon, RefreshIcon } from "./icons.tsx";
import { AccountsCard } from "./portfolio/AccountsCard.tsx";
import { AllocationCard } from "./portfolio/AllocationCard.tsx";
import { CurrencyCard } from "./portfolio/CurrencyCard.tsx";
import { AddManual, HoldingsCard } from "./portfolio/HoldingsCard.tsx";
import { NetWorthCard } from "./portfolio/NetWorthCard.tsx";
import { OpenOrdersCard } from "./portfolio/OpenOrdersCard.tsx";
import { QuoteCard } from "./portfolio/QuoteCard.tsx";
import { usePortfolioPage } from "./portfolio/usePortfolioPage.ts";
import { Topbar } from "./Topbar.tsx";

export function PortfolioPage({ onAskChat }: { onAskChat?: () => void } = {}) {
	const { only, setOnly, range, setRange, editing, setEditing, portfolio, openOrders, cancel, history, ranged, p, total, daily, monthly, holdingsView, canAddManual, refresh, sub } =
		usePortfolioPage();

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
									<NetWorthCard
										p={p}
										daily={daily}
										monthly={monthly}
										historyReady={history.isSuccess}
										range={range}
										setRange={setRange}
										points={ranged}
									/>

									{(openOrders.data?.orders.length ?? 0) > 0 && (
										<OpenOrdersCard orders={openOrders.data?.orders ?? []} onCancel={(id) => cancel.mutate(id)} cancelling={cancel.isPending} />
									)}

									<HoldingsCard holdings={holdingsView} only={only} setOnly={setOnly} editing={editing} setEditing={setEditing} canAddManual={canAddManual} />
								</div>

								<div className="col">
									<AllocationCard allocation={p.allocation} total={total} />

									<AccountsCard sources={p.sources} total={total} only={only} setOnly={setOnly} />

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
