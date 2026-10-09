/**
 * 매매일지 도구 (PLAN §42) — journal_add · journal_update · journal_list.
 *
 * 일지는 사용자 개인 것이고 돈을 움직이지 않아 확인 카드 없이 바로 쓴다 (가계부와 같다).
 * 지우기는 도구가 없다 — 일지 탭에서만 (외부 텍스트에 심긴 지시로 기록이 사라지지 않게).
 * 증권사 숫자(수량·체결가)는 직접 기록한 것만 고칠 수 있다 — 저장소가 막는다.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { journalStats } from "./stats.ts";
import { JOURNAL_EMOTIONS, type JournalEntry, type JournalFilter, type JournalNotes, type JournalSyncResult, type JournalTrade } from "./types.ts";
import { kstDate, parseJournalNotes, parseJournalTrade } from "./validate.ts";

export interface JournalToolDeps {
	list: (filter: JournalFilter) => Promise<JournalEntry[]>;
	/** 직접 기록 (source=manual) */
	add: (trade: JournalTrade, notes: JournalNotes) => Promise<JournalEntry>;
	/** 사람이 쓰는 칸만 */
	update: (id: string, notes: Partial<JournalNotes>) => Promise<JournalEntry>;
	/** 증권사 체결 내역 가져오기 */
	sync: () => Promise<JournalSyncResult>;
	now?: () => number;
}

/** 목록에 싣는 최대 건수 — 나머지는 일지 탭에서 */
const LIST_PREVIEW = 30;

export function journalMoney(v: number, currency: string): string {
	if (currency === "KRW") return `${Math.round(v).toLocaleString("en-US")}원`;
	if (currency === "USD") return `$${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
	return `${Number(v.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 8 })} ${currency}`;
}

const qtyText = (q: number): string => Number(q.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 8 });
const BROKER = { kis: "한국투자", toss: "토스", binance: "Binance", binance_stock: "Binance 주식", other: "기타" } as const;
const SOURCE = { manual: "직접 기록", order: "챗 주문", auto: "자동 매매", import: "계좌 체결" } as const;
const STATUS = { pending: " (체결 확인 전)", filled: "", canceled: " (체결 없이 끝남)" } as const;

/** 목록 한 줄 — 모델이 id 로 고칠 수 있게 id 를 앞에 */
export function entryLine(e: JournalEntry): string {
	const what = e.name ? `${e.name}(${e.symbol})` : e.symbol;
	const qty = e.quantity > 0 ? `${qtyText(e.quantity)}${e.broker === "binance" ? "" : "주"}` : "금액 주문";
	const price = e.price !== null ? ` @ ${journalMoney(e.price, e.currency)}` : "";
	const notes = [
		e.thesis ? `근거: ${e.thesis}` : "근거 없음",
		e.targetPrice !== null ? `목표 ${journalMoney(e.targetPrice, e.currency)}` : "",
		e.stopPrice !== null ? `손절 ${journalMoney(e.stopPrice, e.currency)}` : "",
		e.tags.length ? e.tags.map((t) => `#${t}`).join(" ") : "",
		e.emotion ? `감정 ${e.emotion}` : "",
		e.review ? `회고: ${e.review}` : "",
		e.context?.trigger ? `감시 "${e.context.trigger}"` : "",
	].filter(Boolean);
	return `- [${e.id}] ${e.date} ${what} ${e.side === "BUY" ? "매수" : "매도"} ${qty}${price}${STATUS[e.status]} · ${BROKER[e.broker]} · ${SOURCE[e.source]} | ${notes.join(" · ")}`;
}

const PERIODS = ["today", "last_7d", "last_30d", "last_90d", "this_month", "this_year", "all"] as const;
type Period = (typeof PERIODS)[number];

/** 기간 → [from, to) epoch ms (KST 날짜 경계) */
export function periodRange(period: Period, now: number): { from?: number; to?: number } {
	const today = kstDate(now);
	const startOf = (date: string): number => Date.parse(`${date}T00:00:00+09:00`);
	const daysAgo = (n: number): number => startOf(kstDate(now - n * 86_400_000));
	switch (period) {
		case "today":
			return { from: startOf(today) };
		case "last_7d":
			return { from: daysAgo(6) };
		case "last_30d":
			return { from: daysAgo(29) };
		case "last_90d":
			return { from: daysAgo(89) };
		case "this_month":
			return { from: startOf(`${today.slice(0, 7)}-01`) };
		case "this_year":
			return { from: startOf(`${today.slice(0, 4)}-01-01`) };
		case "all":
			return {};
	}
}

const EMOTION = Type.Union(
	[Type.Literal("차분"), Type.Literal("확신"), Type.Literal("불안"), Type.Literal("조급"), Type.Literal("욕심"), Type.Literal("충동")],
	{ description: `매매할 때의 감정 — ${JOURNAL_EMOTIONS.join("·")} 중 하나. 사용자가 말했을 때만` },
);
const TAGS = Type.Array(Type.String(), { description: "태그 (예: [\"돌파\", \"실적\"]) — 사용자가 말했을 때만. # 는 빼고" });

export function createJournalTools(deps: JournalToolDeps) {
	const now = deps.now ?? Date.now;

	const journalAdd = defineTool({
		name: "journal_add",
		label: "매매일지 기록",
		description:
			"앱 밖에서 한 매매(다른 증권사·거래소·MTS)를 매매일지에 직접 기록한다. " +
			"앱에서 낸 주문·자동 매매는 자동으로 일지에 남고, 연결된 계좌(토스·한국투자·Binance)의 체결은 journal_list refresh 로 가져온다 — 그런 매매를 이 툴로 또 기록하지 않는다. " +
			"날짜는 daysAgo(오늘=0, 어제=1), 절대 날짜를 말했을 때만 date. 근거·목표가·손절가·태그·감정은 사용자가 말한 것만 넣는다.",
		parameters: Type.Object({
			symbol: Type.String({ description: "종목코드·티커 (005930, AAPL, BTCUSDT)" }),
			name: Type.Optional(Type.String({ description: "종목명 (예: 삼성전자)" })),
			side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")], { description: "BUY=매수, SELL=매도" }),
			quantity: Type.Number({ minimum: 0, description: "체결 수량 (주·코인 수량)" }),
			price: Type.Optional(Type.Number({ minimum: 0, description: "평균 체결가 (모르면 비운다)" })),
			currency: Type.Optional(Type.String({ description: "KRW·USD·USDT — 비우면 종목으로 정한다" })),
			broker: Type.Optional(
				Type.Union([Type.Literal("kis"), Type.Literal("toss"), Type.Literal("binance"), Type.Literal("binance_stock"), Type.Literal("other")], {
					description: "어디서 매매했나 (모르면 other)",
				}),
			),
			fee: Type.Optional(Type.Number({ minimum: 0, description: "수수료+세금 (매매 통화)" })),
			date: Type.Optional(Type.String({ description: "매매 날짜 YYYY-MM-DD (절대 날짜를 말했을 때만)" })),
			daysAgo: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650, description: "KST 기준 N일 전 (오늘=0)" })),
			thesis: Type.Optional(Type.String({ description: "매매 근거 — 사용자의 말 그대로 요약" })),
			targetPrice: Type.Optional(Type.Number({ minimum: 0, description: "목표가" })),
			stopPrice: Type.Optional(Type.Number({ minimum: 0, description: "손절가" })),
			tags: Type.Optional(TAGS),
			emotion: Type.Optional(EMOTION),
		}),
		execute: async (_id, params) => {
			const t = now();
			const date = params.daysAgo !== undefined ? kstDate(t - params.daysAgo * 86_400_000) : params.date;
			const body = { ...params, ...(date ? { date } : {}) } as Record<string, unknown>;
			const entry = await deps.add(parseJournalTrade(body, false, t), parseJournalNotes(body, false));
			return {
				content: [{ type: "text" as const, text: `매매일지에 기록했습니다\n${entryLine(entry)}` }],
				details: { kind: "journal-entry" as const, entry },
			};
		},
	});

	const journalUpdate = defineTool({
		name: "journal_update",
		label: "매매일지 메모",
		description:
			"매매일지 한 줄에 근거·목표가·손절가·태그·감정·회고를 쓰거나 고친다. id 는 journal_list 결과의 [id]. " +
			"보낸 칸만 바뀐다. 지우려면 글은 \"\", 가격은 0. 수량·체결가는 이 툴로 고치지 않는다 (일지 탭에서 — 직접 기록만). " +
			"회고(review)는 사용자가 돌아보며 한 말을 정리해 넣는다 — 사용자가 말하지 않은 평가를 지어 넣지 않는다.",
		parameters: Type.Object({
			id: Type.String({ description: "일지 id (journal_list 의 [id])" }),
			thesis: Type.Optional(Type.String({ description: "매매 근거" })),
			targetPrice: Type.Optional(Type.Number({ minimum: 0, description: "목표가 (0 = 지움)" })),
			stopPrice: Type.Optional(Type.Number({ minimum: 0, description: "손절가 (0 = 지움)" })),
			tags: Type.Optional(TAGS),
			emotion: Type.Optional(Type.Union([EMOTION, Type.Literal("")], { description: `${JOURNAL_EMOTIONS.join("·")} 중 하나, "" = 지움` })),
			review: Type.Optional(Type.String({ description: "사후 회고 — 결과와 배운 점" })),
		}),
		execute: async (_id, params) => {
			const { id, ...rest } = params;
			const body: Record<string, unknown> = { ...rest };
			for (const k of ["targetPrice", "stopPrice"] as const) if (body[k] === 0) body[k] = null;
			const notes = parseJournalNotes(body, true);
			if (Object.keys(notes).length === 0) throw new Error("바꿀 칸이 없습니다 — thesis·targetPrice·stopPrice·tags·emotion·review 중 하나를 넣으세요");
			const entry = await deps.update(id, notes);
			return {
				content: [{ type: "text" as const, text: `매매일지를 고쳤습니다\n${entryLine(entry)}` }],
				details: { kind: "journal-entry" as const, entry },
			};
		},
	});

	const journalList = defineTool({
		name: "journal_list",
		label: "매매일지",
		description:
			"매매일지를 기간별로 보고 요약한다 (매수·매도 수, 근거·회고를 쓴 비율, 손절가를 정한 매수, 자주 쓴 태그·감정). " +
			"'이번 달 매매 돌아봐 줘', '근거 안 쓴 매매 있어?', '삼성전자 매매 기록' 같은 질문에 쓴다. " +
			"refresh=true 면 연결된 계좌(토스·한국투자·Binance)의 체결 내역을 먼저 가져온다 — 최근 매매가 안 보이거나 '체결 확인 전' 이면 켠다. " +
			"⚠️ 날짜를 계산하지 말고 period 를 쓴다 (기본 last_30d). 손익은 이 툴이 계산하지 않는다 — 평가손익은 portfolio_holdings.",
		parameters: Type.Object({
			period: Type.Optional(
				Type.Union(
					[
						Type.Literal("today"),
						Type.Literal("last_7d"),
						Type.Literal("last_30d"),
						Type.Literal("last_90d"),
						Type.Literal("this_month"),
						Type.Literal("this_year"),
						Type.Literal("all"),
					],
					{ description: "기간 (기본 last_30d)" },
				),
			),
			symbol: Type.Optional(Type.String({ description: "이 종목만 (종목코드·티커)" })),
			side: Type.Optional(Type.Union([Type.Literal("BUY"), Type.Literal("SELL")], { description: "매수·매도만" })),
			missingNotes: Type.Optional(Type.Boolean({ description: "근거를 아직 안 쓴 것만" })),
			refresh: Type.Optional(Type.Boolean({ description: "증권사 체결 내역을 먼저 가져온다" })),
		}),
		execute: async (_id, params) => {
			const notes: string[] = [];
			if (params.refresh) {
				const r = await deps.sync();
				const failed = r.sources.filter((s) => s.error).map((s) => `${s.label}(${s.error})`);
				notes.push(
					r.skipped
						? "가져오기: 방금 가져왔습니다 (1분 안에 다시 부르지 않는다)."
						: r.sources.length === 0
							? "가져오기: 연결된 계좌가 없습니다 (설정 → 연결)."
							: `가져오기: 새 기록 ${r.added}건 · 체결 반영 ${r.updated}건${failed.length ? ` · 실패 ${failed.join(", ")}` : ""}`,
					...r.warnings,
				);
			}
			const period = (params.period ?? "last_30d") as Period;
			const filter: JournalFilter = {
				...periodRange(period, now()),
				...(params.symbol ? { symbol: params.symbol.trim().toUpperCase() } : {}),
				...(params.side ? { side: params.side } : {}),
				...(params.missingNotes ? { missingNotes: true } : {}),
				limit: 500,
			};
			const entries = await deps.list(filter);
			const s = journalStats(entries);
			const head = [`매매일지 (${period}) — 체결 ${s.total}건: 매수 ${s.buys} · 매도 ${s.sells}${s.pending ? ` · 체결 확인 전 ${s.pending}` : ""}${s.canceled ? ` · 체결 없이 끝난 주문 ${s.canceled}` : ""}`];
			if (s.total > 0) {
				head.push(`근거 기록 ${s.withThesis}/${s.total} · 회고 ${s.withReview}/${s.total} · 손절가 정한 매수 ${s.buysWithStop}/${s.buys}`);
				const src = Object.entries(s.bySource).filter(([, n]) => n > 0).map(([k, n]) => `${SOURCE[k as keyof typeof SOURCE]} ${n}`);
				head.push(`경로: ${src.join(" · ")}`);
				if (s.tags.length) head.push(`태그: ${s.tags.map((t) => `#${t.tag} ${t.count}`).join(" · ")}`);
				if (s.emotions.length) head.push(`감정: ${s.emotions.map((e) => `${e.emotion} ${e.count}`).join(" · ")}`);
				head.push(`종목: ${s.symbols.map((x) => `${x.name ?? x.symbol} ${x.count}`).join(" · ")}`);
			}
			const lines = entries.slice(0, LIST_PREVIEW).map(entryLine);
			const more = entries.length > LIST_PREVIEW ? [`외 ${entries.length - LIST_PREVIEW}건 (여기엔 없음 — 기간·종목을 좁히거나 일지 탭에서)`] : [];
			return {
				content: [{ type: "text" as const, text: [...notes, ...head, "", ...(lines.length ? lines : ["기록이 없습니다."]), ...more].join("\n") }],
				details: { kind: "journal-list" as const, period, stats: s, count: entries.length },
			};
		},
	});

	return [journalAdd, journalUpdate, journalList];
}

export const JOURNAL_TOOL_NAMES = ["journal_add", "journal_update", "journal_list"] as const;
