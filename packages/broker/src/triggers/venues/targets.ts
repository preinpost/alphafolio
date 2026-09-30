/**
 * 주문 대상 계좌 (PLAN §40 2단계) — 켤 때 고정하고, 실행할 때 지금 키의 계좌와 같은지 다시 본다.
 *
 * 계좌번호는 트리거에 남기지 않는다: 토스는 accountSeq(계좌 식별 정수), KIS 는 계좌번호 지문(sha256 앞 12자리),
 * Binance 는 API 키 지문(sha256 앞 12자리 — 테스트넷이면 앞에 표시). 사용자가 설정에서 다른 계좌 키로 바꾸면 지문이 달라져 주문하지 않는다.
 */
import { createHash } from "node:crypto";
import { accountInfo, freeBalances, symbolRules, type BinanceCreds } from "../../binance/trade.ts";
import { kisOrderExchange, kisSellable } from "../../kis/orders.ts";
import type { BrokerAccess } from "../../portfolio.ts";
import { isDomesticSymbol } from "../../quote.ts";
import { defaultAccountSeq, tossAccounts } from "../../toss/api.ts";
import { sellableQuantity } from "../../toss/orders.ts";
import type { OrderTarget } from "../types.ts";
import { kisVenue } from "./kis.ts";
import { binanceSellable, binanceVenue } from "./binance.ts";
import { tossVenue } from "./toss.ts";
import type { ExecVenue } from "./types.ts";

const BROKER_LABEL = { kis: "한국투자", toss: "토스", binance: "Binance" } as const;

function binanceCreds(access: BrokerAccess): BinanceCreds {
	const make = access.binance;
	if (!make) throw new Error("Binance 연결이 없습니다 — 설정 → 코인 (Binance)");
	return make();
}

const fingerprint = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

function ctxOf<K extends "kis" | "toss">(access: BrokerAccess, broker: K): ReturnType<NonNullable<BrokerAccess[K]>> {
	const make = access[broker];
	if (!make) throw new Error(`${BROKER_LABEL[broker]} 연결이 없습니다 — 설정 → 연결 → 증권`);
	return make() as ReturnType<NonNullable<BrokerAccess[K]>>;
}

/** 지금 키의 주문 계좌 */
export async function orderTarget(access: BrokerAccess, broker: OrderTarget["broker"]): Promise<OrderTarget> {
	if (broker === "binance") {
		const c = binanceCreds(access);
		const { canTrade } = await accountInfo(c);
		if (!canTrade) throw new Error("Binance API 키에 현물 거래 권한이 없습니다 — Binance 에서 키의 Spot Trading 을 켜 주세요");
		// 테스트넷 키와 실전 키가 같은 지문이 되지 않게
		const fp = fingerprint(`${c.testnet ? "testnet:" : ""}${c.key}`);
		return { broker, account: fp, accountLabel: `Binance 현물${c.testnet ? " 테스트넷" : ""} (키 ${fp.slice(0, 6)})` };
	}
	if (broker === "kis") {
		const ctx = ctxOf(access, "kis");
		const { cano, prdtCd = "01" } = ctx.creds;
		if (!cano) throw new Error("한국투자 계좌번호가 없습니다 — 설정 → 증권 (KIS) → 계좌번호");
		if (ctx.creds.env === "paper") throw new Error("모의투자 키로는 자동 매매를 할 수 없습니다 (주문 경로가 실전 TR 만 있다)");
		return {
			broker,
			account: createHash("sha256").update(`${cano}-${prdtCd}`).digest("hex").slice(0, 12),
			accountLabel: `한국투자 ****${cano.slice(-2)}-${prdtCd}`,
		};
	}
	const ctx = ctxOf(access, "toss");
	const seq = await defaultAccountSeq(ctx);
	const no = (await tossAccounts(ctx)).find((a) => a.accountSeq === seq)?.accountNo ?? "";
	return { broker, account: String(seq), accountLabel: `토스 ${no ? `****${no.replace(/\D/g, "").slice(-4)}` : `계좌 ${seq}`}` };
}

async function same(access: BrokerAccess, target: OrderTarget): Promise<void> {
	const now = await orderTarget(access, target.broker);
	if (now.account !== target.account) throw new Error(`주문 계좌가 켤 때(${target.accountLabel})와 다릅니다 — 지금 ${now.accountLabel}. 감시를 새로 만들어 주세요`);
}

/** 켤 때의 계좌가 맞으면 체결 어댑터 */
export async function targetVenue(access: BrokerAccess, target: OrderTarget, symbol: string): Promise<ExecVenue> {
	await same(access, target);
	if (target.broker === "binance") return binanceVenue(binanceCreds(access), symbol);
	if (target.broker === "kis") return kisVenue(ctxOf(access, "kis"), symbol);
	return tossVenue(ctxOf(access, "toss"), symbol, { accountSeq: Number(target.account) });
}

/** 매도 가능 수량 */
export async function targetSellable(access: BrokerAccess, target: OrderTarget, symbol: string): Promise<number> {
	await same(access, target);
	if (target.broker === "binance") {
		const c = binanceCreds(access);
		const rules = await symbolRules(symbol, c);
		if (!rules) throw new Error(`Binance 에 없는 종목입니다: ${symbol}`);
		return binanceSellable(await freeBalances(c), rules);
	}
	const market = isDomesticSymbol(symbol) ? "KR" : "US";
	if (target.broker === "kis") {
		const ctx = ctxOf(access, "kis");
		return kisSellable(ctx, market, symbol, market === "US" ? await kisOrderExchange(ctx, symbol) : undefined);
	}
	const r = await sellableQuantity(ctxOf(access, "toss"), Number(target.account), symbol);
	return Math.floor(Number(r.sellableQuantity) || 0);
}
