/**
 * 총자산 추이 — 일별 스냅샷(평일 KST 16시)을 면적 그래프로. 차트 라이브러리 없이 SVG 하나.
 *
 * 계좌 구성이 바뀐 날(계좌 추가·0011 이전 행)은 선을 끊고 점선을 세운다 — 그 점프는 수익이 아니다.
 * 일부 계좌가 통째로 빠진 날은 속이 빈 빨간 점.
 * 기간 선택(1개월…1년)은 총자산 카드 위쪽(PortfolioPage)이 들고 있다.
 */
import { useId, useState, type PointerEvent } from "react";
import { compactWon, compositionBreaks, type HistoryPoint } from "../lib/portfolio.ts";

export const RANGES = [
	{ id: "1m", label: "1개월", days: 31 },
	{ id: "3m", label: "3개월", days: 92 },
	{ id: "6m", label: "6개월", days: 183 },
	{ id: "1y", label: "1년", days: 366 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

const W = 1000;
const H = 220;

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;
const sign = (n: number): string => (n > 0 ? "+" : n < 0 ? "−" : "");
const move = (n: number): string => (n > 0 ? "up" : n < 0 ? "down" : "flat");

/** "2026-10-08" → "10월 8일" (withYear 면 "2026년 10월 8일") */
function dayLabel(date: string, withYear = false): string {
	const [y, m, d] = date.split("-").map(Number);
	return `${withYear ? `${y}년 ` : ""}${m}월 ${d}일`;
}

export function NetWorthChart({ points, long }: { points: HistoryPoint[]; /** 1년 — 날짜에 연도를 붙인다 */ long: boolean }) {
	const gradient = useId();
	const [hover, setHover] = useState<number | null>(null);

	if (points.length < 2) {
		return <div className="chart-empty">평일 16시(KST)에 하루 한 번 찍는 스냅샷이 2개 이상 쌓이면 추이가 보입니다.</div>;
	}

	const values = points.map((p) => p.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pad = (max - min) * 0.12 || Math.max(1, max * 0.01);
	const lo = min - pad;
	const hi = max + pad;
	const xPct = (i: number): number => (i / (points.length - 1)) * 100;
	const yPct = (v: number): number => (1 - (v - lo) / (hi - lo)) * 100;
	const x = (i: number): number => (xPct(i) / 100) * W;
	const y = (v: number): number => (yPct(v) / 100) * H;

	// 구성이 바뀐 점에서 선을 끊는다 — 구간마다 따로 그린다
	const breaks = compositionBreaks(points);
	const segments: Array<[number, number]> = [];
	let start = 0;
	for (const b of [...breaks, points.length]) {
		segments.push([start, b - 1]);
		start = b;
	}
	const line = (a: number, b: number): string =>
		points
			.slice(a, b + 1)
			.map((p, k) => `${k === 0 ? "M" : "L"}${x(a + k).toFixed(1)},${y(p.value).toFixed(1)}`)
			.join("");

	const first = points[0]!;
	const last = points[points.length - 1]!;
	const diff = last.value - first.value;
	const sameComposition = breaks.length === 0;

	function onPointer(e: PointerEvent<HTMLDivElement>): void {
		const r = e.currentTarget.getBoundingClientRect();
		const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
		setHover(Math.max(0, Math.min(points.length - 1, i)));
	}

	const h = hover !== null ? points[hover]! : null;
	const mid = points[Math.floor((points.length - 1) / 2)]!;

	return (
		<>
			<div
				className="chart"
				role="img"
				aria-label={`총자산 추이 — ${dayLabel(first.date)} ${won(first.value)}에서 ${dayLabel(last.date)} ${won(last.value)}`}
				onPointerMove={onPointer}
				onPointerDown={onPointer}
				onPointerLeave={() => setHover(null)}
			>
				{[0, 50, 100].map((top, i) => (
					<div key={top} className="gl" style={{ top: `${top}%` }}>
						<span>{compactWon(hi - (hi - lo) * (i / 2))}</span>
					</div>
				))}
				<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
					<defs>
						<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
							<stop offset="0" stopColor="var(--accent)" stopOpacity=".18" />
							<stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
						</linearGradient>
					</defs>
					{breaks.map((b) => (
						<line key={b} x1={x(b)} x2={x(b)} y1={0} y2={H} stroke="var(--border)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
					))}
					{segments.map(([a, b]) =>
						a === b ? null : (
							<g key={a}>
								<path d={`${line(a, b)}L${x(b).toFixed(1)},${H}L${x(a).toFixed(1)},${H}Z`} fill={`url(#${gradient})`} />
								<path d={line(a, b)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
							</g>
						),
					)}
				</svg>
				{/* 점은 HTML 로 — SVG 가 가로로 늘어나도 동그랗게 */}
				{segments.map(([a, b]) => (a === b ? <span key={`s${a}`} className="mark solo" style={{ left: `${xPct(a)}%`, top: `${yPct(points[a]!.value)}%` }} /> : null))}
				{points.map((p, i) => (p.partial ? <span key={p.date} className="mark" style={{ left: `${xPct(i)}%`, top: `${yPct(p.value)}%` }} title="일부 계좌 누락" /> : null))}
				{h && hover !== null && (
					<>
						<div className="vline" style={{ left: `${xPct(hover)}%` }} />
						<div className="pt" style={{ left: `${xPct(hover)}%`, top: `${yPct(h.value)}%` }} />
						<div className="tip" style={{ left: `${Math.min(Math.max(xPct(hover), 12), 88)}%`, top: `${yPct(h.value)}%` }}>
							{dayLabel(h.date, long)}
							<br />
							<b>{won(h.value)}</b>
							{h.partial && <span className="block text-[11px] opacity-80">일부 계좌 누락</span>}
						</div>
					</>
				)}
			</div>
			<div className="chart-x">
				<span>{dayLabel(first.date, long)}</span>
				<span>{dayLabel(mid.date)}</span>
				<span>{dayLabel(last.date)}</span>
			</div>
			<div className="chart-foot">
				{sameComposition ? (
					<>
						기간 변동{" "}
						<b className={move(diff)}>
							{sign(diff)}
							{won(Math.abs(diff))} ({sign(diff)}
							{Math.abs((diff / first.value) * 100).toFixed(2)}%)
						</b>
					</>
				) : (
					<span>점선: 계좌 구성 변경 — 그 사이는 비교하지 않습니다</span>
				)}
				<span className="r">입출금 포함 · 평일 16시 스냅샷</span>
			</div>
		</>
	);
}
