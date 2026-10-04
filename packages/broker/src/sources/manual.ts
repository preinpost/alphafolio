/**
 * 직접 입력 자산 — API 가 없는 곳(은행 예금·연금·부동산·다른 거래소)을 사용자가 적어 둔 금액.
 *
 * 저장은 서버(D1 manual_assets)가 하고, 여기는 접근자(`access.manual`)로 목록만 받는다.
 * 하나도 없으면 null — 계좌 카드를 만들지 않는다.
 */
import { emptyResult, type AssetSource } from "./types.ts";

export const manualSource: AssetSource = {
	id: "manual",
	label: "직접 입력",
	connect(access) {
		const load = access.manual;
		if (!load) return null;
		return {
			run: async () => {
				const manual = await load();
				return manual.length > 0 ? { ...emptyResult(), manual } : null;
			},
		};
	},
};
