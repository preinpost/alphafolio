/**
 * 증권 카드 — 시세 / 차트 / 보유종목 / 자산현황.
 *
 * 차트는 외부 라이브러리 없이 SVG 스파크라인으로 그린다. 봉 하나하나를 정확히
 * 읽는 용도가 아니라 **추세를 한눈에 보는** 용도라서 이 정도면 충분하고,
 * 번들도 늘지 않는다 (필요해지면 그때 캔들 라이브러리를 붙인다).
 */
import type {
	FinancialsCard,
	HoldingsCard,
	MoversCard,
	NewsCard,
	OverviewCard,
	PortfolioSignalsCard,
	QuoteCard,
	ResearchCard,
	ResearchSection,
	TechnicalCard,
	TimingCard,
} from "@alphafolio/protocol";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

function money(value: number, currency: "KRW" | "USD"): string {
	return currency === "KRW"
		? won(value)
		: `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** 등락 색 — 한국 증시 관례(상승=빨강, 하락=파랑). 가계부와 색 언어가 다르다. */
function moveClass(n: number): string {
	if (n > 0) return "text-up";
	if (n < 0) return "text-down";
	return "text-muted";
}

function sign(n: number): string {
	return n > 0 ? "+" : "";
}

// ── 현재가 ──────────────────────────────────────────────────────────────

export function QuoteCardView({ card }: { card: QuoteCard }) {
	const q = card.quote;
	const meta: string[] = [];
	if (q.per !== null) meta.push(`PER ${q.per}`);
	if (q.pbr !== null) meta.push(`PBR ${q.pbr}`);
	if (q.volume !== null) meta.push(`거래량 ${q.volume.toLocaleString("ko-KR")}`);

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset px-4 py-3">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-ink">{q.name}</div>
					<div className="text-xs text-faint">
						{q.symbol}
						{q.exchange ? ` · ${q.exchange}` : ""}
					</div>
				</div>
				<div className="shrink-0 text-right">
					<div className="text-base font-semibold text-ink">{money(q.price, q.currency)}</div>
					{/* 토스 시세는 전일대비를 주지 않아 0 으로 온다 — 0%를 등락처럼 보이게 하지 않는다 */}
					{q.source === "toss" ? (
						<div className="text-xs text-faint">토스 시세</div>
					) : (
						<div className={`text-xs ${moveClass(q.change)}`}>
							{sign(q.change)}
							{money(q.change, q.currency)} ({sign(q.changePct)}
							{q.changePct}%)
						</div>
					)}
				</div>
			</div>

			{meta.length > 0 && <div className="mt-2 text-xs text-muted">{meta.join(" · ")}</div>}

			{q.high52 !== null && q.low52 !== null && q.high52 > q.low52 && (
				<Range low={q.low52} high={q.high52} value={q.price} currency={q.currency} label="52주" />
			)}
		</div>
	);
}

function Range({
	low,
	high,
	value,
	currency,
	label,
}: {
	low: number;
	high: number;
	value: number;
	currency: "KRW" | "USD";
	label: string;
}) {
	const pct = Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
	return (
		<div className="mt-3">
			<div className="flex justify-between text-[11px] text-faint">
				<span>
					{label} {money(low, currency)}
				</span>
				<span>{money(high, currency)}</span>
			</div>
			<div className="relative mt-1 h-1 rounded-full bg-hover">
				<div className="absolute -top-0.5 size-2 rounded-full bg-accent" style={{ left: `calc(${pct}% - 4px)` }} />
			</div>
		</div>
	);
}

// ── 기술적 지표 ─────────────────────────────────────────────────────────

/** 0~100 위치를 막대로 — RSI·볼린저 밴드 내 위치처럼 범위가 고정된 값에만 쓴다. */
function Gauge({ value, label, lowMark, highMark }: { value: number; label: string; lowMark?: number; highMark?: number }) {
	const clamped = Math.min(100, Math.max(0, value));
	const hot = highMark !== undefined && value >= highMark;
	const cold = lowMark !== undefined && value <= lowMark;
	return (
		<div>
			<div className="flex justify-between text-[11px]">
				<span className="text-faint">{label}</span>
				<span className={hot ? "text-up" : cold ? "text-down" : "text-muted"}>{value}</span>
			</div>
			<div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
				<div
					className={`h-full rounded-full ${hot ? "bg-up" : cold ? "bg-down" : "bg-accent"}`}
					style={{ width: `${clamped}%` }}
				/>
			</div>
		</div>
	);
}

export function TechnicalCardView({ card }: { card: TechnicalCard }) {
	const s = card.snapshot;
	if (!s) {
		return (
			<div className="mt-2 rounded-xl border border-line bg-inset px-4 py-3 text-xs text-muted">
				{card.symbol} 지표를 계산할 데이터가 없습니다.
			</div>
		);
	}

	const cur = card.currency;
	const ma = (v: number | null): string => (v === null ? "—" : money(v, cur));
	const periodLabel = card.period === "W" ? "주봉" : card.period === "M" ? "월봉" : "일봉";

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-ink">{card.name}</div>
					<div className="text-xs text-faint">
						{card.symbol} · {periodLabel} {s.bars}개 · {s.lastDate}
					</div>
				</div>
				<div className="shrink-0 text-right">
					<div className="text-base font-semibold text-ink">{money(s.price, cur)}</div>
					<div className={`text-xs ${moveClass(s.periodChangePct)}`}>
						기간 {sign(s.periodChangePct)}
						{s.periodChangePct}%
					</div>
				</div>
			</div>

			<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
				<div className="text-muted">
					MA 5/20/60
					<div className="text-ink">
						{ma(s.ma5)} · {ma(s.ma20)} · {ma(s.ma60)}
					</div>
				</div>
				<div className="text-muted">
					추세
					<div className={s.trend === "정배열" ? "text-up" : s.trend === "역배열" ? "text-down" : "text-ink"}>
						{s.trend}
					</div>
				</div>
				<div className="text-muted">
					지지 / 저항
					<div className="text-ink">
						{ma(s.support)} · {ma(s.resistance)}
					</div>
				</div>
				<div className="text-muted">
					ATR
					<div className="text-ink">
						{ma(s.atr)}
						{s.atrPct !== null ? ` (${s.atrPct}%)` : ""}
					</div>
				</div>
			</div>

			<div className="mt-3 space-y-2">
				{s.rsi !== null && <Gauge value={s.rsi} label="RSI(14)" lowMark={30} highMark={70} />}
				{s.bollingerPct !== null && (
					<Gauge value={Math.round(s.bollingerPct)} label={`볼린저 ${ma(s.bollingerLower)} ~ ${ma(s.bollingerUpper)}`} lowMark={0} highMark={100} />
				)}
			</div>

			{s.signals.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
					{s.signals.map((sig) => (
						<span key={sig} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink">
							{sig}
						</span>
					))}
				</div>
			)}

			{card.note && <p className="mt-2 text-[11px] text-faint">{card.note}</p>}
		</div>
	);
}

// ── 타점 판정 ───────────────────────────────────────────────────────────

const VERDICT_CLASS: Record<string, string> = {
	매수: "border-up/60 text-up",
	매도: "border-down/60 text-down",
	관망: "border-line text-muted",
};

const LAYER_DOT: Record<string, string> = { 우호: "bg-up", 비우호: "bg-down", 중립: "bg-faint" };

export function TimingCardView({ card }: { card: TimingCard }) {
	const r = card.result;
	const cur = card.currency;
	const m = (v: number | null): string => (v === null ? "—" : money(v, cur));

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-ink">{card.name}</div>
					<div className="text-xs text-faint">
						{card.symbol} · 일봉 {r.snapshot.bars}개 · {r.snapshot.lastDate} · {m(r.price)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{r.horizon === "short" && (
						<span className="rounded-md bg-selected px-1.5 py-0.5 text-[11px] text-muted">단기 1주</span>
					)}
					<span className={`rounded-lg border px-2.5 py-1 text-sm font-semibold ${VERDICT_CLASS[r.verdict]}`}>
						{r.verdict}
					</span>
				</div>
			</div>
			<p className="mt-2 text-xs text-ink">{r.summary}</p>
			{r.entry?.type === "breakout" && (
				<p className="mt-1 text-xs text-muted">
					진입 기준 <span className="text-ink">{m(r.entry.price)}</span> 돌파 시 · 손익비·수량은 이 가격 기준
				</p>
			)}

			<div className="mt-3 space-y-1.5 border-t border-line pt-3">
				{r.layers.map((l) => (
					<div key={l.name} className="flex gap-2 text-xs">
						<span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${LAYER_DOT[l.state]}`} />
						<span className="w-10 shrink-0 text-muted">{l.name}</span>
						<span className="text-ink">{l.reasons.join(" · ")}</span>
					</div>
				))}
			</div>

			<div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
				<div>
					<div className="text-faint">손절</div>
					<div className="text-down">{m(r.stopLoss)}</div>
				</div>
				<div>
					<div className="text-faint">목표 1 / 2</div>
					<div className="text-up">
						{m(r.target1)}
						<span className="text-faint"> / {m(r.target2)}</span>
					</div>
				</div>
				<div>
					<div className="text-faint">손익비</div>
					<div className="text-ink">{r.riskReward !== null ? `1 : ${r.riskReward}` : "—"}</div>
				</div>
			</div>

			<div className="mt-3 space-y-1 border-t border-line pt-3">
				{r.scenarios.map((sc) => (
					<div key={sc.id} className="text-xs">
						<span className="text-faint">{sc.id}</span> <span className="text-ink">{sc.title}</span>
						<span className="text-muted">
							{" "}
							— {sc.trigger} → {sc.action}
							{sc.weightPct > 0 ? ` (${sc.weightPct}%)` : ""}
						</span>
					</div>
				))}
			</div>

			<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
				{r.holding && (
					<span>
						보유 {r.holding.quantity}주 · 평단 {m(r.holding.avgPrice)} ({sign(r.holding.pnlPct)}
						{r.holding.pnlPct}%)
					</span>
				)}
				<span>
					손익분기 {m(r.breakeven)} (왕복 {r.roundTripCostPct}% 가정)
				</span>
				{r.sizing && (
					<span>
						권장 {r.sizing.quantity}주 (손절 시 총자산 {r.sizing.riskPct}%)
					</span>
				)}
			</div>

			{card.notes.map((n) => (
				<p key={n} className="mt-1 text-[11px] text-faint">
					⚠️ {n}
				</p>
			))}
			<p className="mt-2 text-[11px] text-faint">규칙 기반 판정 · 매매 권유 아님 · 실적·공시 이벤트 미반영</p>
		</div>
	);
}

// ── 종목 리서치 ─────────────────────────────────────────────────────────

/** 실패·해당 없음 섹션은 조용히 숨기지 않고 한 줄로 이유를 보여준다. */
function SectionGap({ label, s }: { label: string; s: ResearchSection<unknown> }) {
	if (s.status === "ok") return null;
	return (
		<div className="text-[11px] text-faint">
			{label}: {s.status === "skipped" ? s.reason : `조회 실패 — ${s.error}`}
		</div>
	);
}

function eokShort(value: number | null): string {
	if (value === null) return "—";
	return Math.abs(value) >= 10_000
		? `${(value / 10_000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조`
		: `${Math.round(value).toLocaleString("ko-KR")}억`;
}

export function ResearchCardView({ card }: { card: ResearchCard }) {
	const cur = card.currency;
	const m = (v: number | null): string => (v === null ? "—" : money(v, cur));
	const pct = (v: number | null): string => (v === null ? "—" : `${sign(v)}${v}%`);
	const q = card.quote.status === "ok" ? card.quote.data : null;
	const t = card.technical.status === "ok" ? card.technical.data : null;
	const f = card.financials.status === "ok" ? card.financials.data : null;
	const h = card.holding.status === "ok" ? card.holding.data : null;

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-ink">{card.name}</div>
					<div className="text-xs text-faint">{card.symbol} · 종목 리서치</div>
				</div>
				{q && (
					<div className="shrink-0 text-right">
						<div className="text-base font-semibold text-ink">{m(q.price)}</div>
						<div className={`text-xs ${moveClass(q.changePct)}`}>{pct(q.changePct)}</div>
					</div>
				)}
			</div>

			{q && (q.per !== null || q.pos52 !== null) && (
				<div className="mt-3 border-t border-line pt-3 text-xs">
					<div className="flex flex-wrap gap-x-4 text-muted">
						{q.per !== null && <span>PER {q.per}</span>}
						{q.pbr !== null && <span>PBR {q.pbr}</span>}
					</div>
					{q.pos52 !== null && (
						<div className="mt-2">
							<div className="flex justify-between text-[11px] text-faint">
								<span>52주 {m(q.low52)}</span>
								<span>{m(q.high52)}</span>
							</div>
							<div className="relative mt-1 h-1.5 rounded-full bg-hover">
								<div
									className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
									style={{ left: `${Math.min(100, Math.max(0, q.pos52))}%` }}
								/>
							</div>
						</div>
					)}
				</div>
			)}

			{t && (
				<div className="mt-3 border-t border-line pt-3 text-xs text-muted">
					<span className={t.trend === "정배열" ? "text-up" : t.trend === "역배열" ? "text-down" : "text-ink"}>{t.trend}</span>
					{" · "}RSI {t.rsi ?? "—"} · 지지 {m(t.support)} / 저항 {m(t.resistance)}
					{t.signals.length > 0 && <div className="mt-1 text-[11px] text-ink">{t.signals.join(" · ")}</div>}
				</div>
			)}

			{f?.latest && (
				<div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
					<div>
						<div className="text-faint">매출</div>
						<div className="text-ink">{eokShort(f.latest.revenue)}</div>
						<div className="text-[11px] text-muted">{pct(f.yoy?.revenue ?? null)}</div>
					</div>
					<div>
						<div className="text-faint">영업익</div>
						<div className="text-ink">{eokShort(f.latest.operatingProfit)}</div>
						<div className="text-[11px] text-muted">{pct(f.yoy?.operatingProfit ?? null)}</div>
					</div>
					<div>
						<div className="text-faint">투자의견</div>
						<div className="text-ink">
							{f.consensus.covered ? f.consensus.rating : f.consensus.error ? "조회 실패" : "미커버"}
						</div>
						<div className="text-[11px] text-muted">ROE {f.latest.roe ?? "—"}%</div>
					</div>
				</div>
			)}

			{card.holding.status === "ok" && (
				<div className="mt-3 border-t border-line pt-3 text-xs text-muted">
					{h ? (
						<>
							내 보유 {h.quantity}주 · 평단 {m(h.avgPrice)} ·{" "}
							<span className={moveClass(h.profitPct)}>{pct(h.profitPct)}</span>
						</>
					) : (
						"보유하지 않음"
					)}
				</div>
			)}

			{card.news.status === "ok" && card.news.data.length > 0 && (
				<div className="mt-3 space-y-1 border-t border-line pt-3">
					{card.news.data.map((n) => (
						<a
							key={n.link || n.title}
							href={n.link}
							target="_blank"
							rel="noreferrer noopener"
							className="block truncate text-xs text-ink hover:underline"
						>
							<span className="text-faint">{n.date.slice(5)}</span> {n.title}
						</a>
					))}
				</div>
			)}

			<div className="mt-3 space-y-0.5">
				<SectionGap label="시세" s={card.quote} />
				<SectionGap label="지표" s={card.technical} />
				<SectionGap label="재무" s={card.financials} />
				<SectionGap label="뉴스" s={card.news} />
				<SectionGap label="보유" s={card.holding} />
			</div>
		</div>
	);
}

// ── 보유 종목 점검 ──────────────────────────────────────────────────────

export function PortfolioSignalsCardView({ card }: { card: PortfolioSignalsCard }) {
	return (
		<div className="mt-2 overflow-hidden rounded-xl border border-line bg-inset">
			<div className="px-4 py-2.5 text-xs text-muted">보유 {card.rows.length}종목 기술적 점검</div>
			{card.rows.map((r) => (
				<div key={r.symbol} className="border-t border-line px-4 py-2.5">
					<div className="flex items-baseline justify-between gap-2">
						<span className="truncate text-sm text-ink">{r.name}</span>
						<span className={`shrink-0 text-sm ${moveClass(r.vsAvgPct)}`}>
							평단 대비 {sign(r.vsAvgPct)}
							{r.vsAvgPct}%
						</span>
					</div>
					<div className="mt-0.5 text-[11px] text-faint">
						{money(r.price, r.currency)} · {r.trend}
						{r.rsi !== null ? ` · RSI ${r.rsi}` : ""}
					</div>
					{r.signals.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{r.signals.map((sig) => (
								<span key={sig} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
									{sig}
								</span>
							))}
						</div>
					)}
				</div>
			))}
			{card.skipped.length > 0 && (
				<div className="border-t border-line px-4 py-2 text-[11px] text-faint">제외: {card.skipped.join(", ")}</div>
			)}
		</div>
	);
}

// ── 보유종목 ────────────────────────────────────────────────────────────

export function HoldingsCardView({ card }: { card: HoldingsCard }) {
	const total = card.stockValueKrw || 1;

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="mb-3 flex items-baseline justify-between">
				<span className="text-xs text-muted">
					{card.holdings.length}종목
					{card.brokers.length > 0
						? ` · ${card.brokers.map((b) => (b === "kis" ? "KIS" : "토스")).join("+")}`
						: ""}
					{card.usdKrw > 0 ? ` · 환율 ${Math.round(card.usdKrw).toLocaleString("ko-KR")}원` : ""}
				</span>
				<div className="text-right">
					<div className="text-sm font-semibold text-ink">{won(card.stockValueKrw)}</div>
					<div className={`text-xs ${moveClass(card.profitKrw)}`}>
						{sign(card.profitKrw)}
						{won(card.profitKrw)}
					</div>
				</div>
			</div>

			<div className="space-y-2">
				{card.holdings.slice(0, 12).map((h) => (
					<div key={`${h.broker}-${h.market}-${h.symbol}`}>
						<div className="flex justify-between gap-2 text-xs">
							<span className="truncate text-ink">{h.name}</span>
							<span className="shrink-0 text-muted">
								{won(h.valueKrw)}{" "}
								<span className={moveClass(h.profitPct)}>
									{sign(h.profitPct)}
									{h.profitPct}%
								</span>
							</span>
						</div>
						<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
							<div className="h-full rounded-full bg-accent" style={{ width: `${(h.valueKrw / total) * 100}%` }} />
						</div>
					</div>
				))}
			</div>

			{card.cashKrw > 0 && (
				<div className="mt-3 flex justify-between border-t border-line pt-2 text-xs text-muted">
					<span>예수금</span>
					<span>{won(card.cashKrw)}</span>
				</div>
			)}
		</div>
	);
}

// ── 시장 랭킹 ───────────────────────────────────────────────────────────

export function MoversCardView({ card }: { card: MoversCard }) {
	const amount = (n: number, currency: "KRW" | "USD"): string =>
		currency === "KRW"
			? `${Math.round(n / 100_000_000).toLocaleString("ko-KR")}억`
			: `$${(n / 1_000_000).toFixed(1)}M`;

	return (
		<div className="mt-2 overflow-hidden rounded-xl border border-line bg-inset">
			<div className="flex items-baseline justify-between px-4 py-2.5">
				<span className="text-sm font-medium text-ink">{card.title}</span>
				{card.rankedAt && (
					<span className="text-[11px] text-faint">{card.rankedAt.slice(11, 16)} 기준</span>
				)}
			</div>
			{card.movers.map((m) => (
				<div
					key={`${m.rank}-${m.symbol}`}
					className="flex items-center gap-3 border-t border-line px-4 py-2"
				>
					<span className="w-5 shrink-0 text-xs tabular-nums text-faint">{m.rank}</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm text-ink">{m.name}</div>
						<div className="text-[11px] text-faint">
							{m.symbol}
							{m.tradingAmount > 0 ? ` · ${amount(m.tradingAmount, m.currency)}` : ""}
						</div>
					</div>
					<div className="shrink-0 text-right">
						<div className="text-sm text-ink">{money(m.price, m.currency)}</div>
						<div className={`text-xs ${moveClass(m.changePct)}`}>
							{sign(m.changePct)}
							{m.changePct}%
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

// ── 뉴스 ────────────────────────────────────────────────────────────────

export function NewsCardView({ card }: { card: NewsCard }) {
	return (
		<div className="mt-2 overflow-hidden rounded-xl border border-line bg-inset">
			<div className="px-4 py-2.5 text-xs text-muted">
				&ldquo;{card.query}&rdquo; 뉴스 {card.items.length}건
			</div>
			{card.items.slice(0, 10).map((n) => (
				<a
					key={n.link || n.title}
					href={n.link}
					target="_blank"
					rel="noreferrer noopener"
					className="block border-t border-line px-4 py-2.5 transition hover:bg-hover"
				>
					<div className="text-sm text-ink">{n.title}</div>
					<div className="mt-0.5 line-clamp-2 text-xs text-muted">{n.summary}</div>
					{n.date && <div className="mt-1 text-[11px] text-faint">{n.date}</div>}
				</a>
			))}
		</div>
	);
}

// ── 재무 ────────────────────────────────────────────────────────────────

/** 억원 → 읽기 좋은 표기 (1조 이상은 조 단위) */
function eok(value: number | null): string {
	if (value === null) return "—";
	const abs = Math.abs(value);
	if (abs >= 10_000) return `${(value / 10_000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조`;
	return `${Math.round(value).toLocaleString("ko-KR")}억`;
}

export function FinancialsCardView({ card }: { card: FinancialsCard }) {
	const latest = card.periods[0];
	const pct = (v: number | null): string => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v}%`);

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-ink">{card.name}</div>
					<div className="text-xs text-faint">
						{card.symbol}
						{latest ? ` · ${latest.period.slice(0, 4)}.${latest.period.slice(4)} 누적` : ""}
					</div>
				</div>
				{card.consensus.covered ? (
					<div className="shrink-0 text-right">
						<div className="text-sm font-semibold text-ink">{card.consensus.rating}</div>
						<div className="text-[11px] text-faint">
							{card.consensus.analyst ?? ""}
							{card.consensus.estimatedAt ? ` · ${card.consensus.estimatedAt}` : ""}
						</div>
					</div>
				) : (
					<span className="shrink-0 text-[11px] text-faint">
						{card.consensus.error ? "컨센서스 조회 실패" : "컨센서스 미커버"}
					</span>
				)}
			</div>

			{latest && (
				<div className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
					<div>
						<div className="text-faint">매출</div>
						<div className="text-ink">{eok(latest.revenue)}</div>
						<div className={`text-[11px] ${moveClass(card.yoy?.revenue ?? 0)}`}>{pct(card.yoy?.revenue ?? null)}</div>
					</div>
					<div>
						<div className="text-faint">영업익</div>
						<div className="text-ink">{eok(latest.operatingProfit)}</div>
						<div className={`text-[11px] ${moveClass(card.yoy?.operatingProfit ?? 0)}`}>
							{pct(card.yoy?.operatingProfit ?? null)}
						</div>
					</div>
					<div>
						<div className="text-faint">순익</div>
						<div className="text-ink">{eok(latest.netIncome)}</div>
						<div className={`text-[11px] ${moveClass(card.yoy?.netIncome ?? 0)}`}>
							{pct(card.yoy?.netIncome ?? null)}
						</div>
					</div>
				</div>
			)}

			{latest && (
				<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
					<span>ROE {latest.roe ?? "—"}%</span>
					<span>부채비율 {latest.debtRatio ?? "—"}%</span>
					<span>EPS {latest.eps?.toLocaleString("ko-KR") ?? "—"}</span>
					<span>BPS {latest.bps?.toLocaleString("ko-KR") ?? "—"}</span>
				</div>
			)}

			{card.periods.length > 1 && (
				<div className="mt-3 border-t border-line pt-2">
					<div className="mb-1 text-[11px] text-faint">기간별 매출 / 영업익 (누적 기준)</div>
					<div className="space-y-0.5">
						{card.periods.slice(0, 6).map((p) => (
							<div key={p.period} className="flex justify-between text-[11px]">
								<span className="text-muted">
									{p.period.slice(0, 4)}.{p.period.slice(4)}
								</span>
								<span className="text-ink">
									{eok(p.revenue)} / {eok(p.operatingProfit)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			<p className="mt-2 text-[11px] text-faint">※ 분기 수치는 연단위 누적 기준입니다.</p>
		</div>
	);
}

// ── 자산 현황 ───────────────────────────────────────────────────────────

export function OverviewCardView({ card }: { card: OverviewCard }) {
	const assets = card.investKrw + card.cashKrw;

	return (
		<div className="mt-2 rounded-xl border border-line bg-inset p-4">
			<div className="text-xs text-muted">
				{card.from} ~ {card.to}
			</div>

			<div className="mt-3 grid grid-cols-2 gap-3">
				<div>
					<div className="text-[11px] text-faint">투자자산</div>
					<div className="text-base font-semibold text-ink">{won(assets)}</div>
					<div className={`text-[11px] ${moveClass(card.profitKrw)}`}>
						평가손익 {sign(card.profitKrw)}
						{won(card.profitKrw)}
					</div>
				</div>
				<div>
					<div className="text-[11px] text-faint">이번 기간 현금흐름</div>
					<div className={`text-base font-semibold ${card.surplus >= 0 ? "text-success" : "text-danger"}`}>
						{card.surplus >= 0 ? `잉여 ${won(card.surplus)}` : `적자 ${won(-card.surplus)}`}
					</div>
					<div className="text-[11px] text-faint">
						수입 {won(card.income)} / 지출 {won(card.expense)}
					</div>
				</div>
			</div>

			{card.investKrw === 0 && card.cashKrw === 0 && (
				<p className="mt-3 text-[11px] text-faint">
					증권 계정이 연결되지 않아 투자자산이 비어 있습니다. 설정 &gt; 증권 (KIS) 에서 키를 입력하세요.
				</p>
			)}
		</div>
	);
}
