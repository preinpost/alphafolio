import type { BrokerOrder } from "@alphafolio/protocol";

/** 미체결 주문 — 줄마다 취소 */
export function OpenOrdersCard({ orders, onCancel, cancelling }: { orders: BrokerOrder[]; onCancel: (orderId: string) => void; cancelling: boolean }) {
	return (
		<section className="card fade-up o-4">
			<div className="card-h">
				<h2>
					미체결 주문<span className="count">{orders.length}</span>
				</h2>
			</div>
			<div className="rows border-t border-line">
				{orders.map((o) => (
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
								if (confirm(`${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.quantity}주 주문을 취소할까요?`)) onCancel(o.orderId);
							}}
							disabled={cancelling}
						>
							취소
						</button>
					</div>
				))}
			</div>
		</section>
	);
}
