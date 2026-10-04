/**
 * 총자산 추이 — 일별 스냅샷(평일 KST 16시)을 선으로. 차트 라이브러리 없이 SVG 하나.
 *
 * 계좌 구성이 바뀐 날(계좌 추가·0011 이전 행)은 점선으로 끊어 보여 준다 — 그 점프는 수익이 아니다.
 * 일부 계좌가 통째로 빠진 날은 속이 빈 점.
 */
import { useState } from "react";
import { compositionBreaks, daysBefore, type HistoryPoint } from "../lib/portfolio.ts";

const RANGES = [
	{ id: "1m", label: "1개월", days: 31 },
	{ id: "3m", label: "3개월", days: 92 },
	{ id: "1y", label: "1년", days: 366 },
] as const;

const W = 600;
const H = 160;
const PAD_Y = 12;

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 1억 이상은 "1.23억", 그 아래는 "4,567만" — 축 라벨용 */
function short(n: number): string {
	if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}억`;
	if (Math.abs(n) >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
	return Math.round(n).toLocaleString("ko-KR");
}

export function NetWorthChart({ points: all, today }: { points: HistoryPoint[]; today: string }) {
	const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("3m");
	const [hover, setHover] = useState<number | null>(null);

	const from = daysBefore(today, RANGES.find((r) => r.id === range)!.days);
	const points = all.filter((p) => p.date >= from);

	const header = (
		<div className="mb-2 flex items-center justify-between">
			<h2 className="text-sm font-medium text-muted">총자산 추이</h2>
			<div className="flex gap-1">
				{RANGES.map((r) => (
					<button
						key={r.id}
						onClick={() => setRange(r.id)}
						className={`rounded-md px-2 py-0.5 text-xs ${range === r.id ? "bg-accent-soft text-ink" : "text-muted"}`}
					>
						{r.label}
					</button>
				))}
			</div>
		</div>
	);

	if (points.length < 2) {
		return (
			<section>
				{header}
				<p className="rounded-xl border border-line bg-inset px-4 py-6 text-center text-xs text-muted">
					평일 16시(KST)에 하루 한 번 찍는 스냅샷이 2개 이상 쌓이면 추이가 보입니다.
				</p>
			</section>
		);
	}

	const values = points.map((p) => p.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || Math.max(1, max * 0.01);
	const x = (i: number): number => (i / (points.length - 1)) * W;
	const y = (v: number): number => PAD_Y + (1 - (v - min) / span) * (H - PAD_Y * 2);

	// 구성이 바뀐 점에서 선을 끊는다 — 구간마다 따로 그린다
	const breaks = compositionBreaks(points);
	const segments: Array<[number, number]> = [];
	let start = 0;
	for (const b of [...breaks, points.length]) {
		segments.push([start, b - 1]);
		start = b;
	}
	const path = (a: number, b: number): string =>
		points
			.slice(a, b + 1)
			.map((p, k) => `${k === 0 ? "M" : "L"}${x(a + k).toFixed(1)},${y(p.value).toFixed(1)}`)
			.join(" ");

	const first = points[0]!;
	const last = points[points.length - 1]!;
	const shown = hover !== null ? points[hover]! : last;
	const sameComposition = breaks.length === 0;
	const diff = last.value - first.value;

	return (
		<section>
			{header}
			<div className="rounded-xl border border-line bg-card px-3 pt-2 pb-1">
				<div className="flex items-baseline justify-between text-xs">
					<span className="text-muted">{shown.date}</span>
					<span className="text-ink">
						{won(shown.value)}
						{shown.partial && <span className="ml-1 text-danger">일부 계좌 누락</span>}
					</span>
				</div>
				<svg
					viewBox={`0 0 ${W} ${H}`}
					preserveAspectRatio="none"
					className="h-36 w-full touch-none"
					onPointerMove={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
						setHover(Math.max(0, Math.min(points.length - 1, i)));
					}}
					onPointerLeave={() => setHover(null)}
				>
					{breaks.map((b) => (
						<line key={b} x1={x(b)} x2={x(b)} y1={0} y2={H} stroke="var(--c-line)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
					))}
					{segments.map(([a, b]) =>
						a === b ? (
							<circle key={a} cx={x(a)} cy={y(points[a]!.value)} r={2.5} fill="var(--c-accent)" />
						) : (
							<path key={a} d={path(a, b)} fill="none" stroke="var(--c-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
						),
					)}
					{points.map((p, i) =>
						p.partial ? (
							<circle key={p.date} cx={x(i)} cy={y(p.value)} r={3} fill="var(--c-card)" stroke="var(--c-danger)" vectorEffect="non-scaling-stroke" />
						) : null,
					)}
					{hover !== null && (
						<line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--c-faint)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
					)}
				</svg>
				<div className="flex justify-between pb-1 text-[11px] text-faint">
					<span>
						최저 {short(min)} · 최고 {short(max)}
					</span>
					{sameComposition ? (
						<span className={diff > 0 ? "text-up" : diff < 0 ? "text-down" : ""}>
							기간 {diff > 0 ? "+" : ""}
							{short(diff)} ({diff > 0 ? "+" : ""}
							{((diff / first.value) * 100).toFixed(1)}%)
						</span>
					) : (
						<span>점선: 계좌 구성 변경 — 그 사이는 비교하지 않습니다</span>
					)}
				</div>
			</div>
			<p className="mt-1 text-[11px] text-faint">입출금도 변동에 들어갑니다 (수익률이 아닙니다).</p>
		</section>
	);
}
