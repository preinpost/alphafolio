/** 시세·지표·랭킹·뉴스 툴. */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fetchMovers, type MoverType } from "../movers.ts";
import { NaverCredentialsMissingError, searchNews } from "../news.ts";
import { collectOverseasNews } from "../overseas-news.ts";
import { overseasNews } from "../kis/api.ts";
import { coinPrice, fetchCryptoChart, normalizeCryptoSymbol, quoteAsset, type CryptoPeriod } from "../crypto-chart.ts";
import { analyze } from "../indicators.ts";
import { marketOf } from "../orders.ts";
import { fetchQuote, fetchChart } from "../quote.ts";
import type { BrokerToolDeps, QuoteDetails, TechnicalDetails, MoversDetails, NewsDetails, OverseasNewsDetails } from "./contracts.ts";
import { money, signed, usd } from "./format.ts";

/** market_technical 의 코인 경로 — fetchChart 와 같은 모양(symbol·name·bars·note)에 호가 자산을 더한다 */
async function cryptoTechnicalChart(symbol: string, period: CryptoPeriod) {
	const chart = await fetchCryptoChart(symbol, period).catch((err: unknown) => {
		// "ETH" 처럼 코인 이름만 온 경우 — 모델이 심볼을 고쳐 다시 부르게 한다
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(quoteAsset(normalizeCryptoSymbol(symbol)) ? msg : `${msg} — Binance 심볼은 호가 자산까지 붙인다 (ETHUSDT)`);
	});
	const openBar = chart.lastOpen ? chart.bars.at(-1) : undefined;
	return {
		symbol: chart.symbol,
		name: chart.symbol,
		quote: chart.quote,
		bars: chart.bars,
		note:
			"Binance 현물 기준 · 봉 경계 UTC 0시(한국 09:00)" +
			(openBar ? ` · 마지막 봉(${openBar.date}~)은 진행 중이라 현재가·지표가 마감 전까지 바뀐다` : ""),
	};
}

export function createMarketTools(deps: BrokerToolDeps) {
	const marketPrice = defineTool({
		name: "market_price",
		label: "시세 조회",
		description:
			"주식 현재가를 조회한다. 국내는 6자리 종목코드(예: 005930), 해외는 티커(예: AAPL, RKLB)를 쓴다. " +
			"증권사(KIS/토스)는 설정된 것 중에서 자동으로 고른다. " +
			"거래소는 자동으로 찾는다. 가격을 기억에 의존해 말하지 말고 반드시 이 툴로 확인한다.",
		parameters: Type.Object({
			symbol: Type.String({ description: "6자리 국내 종목코드 또는 해외 티커" }),
		}),
		execute: async (_id, params) => {
			const quote = await fetchQuote(deps.brokers, params.symbol);
			const details: QuoteDetails = { kind: "quote-card", quote };

			const extra: string[] = [];
			if (quote.per !== null) extra.push(`PER ${quote.per}`);
			if (quote.pbr !== null) extra.push(`PBR ${quote.pbr}`);
			if (quote.high52 !== null && quote.low52 !== null) {
				extra.push(`52주 ${money(quote.low52, quote.currency)}~${money(quote.high52, quote.currency)}`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`${quote.name} (${quote.symbol}${quote.exchange ? `·${quote.exchange}` : ""}) ` +
							`${money(quote.price, quote.currency)} ` +
							`${signed(quote.change, quote.currency)} (${quote.changePct >= 0 ? "+" : ""}${quote.changePct}%)` +
							(extra.length > 0 ? `\n${extra.join(" · ")}` : ""),
					},
				],
				details,
			};
		},
	});

	const marketTechnical = defineTool({
		name: "market_technical",
		label: "기술적 분석",
		description:
			"기간별 시세로 기술적 지표를 계산한다 — 이동평균(5/20/60)·RSI(14)·MACD·볼린저·ATR·" +
			"지지/저항·추세·신호 라벨. '차트 분석', '추세 어때?', 'RSI 얼마야?' 같은 **지표 확인** 요청에 쓴다. " +
				"매수·매도 판단이나 손절가가 필요하면 이 툴이 아니라 market_timing 을 쓴다. " +
			"코인은 market='binance' + Binance 심볼(ETHUSDT 처럼 호가 자산까지) — 키 없이 된다. " +
			"'ETH' 처럼 코인 이름만 주식 티커로 넘기면 같은 이름의 미국 상장 상품이 걸린다. " +
			"⚠️ 지표는 이 툴이 계산한다. 직접 계산하거나 추정하지 말고 반환된 숫자만 인용한다. " +
			"봉 데이터는 반환하지 않으므로 개별 봉 값을 나열하려 하지 않는다.",
		parameters: Type.Object({
			symbol: Type.String({ description: "6자리 국내 종목코드 · 해외 티커 · Binance 심볼(ETHUSDT)" }),
			market: Type.Optional(
				Type.Union([Type.Literal("krx"), Type.Literal("us"), Type.Literal("binance")], {
					description: "코인은 binance (필수). 주식은 생략해도 종목코드로 알아서 찾는다",
				}),
			),
			period: Type.Optional(
				Type.Union([Type.Literal("D"), Type.Literal("W"), Type.Literal("M")], {
					description: "D=일봉(기본), W=주봉, M=월봉",
				}),
			),
		}),
		execute: async (_id, params) => {
			const period = (params.period as "D" | "W" | "M" | undefined) ?? "D";
			const chart = params.market === "binance" ? await cryptoTechnicalChart(params.symbol, period) : await fetchChart(deps.brokers, params.symbol, period);
			const currency = "quote" in chart ? chart.quote : marketOf(chart.symbol) === "KR" ? "KRW" : "USD";
			const fmt = (v: number): string => ("quote" in chart ? coinPrice(v, chart.quote) : money(v, currency as "KRW" | "USD"));
			const snapshot = analyze(chart.bars);

			const details: TechnicalDetails = {
				kind: "technical-card",
				symbol: chart.symbol,
				name: chart.name,
				period,
				currency,
				snapshot,
				...(chart.note ? { note: chart.note } : {}),
			};

			if (!snapshot) {
				return {
					content: [{ type: "text" as const, text: `${chart.symbol} 시세 데이터가 없어 지표를 계산하지 못했습니다.` }],
					details,
				};
			}

			const label = period === "D" ? "일봉" : period === "W" ? "주봉" : "월봉";
			const ma = (v: number | null): string => (v === null ? "—" : fmt(v));
			const lines = [
				`${chart.name === chart.symbol ? chart.symbol : `${chart.name} (${chart.symbol})`} ${label} ${snapshot.bars}개 · 기준 ${snapshot.lastDate}`,
				`현재가 ${fmt(snapshot.price)} · 기간 ${snapshot.periodChangePct >= 0 ? "+" : ""}${snapshot.periodChangePct}%`,
				`MA5 ${ma(snapshot.ma5)} / MA20 ${ma(snapshot.ma20)} / MA60 ${ma(snapshot.ma60)} → ${snapshot.trend}`,
				`RSI ${snapshot.rsi ?? "—"}` +
					(snapshot.macdHistogram !== null
						? ` · MACD 히스토그램 ${snapshot.macdHistogram > 0 ? "+" : ""}${snapshot.macdHistogram.toFixed(2)}`
						: ""),
				`볼린저 ${ma(snapshot.bollingerLower)} ~ ${ma(snapshot.bollingerUpper)}` +
					(snapshot.bollingerPct !== null ? ` (밴드 내 ${snapshot.bollingerPct}%)` : ""),
				`지지 ${ma(snapshot.support)} / 저항 ${ma(snapshot.resistance)} · 기간 고 ${fmt(snapshot.periodHigh)} 저 ${fmt(snapshot.periodLow)}`,
				snapshot.atr !== null ? `ATR(14) ${fmt(snapshot.atr)} (가격의 ${snapshot.atrPct}%)` : "",
				snapshot.signals.length > 0 ? `신호: ${snapshot.signals.join(" · ")}` : "신호: 특이사항 없음",
				chart.note ?? "",
			].filter(Boolean);

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
		},
	});

	const marketMovers = defineTool({
		name: "market_movers",
		label: "시장 랭킹",
		description:
			"오늘 시장을 주도한 종목을 조회한다 — 거래대금·거래량·상승률·하락률 상위. " +
			"'주도주', '뭐가 올랐어', '거래대금 상위', '오늘 시장 어땠어' 같은 질문에 쓴다. " +
			"⚠️ 섹터/테마 단위 랭킹은 제공되지 않는다 — 섹터를 물으면 상위 종목 구성을 근거로 설명하되, " +
			"섹터 순위 자체는 알 수 없다고 밝힌다. 토스증권 연결이 필요하다.",
		parameters: Type.Object({
			type: Type.Optional(
				Type.Union(
					[
						Type.Literal("trading_amount"),
						Type.Literal("trading_volume"),
						Type.Literal("gainers"),
						Type.Literal("losers"),
					],
					{ description: "trading_amount=거래대금(기본), trading_volume=거래량, gainers=상승률, losers=하락률" },
				),
			),
			market: Type.Optional(
				Type.Union([Type.Literal("KR"), Type.Literal("US")], { description: "KR=국내(기본), US=미국" }),
			),
			duration: Type.Optional(
				Type.Union(
					[
						Type.Literal("realtime"),
						Type.Literal("1d"),
						Type.Literal("1w"),
						Type.Literal("1mo"),
						Type.Literal("3mo"),
						Type.Literal("6mo"),
						Type.Literal("1y"),
					],
					{
						description:
							"집계 기간. 거래대금·거래량은 realtime(기본), 등락률(gainers/losers)은 realtime 미지원이라 1d 가 기본",
					},
				),
			),
			count: Type.Optional(Type.Integer({ description: "가져올 종목 수 (기본 10, 최대 30)" })),
		}),
		execute: async (_id, params) => {
			const toss = deps.brokers.toss;
			if (!toss) throw new Error("시장 랭킹은 토스증권 연결이 필요합니다. 설정 화면에서 토스 키를 입력하세요.");

			const type = (params.type as MoverType | undefined) ?? "trading_amount";
			const market = (params.market as "KR" | "US" | undefined) ?? "KR";
			const result = await fetchMovers(
				toss(),
				deps.brokers,
				{ type, market, duration: params.duration as never, count: params.count },
			);

			const label =
				type === "trading_amount"
					? "거래대금"
					: type === "trading_volume"
						? "거래량"
						: type === "gainers"
							? "상승률"
							: "하락률";
			const title = `${market === "KR" ? "국내" : "미국"} ${label} 상위`;
			const details: MoversDetails = {
				kind: "movers-card",
				title,
				market,
				rankedAt: result.rankedAt,
				movers: result.movers,
			};

			if (result.movers.length === 0) {
				return {
					content: [{ type: "text" as const, text: `${title} — 집계 데이터가 없습니다 (장 시작 전일 수 있습니다).` }],
					details,
				};
			}

			const lines = result.movers.map((m) => {
				const price = money(m.price, m.currency);
				const amt =
					m.tradingAmount > 0
						? ` · 거래대금 ${m.currency === "KRW" ? `${Math.round(m.tradingAmount / 100_000_000).toLocaleString("ko-KR")}억` : usd(m.tradingAmount)}`
						: "";
				return `${m.rank}. ${m.name} ${price} (${m.changePct >= 0 ? "+" : ""}${m.changePct}%)${amt}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${title}\n${lines.join("\n")}` + (result.note ? `\n\n${result.note}` : ""),
					},
				],
				details,
			};
		},
	});

	const marketNews = defineTool({
		name: "market_news",
		label: "뉴스 검색",
		description:
			"네이버 뉴스에서 한국 증권·종목·시장 뉴스를 검색한다. " +
			"'삼성전자 뉴스', '오늘 증시 뉴스', 'AI 반도체 관련 소식' 같은 요청에 쓴다. " +
			"국내 이슈는 이 툴이 web_search 보다 정확하다. 해외·비한국어 주제는 web_search 를 쓴다. " +
			"기사 제목과 요약만 돌려주므로, 본문이 필요하면 링크를 fetch_content 로 읽는다.",
		parameters: Type.Object({
			query: Type.String({ description: "검색어 — 종목명·종목코드·키워드 (예: 삼성전자, 코스피, 금리)" }),
			count: Type.Optional(Type.Integer({ description: "기사 수 (기본 10, 최대 30)" })),
			sort: Type.Optional(
				Type.Union([Type.Literal("sim"), Type.Literal("date")], {
					description: "sim=정확도순(기본), date=최신순",
				}),
			),
			days: Type.Optional(Type.Integer({ description: "최근 N일 이내만 (기본 7, 0=전체)" })),
		}),
		execute: async (_id, params) => {
			if (!deps.naver) throw new NaverCredentialsMissingError();

			const items = await searchNews(deps.naver(), params.query, {
				display: Math.min(params.count ?? 10, 30),
				sort: (params.sort as "sim" | "date" | undefined) ?? "sim",
				days: params.days ?? 7,
			});

			const details: NewsDetails = { kind: "news-card", query: params.query, items };

			if (items.length === 0) {
				return {
					content: [{ type: "text" as const, text: `"${params.query}" 관련 뉴스를 찾지 못했습니다.` }],
					details,
				};
			}

			// 제목+요약만 content 로. 본문이 필요하면 모델이 링크를 fetch_content 로 읽는다.
			const lines = items.map((n) => `- [${n.date}] ${n.title}\n  ${n.summary}\n  ${n.link}`);
			return {
				content: [{ type: "text" as const, text: `"${params.query}" 뉴스 ${items.length}건\n\n${lines.join("\n")}` }],
				details,
			};
		},
	});

	const marketOverseasNews = defineTool({
		name: "market_overseas_news",
		label: "해외 종목 뉴스",
		description:
			"한국투자증권 해외뉴스종합에서 해외 종목 뉴스 제목을 최신순으로 가져온다 — 종목리포트(투자의견·IB 코멘트), 특징주, 실적공시 등 한국어 기사. " +
			"'엔비디아 뉴스', 'MU 요즘 이슈', '미국 주식 소식' 같은 요청에 쓴다. symbol 을 빼면 해외 전체 최신 뉴스다. " +
			"거래소는 자동으로 찾는다. 국내 종목(6자리 코드)은 market_news 를 쓴다. " +
			"⚠️ 제목만 온다 (본문·링크 없음) — 원인을 단정하려면 web_search 로 원문을 찾아 읽는다. " +
			"KIS 연결이 필요하다.",
		parameters: Type.Object({
			symbol: Type.Optional(Type.String({ description: "해외 티커 (예: NVDA, MU, KO). 비우면 전체 뉴스" })),
			count: Type.Optional(Type.Integer({ description: "기사 수 (기본 10, 최대 50)" })),
		}),
		execute: async (_id, params) => {
			const kis = deps.brokers.kis;
			if (!kis) throw new Error("해외 뉴스는 한국투자증권(KIS) 연결이 필요합니다. 설정 화면에서 키를 입력하세요.");

			const symbol = params.symbol?.trim().toUpperCase() || undefined;
			if (symbol && marketOf(symbol) === "KR") {
				throw new Error(`국내 종목(${symbol})은 market_news 로 검색하세요. 이 툴은 해외 티커 전용입니다.`);
			}
			const count = Math.min(Math.max(params.count ?? 10, 1), 50);

			const ctx = kis();
			const result = await collectOverseasNews(
				(q) => overseasNews(ctx, { symbol, excd: q.excd, date: q.date, time: q.time }),
				{ symbol, count },
			);
			const details: OverseasNewsDetails = { kind: "overseas-news", symbol: symbol ?? null, excd: result.excd, items: result.items };

			const first = result.items[0];
			const title = symbol ? `${first?.name || symbol} (${symbol}${result.excd ? `·${result.excd}` : ""})` : "해외 전체";
			if (!first) {
				return {
					content: [
						{
							type: "text" as const,
							text: symbol
								? `${symbol} 뉴스를 찾지 못했습니다 (NAS/NYS/AMS 모두 없음 — 티커를 확인하거나 web_search 를 쓰세요).`
								: "해외 뉴스가 없습니다.",
						},
					],
					details,
				};
			}

			// 전체 조회면 기사마다 종목이 다르다 — 줄마다 티커를 붙인다
			const lines = result.items.map(
				(n) =>
					`- [${n.date} ${n.time}] ${symbol ? "" : `${n.name || n.symbol}(${n.symbol}) `}${n.title}` +
					` — ${[n.category, n.source].filter(Boolean).join("·")}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`${title} 뉴스 ${result.items.length}건 (KIS 해외뉴스종합 · 시각 KST)\n\n${lines.join("\n")}` +
							"\n\n※ 제목만 제공됩니다 (본문·링크 없음). 원문이 필요하면 web_search 로 찾습니다.",
					},
				],
				details,
			};
		},
	});

	return { marketPrice, marketTechnical, marketMovers, marketNews, marketOverseasNews };
}
