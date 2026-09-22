/**
 * 재무·컨센서스 정규화 테스트.
 *
 * KIS 응답에는 "값처럼 보이는 비값"(99.99 = 미제공)과 "비교하면 안 되는 값"
 * (분기 = 연단위 누적)이 섞여 있다. 둘 다 조용히 틀린 숫자를 만들어내므로
 * 실측 응답 모양을 고정해 둔다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatEok,
	mergeFinancials,
	consensusError,
	parseConsensus,
	yoyChange,
	type FinancialPeriod,
} from "../src/financials.ts";

/** 실측 응답(삼성전자 2026-09) 모양 그대로 */
const ratios = {
	output: [
		{
			stac_yymm: "202606",
			grs: "98.6700",
			bsop_prfi_inrt: "1191.4400",
			ntin_inrt: "790.9700",
			roe_val: "31.39",
			eps: "17687.00",
			sps: "72276",
			bps: "86052.00",
			rsrv_rate: "57213.7600",
			lblt_rate: "31.1000",
		},
		{
			stac_yymm: "202506",
			grs: "10.0000",
			bsop_prfi_inrt: "5.0000",
			ntin_inrt: "3.0000",
			roe_val: "12.00",
			eps: "5000.00",
			sps: "60000",
			bps: "80000.00",
			rsrv_rate: "50000.0000",
			lblt_rate: "28.0000",
		},
	],
};

const income = {
	output: [
		{
			stac_yymm: "202606",
			sale_account: "3053729.00",
			sale_cost: "1041590.00",
			sale_totl_prfi: "2012139",
			depr_cost: "99.99", // 미제공
			sell_mang: "99.99", // 미제공
			bsop_prti: "1467252.00",
			bsop_non_ernn: "99.99",
			bsop_non_expn: "99.99",
			op_prfi: "1532682.00",
			spec_prfi: "99.99",
			spec_loss: "99.99",
			thtr_ntin: "1188497.00",
		},
		{
			stac_yymm: "202506",
			sale_account: "1526864.00",
			bsop_prti: "113500.00",
			thtr_ntin: "133000.00",
		},
	],
};

describe("재무 병합", () => {
	it("결산년월로 비율과 손익을 합친다", () => {
		const periods = mergeFinancials(ratios, income);
		assert.equal(periods.length, 2);

		const latest = periods[0] as FinancialPeriod;
		assert.equal(latest.period, "202606");
		assert.equal(latest.revenue, 3_053_729);
		assert.equal(latest.operatingProfit, 1_467_252);
		assert.equal(latest.netIncome, 1_188_497);
		assert.equal(latest.roe, 31.39);
		assert.equal(latest.debtRatio, 31.1);
		assert.equal(latest.eps, 17_687);
	});

	it("최신이 먼저 오도록 정렬한다", () => {
		const periods = mergeFinancials(ratios, income);
		assert.equal(periods[0]?.period, "202606");
		assert.equal(periods[1]?.period, "202506");
	});

	it("limit 으로 개수를 자른다", () => {
		assert.equal(mergeFinancials(ratios, income, 1).length, 1);
	});

	it("한쪽에만 있는 기간도 살린다", () => {
		const onlyIncome = { output: [{ stac_yymm: "202512", sale_account: "100.00" }] };
		const periods = mergeFinancials({ output: [] }, onlyIncome);
		assert.equal(periods[0]?.revenue, 100);
		assert.equal(periods[0]?.roe, null);
	});

	it("빈 응답에도 죽지 않는다", () => {
		assert.deepEqual(mergeFinancials({}, {}), []);
	});
});

describe("99.99 미제공 표식", () => {
	it("값으로 취급하지 않는다", () => {
		// 손익계산서에서 실제로 99.99 로 오는 필드들이 결과에 새어들면 안 된다
		const periods = mergeFinancials(ratios, income);
		const json = JSON.stringify(periods);
		assert.doesNotMatch(json, /99\.99/, "99.99 가 결과에 남아 있으면 안 된다");
	});

	it("정상 값 99.99 와 구분하지 못하는 한계는 감수한다 (문서화된 트레이드오프)", () => {
		const weird = { output: [{ stac_yymm: "202606", sale_account: "99.99" }] };
		const periods = mergeFinancials({ output: [] }, weird);
		assert.equal(periods[0]?.revenue, null);
	});
});

describe("전년 동기 대비", () => {
	it("같은 월끼리 비교한다 (분기 값이 연단위 누적이므로)", () => {
		const periods = mergeFinancials(ratios, income);
		const yoy = yoyChange(periods);
		assert.ok(yoy);
		// 3,053,729 / 1,526,864 − 1 = +100%
		assert.equal(yoy?.revenue, 100);
	});

	it("전년 동기가 없으면 null", () => {
		const periods = mergeFinancials({ output: [] }, { output: [{ stac_yymm: "202606", sale_account: "100" }] });
		assert.equal(yoyChange(periods), null);
	});

	it("전년이 적자면 증감률을 내지 않는다 (의미가 없다)", () => {
		const data = {
			output: [
				{ stac_yymm: "202606", sale_account: "100", bsop_prti: "50" },
				{ stac_yymm: "202506", sale_account: "80", bsop_prti: "-20" },
			],
		};
		const yoy = yoyChange(mergeFinancials({ output: [] }, data));
		assert.equal(yoy?.revenue, 25);
		assert.equal(yoy?.operatingProfit, null, "적자→흑자 증감률은 null 이어야 한다");
	});
});

describe("컨센서스", () => {
	it("output1 이 객체로 와도 읽는다 (KIS 는 배열·객체를 섞어 준다)", () => {
		// 실측: 컨센서스 output1 은 배열이 아니라 단일 객체로 온다.
		// 배열만 가정하면 조용히 빈 값이 되고, 그게 "미커버"로 잘못 표시된다.
		const c = parseConsensus({
			output1: {
				sht_cd: "A005930",
				item_kor_nm: "삼성전자",
				name1: "채민숙",
				estdate: "20260730",
				rcmd_name: "매수",
			} as never,
		});
		assert.equal(c.covered, true);
		assert.equal(c.rating, "매수");
		assert.equal(c.analyst, "채민숙");
	});

	it("조회 실패를 미커버와 구분한다", () => {
		const failed = consensusError("HTTP 500");
		assert.equal(failed.covered, false);
		assert.equal(failed.error, "HTTP 500");

		const notCovered = parseConsensus({ output1: { capital: "0.0" } as never });
		assert.equal(notCovered.covered, false);
		assert.equal(notCovered.error, null, "미커버는 error 가 없어야 한다");
	});

	it("커버되는 종목의 의견을 읽는다 (배열 형태)", () => {
		const c = parseConsensus({
			output1: [
				{
					sht_cd: "A005930",
					item_kor_nm: "삼성전자",
					name1: "채민숙",
					estdate: "20260730",
					rcmd_name: "매수",
					capital: "8975.0",
				},
			],
		});
		assert.equal(c.covered, true);
		assert.equal(c.rating, "매수");
		assert.equal(c.analyst, "채민숙");
		assert.equal(c.estimatedAt, "20260730");
	});

	it("커버되지 않는 종목을 '데이터 없음'이 아니라 '미커버'로 구분한다", () => {
		// 실측: 중소형주는 rt_cd=0 정상인데 output1 에 이름·의견이 비어서 온다
		const c = parseConsensus({ output1: [{ capital: "0.0", forn_item_lmtrt: "0.00" }] });
		assert.equal(c.covered, false);
		assert.equal(c.rating, null);
	});

	it("output1 자체가 없어도 죽지 않는다", () => {
		assert.equal(parseConsensus({}).covered, false);
	});
});

describe("금액 표기", () => {
	it("1조 이상은 조 단위로", () => {
		assert.equal(formatEok(3_053_729), "305.4조원");
		assert.equal(formatEok(10_000), "1조원");
	});

	it("1조 미만은 억원으로", () => {
		assert.equal(formatEok(9_999), "9,999억원");
		assert.equal(formatEok(-21), "-21억원");
	});

	it("없는 값은 대시", () => {
		assert.equal(formatEok(null), "—");
	});
});
