import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { changeSince, compositionOf, daysBefore, historySeries, kstDate } from "../../lib/portfolio.ts";
import { toast } from "../../lib/toast.ts";
import { RANGES, type RangeId } from "../NetWorthChart.tsx";
import { stamp } from "./format.ts";
import { useHoldingsView } from "./useHoldingsView.ts";

/** 투자 화면 상태 — 잔고·미체결·추이 조회와 계좌 필터·직접 입력 편집 */
export function usePortfolioPage() {
	/** 보유 목록 계좌 필터 — null 이면 전체 */
	const [only, setOnly] = useState<string | null>(null);
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

	const holdingsView = useHoldingsView(p, only, total);
	const canAddManual = (!only || only === "manual") && (holdingsView.kind === "all" || holdingsView.kind === "manual");

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

	return {
		only,
		setOnly,
		range,
		setRange,
		editing,
		setEditing,
		portfolio,
		openOrders,
		cancel,
		history,
		ranged,
		p,
		total,
		daily,
		monthly,
		holdingsView,
		canAddManual,
		refresh,
		sub,
	};
}
