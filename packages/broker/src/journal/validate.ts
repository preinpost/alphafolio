/**
 * 매매일지 입력 검증 (순수) — 화면(REST)과 챗(journal_*)이 같은 규칙을 쓴다.
 * 잘못된 입력은 JournalValidationError — 서버는 400, 도구는 모델이 읽고 고칠 오류로 넘긴다.
 */
import { JOURNAL_BROKERS, JOURNAL_EMOTIONS, type JournalBroker, type JournalEmotion, type JournalNotes, type JournalSide, type JournalTrade } from "./types.ts";

export class JournalValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JournalValidationError";
	}
}

export const MAX_THESIS = 1000;
export const MAX_REVIEW = 2000;
export const MAX_TAGS = 10;
export const MAX_TAG = 20;
const MAX_NUMBER = 1e13;
const SYMBOL_RE = /^[A-Za-z0-9._-]{1,24}$/;
const CURRENCY_RE = /^[A-Z]{3,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KST = 9 * 3_600_000;

/** epoch ms → KST 날짜 */
export function kstDate(at: number): string {
	return new Date(at + KST).toISOString().slice(0, 10);
}

/**
 * 날짜만 아는 기록의 시각 — 오늘이면 지금, 지난 날이면 그날 KST 정오 (같은 날 기록끼리 순서를 흐트러뜨리지 않게).
 * 미래 날짜는 받지 않는다.
 */
export function atOfDate(date: string, now: number): number {
	if (!DATE_RE.test(date)) throw new JournalValidationError("date 는 YYYY-MM-DD 형식이어야 합니다");
	const noon = Date.parse(`${date}T12:00:00+09:00`);
	if (!Number.isFinite(noon) || kstDate(noon) !== date) throw new JournalValidationError(`실제로 있는 날짜가 아닙니다: ${date}`);
	const today = kstDate(now);
	if (date > today) throw new JournalValidationError("미래 날짜의 매매는 기록할 수 없습니다");
	return date === today ? now : noon;
}

/** 통화 기본값 — 6자리 국내 코드는 원, …USDT 같은 코인 마켓은 호가 자산, 나머지(미국 주식)는 달러 */
export function defaultCurrency(symbol: string): string {
	const s = symbol.toUpperCase();
	if (/^[0-9][0-9A-Z]{5}$/.test(s)) return "KRW";
	const quote = /(USDT|USDC|FDUSD)$/.exec(s);
	if (quote && s.length > quote[1]!.length) return quote[1]!;
	return "USD";
}

const has = (body: Record<string, unknown>, k: string): boolean => body[k] !== undefined;

function text(v: unknown, field: string, max: number): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== "string") throw new JournalValidationError(`${field} 는 문자열이어야 합니다`);
	const t = v.trim();
	if (t.length > max) throw new JournalValidationError(`${field} 는 ${max}자 이하로 써 주세요`);
	return t || null;
}

/** 양수 또는 null (null·빈 값 = 지움) */
function price(v: unknown, field: string): number | null {
	if (v === null || v === undefined || v === "") return null;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_NUMBER) throw new JournalValidationError(`${field} 는 0보다 큰 숫자여야 합니다`);
	return v;
}

/** "#손절, 뉴스" · ["손절", "#뉴스"] → ["손절", "뉴스"] — 앞의 #·공백을 떼고 중복을 뺀다 */
export function normalizeTags(v: unknown): string[] {
	if (v === null || v === undefined) return [];
	const raw = typeof v === "string" ? v.split(/[,\s]+/) : Array.isArray(v) ? v : null;
	if (!raw) throw new JournalValidationError("tags 는 문자열 배열이어야 합니다");
	const out: string[] = [];
	for (const t of raw) {
		if (typeof t !== "string") throw new JournalValidationError("tags 는 문자열 배열이어야 합니다");
		const tag = t.trim().replace(/^#+/, "").trim();
		if (!tag) continue;
		if (tag.length > MAX_TAG) throw new JournalValidationError(`태그는 ${MAX_TAG}자 이하로 써 주세요: ${tag}`);
		if (!out.includes(tag)) out.push(tag);
	}
	if (out.length > MAX_TAGS) throw new JournalValidationError(`태그는 ${MAX_TAGS}개까지입니다`);
	return out;
}

function emotion(v: unknown): JournalEmotion | null {
	if (v === null || v === undefined || v === "") return null;
	if (!(JOURNAL_EMOTIONS as readonly unknown[]).includes(v)) throw new JournalValidationError(`emotion 은 ${JOURNAL_EMOTIONS.join(", ")} 중 하나입니다`);
	return v as JournalEmotion;
}

/** 사람이 쓰는 칸 — partial 이면 온 필드만 */
export function parseJournalNotes(body: Record<string, unknown>, partial: true): Partial<JournalNotes>;
export function parseJournalNotes(body: Record<string, unknown>, partial: false): JournalNotes;
export function parseJournalNotes(body: Record<string, unknown>, partial: boolean): Partial<JournalNotes> {
	const out: Partial<JournalNotes> = {};
	if (!partial || has(body, "thesis")) out.thesis = text(body.thesis, "thesis(근거)", MAX_THESIS);
	if (!partial || has(body, "targetPrice")) out.targetPrice = price(body.targetPrice, "targetPrice(목표가)");
	if (!partial || has(body, "stopPrice")) out.stopPrice = price(body.stopPrice, "stopPrice(손절가)");
	if (!partial || has(body, "tags")) out.tags = normalizeTags(body.tags);
	if (!partial || has(body, "emotion")) out.emotion = emotion(body.emotion);
	if (!partial || has(body, "review")) out.review = text(body.review, "review(회고)", MAX_REVIEW);
	return out;
}

export const TRADE_FIELDS = ["at", "date", "broker", "symbol", "name", "side", "quantity", "price", "currency", "fee"] as const;

/**
 * 매매 칸 — 직접 기록. 시각은 date(YYYY-MM-DD) 로 받는다. partial 이면 온 필드만.
 * 통화를 비우면 심볼로 정한다 (새 기록만 — 고칠 때 심볼만 바꿔도 통화는 그대로).
 */
export function parseJournalTrade(body: Record<string, unknown>, partial: true, now: number): Partial<JournalTrade>;
export function parseJournalTrade(body: Record<string, unknown>, partial: false, now: number): JournalTrade;
export function parseJournalTrade(body: Record<string, unknown>, partial: boolean, now: number): Partial<JournalTrade> {
	const out: Partial<JournalTrade> = {};
	if (!partial || has(body, "date")) out.at = atOfDate(typeof body.date === "string" ? body.date : kstDate(now), now);
	if (!partial || has(body, "symbol")) {
		const s = typeof body.symbol === "string" ? body.symbol.trim() : "";
		if (!SYMBOL_RE.test(s)) throw new JournalValidationError("symbol 은 종목코드·티커입니다 (예: 005930, AAPL, BTCUSDT)");
		out.symbol = s.toUpperCase();
	}
	if (!partial || has(body, "side")) {
		if (body.side !== "BUY" && body.side !== "SELL") throw new JournalValidationError("side 는 BUY(매수) 또는 SELL(매도)입니다");
		out.side = body.side as JournalSide;
	}
	if (!partial || has(body, "quantity")) {
		const q = body.quantity;
		if (typeof q !== "number" || !Number.isFinite(q) || q <= 0 || q > MAX_NUMBER) throw new JournalValidationError("quantity(수량)는 0보다 큰 숫자여야 합니다");
		out.quantity = q;
	}
	if (!partial || has(body, "price")) out.price = price(body.price, "price(체결가)");
	if (!partial || has(body, "broker")) {
		const b = body.broker === undefined || body.broker === null || body.broker === "" ? "other" : body.broker;
		if (!(JOURNAL_BROKERS as readonly unknown[]).includes(b)) throw new JournalValidationError(`broker 는 ${JOURNAL_BROKERS.join(", ")} 중 하나입니다`);
		out.broker = b as JournalBroker;
	}
	if (!partial || has(body, "name")) out.name = text(body.name, "name(종목명)", 60);
	if (!partial || has(body, "currency")) {
		const c = typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : null;
		if (c !== null && !CURRENCY_RE.test(c)) throw new JournalValidationError("currency 는 KRW·USD·USDT 같은 통화 코드입니다");
		if (c !== null) out.currency = c;
		else if (!partial) out.currency = defaultCurrency(out.symbol!);
	}
	if (!partial || has(body, "fee")) {
		const f = body.fee;
		if (f === null || f === undefined || f === "") out.fee = null;
		else if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > MAX_NUMBER) throw new JournalValidationError("fee(수수료)는 0 이상의 숫자여야 합니다");
		else out.fee = f;
	}
	return out;
}

/** 패치에 매매 칸이 있나 — 직접 기록이 아니면 막는다 */
export function touchesTrade(body: Record<string, unknown>): boolean {
	return TRADE_FIELDS.some((k) => body[k] !== undefined);
}
