/**
 * 자산 출처(계좌) 어댑터 — 포트폴리오 집계가 출처를 모르고도 합칠 수 있게 하는 계약.
 *
 * 새 계좌를 붙일 때는 이 인터페이스를 구현한 파일 하나를 만들고 `sources/index.ts` 의 목록에 넣는다.
 * 환율 적용·원화 환산·합계·배분은 집계(portfolio.ts)가 한 곳에서 한다 — 출처는 원래 통화 그대로 돌려준다.
 */
import type { CryptoHolding, Holding, ManualAsset, SourceId } from "../normalize.ts";
import type { BrokerAccess } from "../portfolio.ts";

export interface SourceResult {
	/** 주식 — USD 종목의 valueKrw 는 집계가 하나로 고른 환율로 다시 계산한다 */
	holdings: Holding[];
	/** 코인 — valueKrw 는 집계가 채운다 */
	crypto: CryptoHolding[];
	/** 직접 입력 자산 — 원래 통화 그대로 */
	manual: ManualAsset[];
	cashKrw: number;
	cashUsd: number;
	/** 이 출처가 아는 USD/KRW (모르면 0) — 집계가 우선순위대로 하나를 고른다 */
	usdKrw: number;
	/** 일부 구간만 실패한 것 — 나머지는 보여 준다 */
	warnings: string[];
}

/**
 * - `null`: 미설정 (키 없음) — 경고하지 않는다 (안 쓰는 계좌를 매번 알릴 이유가 없다)
 * - `{ skipped }`: 연결은 됐지만 합계에서 뺀다 (예: 테스트넷 모의 잔고) — 카드에 사유를 보여 준다
 * - `{ run }`: 조회. run 이 null 을 돌려주면 "알고 보니 쓸 게 없음" — 미설정처럼 카드도 만들지 않는다
 *   (직접 입력 자산이 하나도 없는 사용자에게 빈 카드를 보이지 않고, 스냅샷 계좌 구성도 바뀌지 않게)
 */
export type SourceConnection = null | { skipped: string } | { run: () => Promise<SourceResult | null> };

export interface AssetSource {
	id: SourceId;
	label: string;
	/** 자격증명 접근자가 throw 하면 집계가 미설정으로 본다 */
	connect(access: BrokerAccess): SourceConnection;
}

export const emptyResult = (): SourceResult => ({ holdings: [], crypto: [], manual: [], cashKrw: 0, cashUsd: 0, usdKrw: 0, warnings: [] });

export function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
