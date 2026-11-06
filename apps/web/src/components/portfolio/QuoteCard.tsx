import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { AlertIcon } from "../icons.tsx";
import { move, signedPct, usd, won } from "./format.ts";

export function QuoteCard({ onAskChat }: { onAskChat: (() => void) | undefined }) {
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
