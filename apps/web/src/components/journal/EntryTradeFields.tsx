import { BROKER_LABEL, kstToday } from "../../lib/journal.ts";
import type { Form } from "./useEntryDialog.ts";

/** 직접 기록의 매매 칸 — 매수·매도, 종목, 수량·가격, 날짜·계좌, 통화·수수료 */
export function EntryTradeFields({ f, set }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void }) {
	return (
		<>
			<div className="seg block" role="group" aria-label="매수·매도">
				<button type="button" aria-pressed={f.side === "BUY"} onClick={() => set("side", "BUY")}>
					매수
				</button>
				<button type="button" aria-pressed={f.side === "SELL"} onClick={() => set("side", "SELL")}>
					매도
				</button>
			</div>
			<div className="grid2">
				<label className="field">
					<span>종목코드·티커</span>
					<input className="input mono" placeholder="005930, AAPL, BTCUSDT" autoComplete="off" value={f.symbol} onChange={(e) => set("symbol", e.target.value)} />
				</label>
				<label className="field">
					<span>종목명 (선택)</span>
					<input className="input" placeholder="삼성전자" autoComplete="off" value={f.name} onChange={(e) => set("name", e.target.value)} />
				</label>
			</div>
			<div className="grid2">
				<label className="field">
					<span>수량</span>
					<input className="input" inputMode="decimal" placeholder="10" autoComplete="off" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} />
				</label>
				<label className="field">
					<span>평균 체결가 (선택)</span>
					<input className="input" inputMode="decimal" placeholder="71,000" autoComplete="off" value={f.price} onChange={(e) => set("price", e.target.value)} />
				</label>
			</div>
			<div className="grid2">
				<label className="field">
					<span>날짜</span>
					<input className="input" type="date" max={kstToday()} value={f.date} onChange={(e) => set("date", e.target.value || kstToday())} />
				</label>
				<label className="field">
					<span>어디서</span>
					<select className="input" value={f.broker} onChange={(e) => set("broker", e.target.value as Form["broker"])}>
						{Object.entries(BROKER_LABEL).map(([k, v]) => (
							<option key={k} value={k}>
								{v}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="grid2">
				<label className="field">
					<span>통화 (비우면 종목으로)</span>
					<input className="input mono" placeholder="KRW · USD · USDT" autoComplete="off" value={f.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
				</label>
				<label className="field">
					<span>수수료·세금 (선택)</span>
					<input className="input" inputMode="decimal" autoComplete="off" value={f.fee} onChange={(e) => set("fee", e.target.value)} />
				</label>
			</div>
		</>
	);
}
