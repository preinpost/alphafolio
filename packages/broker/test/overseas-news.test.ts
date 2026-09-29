/**
 * 해외뉴스종합 테스트 — 조회 없이 페이지 로직을 고정한다.
 *
 * 실측 동작 두 가지가 핵심이다: 종목은 거래소를 맞춰야 걸리고(아니면 빈 응답),
 * 커서(마지막 행 시각)로 다음 페이지를 받으면 경계 행이 한 번 더 온다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectOverseasNews, parseOverseasNews, type OverseasNewsPage } from "../src/overseas-news.ts";

/** 실측 응답(MU 2026-09) 모양 그대로 */
const row = (key: string, dt: string, tm: string, title = `기사 ${key}`) => ({
	info_gb: "t",
	news_key: key,
	data_dt: dt,
	data_tm: tm,
	class_cd: "05",
	class_name: "종목리포트",
	source: "연합미국",
	nation_cd: "US",
	exchange_cd: "NAS",
	symb: "MU",
	symb_name: "마이크론 테크놀로지",
	title,
});
const page = (...rows: ReturnType<typeof row>[]) => ({ rt_cd: "0", outblock1: rows });

describe("parseOverseasNews", () => {
	it("날짜·시각을 읽기 좋게 바꾸고 커서용 원본은 따로 둔다", () => {
		const [n] = parseOverseasNews(page(row("ICH1", "20260929", "211453")));
		assert.deepEqual(
			{ date: n?.date, time: n?.time, rawDate: n?.rawDate, rawTime: n?.rawTime },
			{ date: "2026-09-29", time: "21:14", rawDate: "20260929", rawTime: "211453" },
		);
		assert.equal(n?.category, "종목리포트");
		assert.equal(n?.name, "마이크론 테크놀로지");
	});

	it("제목 없는 행과 outblock1 없는 응답은 빈 목록", () => {
		assert.equal(parseOverseasNews(page(row("a", "20260929", "100000", ""))).length, 0);
		assert.equal(parseOverseasNews({ rt_cd: "0" }).length, 0);
	});
});

describe("collectOverseasNews", () => {
	it("거래소 미지정이면 NAS→NYS→AMS 중 기사가 나온 곳을 쓴다", async () => {
		const tried: string[] = [];
		const fetchPage: OverseasNewsPage = async ({ excd }) => {
			tried.push(excd);
			return excd === "NYS" ? page(row("k1", "20260928", "114312")) : page();
		};
		const r = await collectOverseasNews(fetchPage, { symbol: "KO", count: 10 });
		assert.equal(r.excd, "NYS");
		assert.equal(r.items.length, 1);
		assert.deepEqual(tried.slice(0, 2), ["NAS", "NYS"]);
		assert.ok(!tried.includes("AMS"));
	});

	it("전체 조회는 거래소를 비워서 한 번만 찾는다", async () => {
		const tried: string[] = [];
		const r = await collectOverseasNews(
			async ({ excd }) => {
				tried.push(excd);
				return page(row("k1", "20260929", "222650"));
			},
			{ count: 1 },
		);
		assert.deepEqual(tried, [""]);
		assert.equal(r.excd, null);
	});

	it("마지막 행 시각을 커서로 넘기고 경계 중복은 뺀다", async () => {
		const cursors: string[] = [];
		const pages: Record<string, ReturnType<typeof page>> = {
			"": page(row("a", "20260929", "211453"), row("b", "20260923", "100349")),
			"20260923100349": page(row("b", "20260923", "100349"), row("c", "20260922", "083309")),
			"20260922083309": page(row("c", "20260922", "083309")),
		};
		const r = await collectOverseasNews(
			async ({ date, time }) => {
				cursors.push(date + time);
				return pages[date + time] ?? page();
			},
			{ symbol: "MU", excd: "NAS", count: 10 },
		);
		assert.deepEqual(r.items.map((n) => n.key), ["a", "b", "c"]);
		assert.deepEqual(cursors, ["", "20260923100349", "20260922083309"]);
		assert.equal(r.pages, 3);
	});

	it("count 를 채우면 더 조회하지 않는다", async () => {
		let calls = 0;
		const r = await collectOverseasNews(
			async () => {
				calls++;
				return page(row(`k${calls}a`, "20260929", `1${calls}0000`), row(`k${calls}b`, "20260929", `0${calls}0000`));
			},
			{ count: 3 },
		);
		assert.equal(r.items.length, 3);
		assert.equal(calls, 2);
	});

	it("커서가 안 움직이면(새 행 없음) 멈춘다 — 무한 조회 방지", async () => {
		let calls = 0;
		const r = await collectOverseasNews(
			async () => {
				calls++;
				return page(row("same", "20260929", "100000"));
			},
			{ count: 50 },
		);
		assert.equal(r.items.length, 1);
		assert.equal(calls, 2);
	});

	it("어느 거래소에도 없으면 빈 결과", async () => {
		const r = await collectOverseasNews(async () => page(), { symbol: "ZZZZ", count: 10 });
		assert.deepEqual(r.items, []);
		assert.equal(r.excd, null);
		assert.equal(r.pages, 3);
	});
});
