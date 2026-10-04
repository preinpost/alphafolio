/**
 * 포트폴리오에 잔고를 보태는 계좌 목록 — 순서가 곧 화면의 계좌 카드 순서다.
 * 새 계좌: `types.ts` 의 AssetSource 를 구현해 여기에 넣는다.
 */
import { binanceSource } from "./binance.ts";
import { kisSource } from "./kis.ts";
import { manualSource } from "./manual.ts";
import { tossSource } from "./toss.ts";
import type { AssetSource } from "./types.ts";

export const ASSET_SOURCES: readonly AssetSource[] = [kisSource, tossSource, binanceSource, manualSource];

export type { AssetSource, SourceConnection, SourceResult } from "./types.ts";
export { STABLES, clearCoinCostCache, coinCostBasis, equityHolding, mergeCrypto, tokenHolding, usdPrice, walletLabel, withCost } from "./binance.ts";
export { clearPublicFxCache, publicUsdKrw } from "./fx.ts";
