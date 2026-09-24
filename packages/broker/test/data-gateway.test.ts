/**
 * 데이터 제공자 범용 조회 (PLAN §35).
 *
 * 지켜야 할 것:
 *   - 키는 서버가 넣고 **URL·오류 메시지에 남지 않는다** (finnhub 는 쿼리 대신 헤더)
 *   - Binance 서명은 공식 문서 예제와 정확히 같다, 서명·timestamp 는 모델 값을 무시한다
 *   - 쓰기 API 는 네트워크 전에 거절한다
 *   - Twelve Data 의 "HTTP 200 + status:error" 도 실패로 잡는다
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	binanceSign,
	buildDataRequest,
	callDataApi,
	dataCatalog,
	findDataApis,
	isDataWrite,
	renderDataResult,
	resolveDataApi,
	type DataCreds,
	type DataProvider,
} from "../src/data/gateway.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const api = (p: DataProvider, ref: string) => {
	const hit = resolveDataApi(p, ref);
	assert.ok(hit, `${p} ${ref}`);
	return hit.api;
};
const CREDS: DataCreds = { finnhub: "FINNHUBKEY123", twelve: "TWELVEKEY456", coingecko: "CG-DEMOKEY789", binance: { key: "BINKEY000111", secret: "BINSECRET222333" } };

describe("카탈로그", () => {
	it("공식 규격 개수 그대로 (조회 GET)", () => {
		const gets = (p: DataProvider) => Object.values(dataCatalog(p)).filter((a) => !isDataWrite(a)).length;
		assert.equal(gets("finnhub"), 113);
		assert.equal(gets("twelve"), 186);
		assert.equal(gets("coingecko"), 66);
		assert.equal(gets("binance"), 230);
	});

	it("중복 제거한 파라미터·필드 설명을 펼쳐서 읽는다", () => {
		const a = api("twelve", "/time_series");
		assert.equal(typeof a.params.symbol, "object");
		assert.equal(typeof a.params.symbol!.desc, "string");
	});

	it("찾기 — 영문 키워드", () => {
		assert.ok(findDataApis("earnings calendar", "finnhub").some((f) => /earnings/i.test(f.api.path)));
		assert.ok(findDataApis("trending", "coingecko").some((f) => /trending/i.test(f.api.path)));
		assert.ok(findDataApis("klines").some((f) => f.provider === "binance" && /klines/.test(f.api.path)));
	});
});

describe("Binance 서명", () => {
	it("공식 문서 예제와 같다 (HMAC-SHA256)", () => {
		// https://developers.binance.com/docs/binance-spot-api-docs/rest-api/endpoint-security-type (SIGNED 예제)
		const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
		const q = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
		assert.equal(binanceSign(q, secret), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
	});

	it("계좌(signed) API: 키 헤더 + timestamp·recvWindow + 마지막에 signature — 모델이 준 서명·timestamp 는 무시", () => {
		const a = api("binance", "GET /api/v3/account");
		assert.equal(a.auth, "signed");
		const { built, errors } = buildDataRequest("binance", a, { timestamp: 1, signature: "forged" }, CREDS, 1_700_000_000_000);
		assert.deepEqual(errors, []);
		const url = new URL(built!.url);
		assert.equal(built!.headers["X-MBX-APIKEY"], "BINKEY000111");
		assert.equal(url.searchParams.get("timestamp"), "1700000000000");
		assert.equal(url.searchParams.get("recvWindow"), "5000");
		const qs = url.search.slice(1);
		const [body, sig] = qs.split("&signature=");
		assert.equal(sig, binanceSign(body!, "BINSECRET222333"));
		assert.doesNotMatch(qs, /forged/);
		assert.doesNotMatch(built!.url, /BINSECRET/);
	});

	it("공개 시세 API 는 키 없이, 키 헤더도 싣지 않는다", () => {
		const { built, errors } = buildDataRequest("binance", api("binance", "GET /api/v3/klines"), { symbol: "BTCUSDT", interval: "1d" }, {});
		assert.deepEqual(errors, []);
		assert.equal(built!.headers["X-MBX-APIKEY"], undefined);
		assert.match(built!.url, /^https:\/\/api\.binance\.com\/api\/v3\/klines\?/);
	});

	it("계좌 API 인데 키가 없으면 설정 안내", () => {
		const { errors } = buildDataRequest("binance", api("binance", "GET /api/v3/account"), {}, {});
		assert.ok(errors.some((e) => e.includes("키가 필요")));
	});

	it("테스트넷 설정이면 testnet 주소", () => {
		const { built } = buildDataRequest("binance", api("binance", "GET /api/v3/time"), {}, { binance: { key: "k", secret: "s", testnet: true } });
		assert.match(built!.url, /^https:\/\/testnet\.binance\.vision/);
	});
});

describe("키 주입", () => {
	it("finnhub 는 헤더로 — URL 에 키가 없다", () => {
		const { built } = buildDataRequest("finnhub", api("finnhub", "/quote"), { symbol: "AAPL" }, CREDS);
		assert.equal(built!.headers["X-Finnhub-Token"], "FINNHUBKEY123");
		assert.doesNotMatch(built!.url, /FINNHUBKEY/);
		assert.equal(new URL(built!.url).searchParams.get("symbol"), "AAPL");
	});

	it("Twelve Data 는 Authorization: apikey …", () => {
		const { built } = buildDataRequest("twelve", api("twelve", "/quote"), { symbol: "AAPL" }, CREDS);
		assert.equal(built!.headers.Authorization, "apikey TWELVEKEY456");
		assert.doesNotMatch(built!.url, /TWELVEKEY/);
	});

	it("CoinGecko 는 키가 있으면 헤더, 없어도 된다", () => {
		assert.equal(buildDataRequest("coingecko", api("coingecko", "/ping"), {}, CREDS).built!.headers["x-cg-demo-api-key"], "CG-DEMOKEY789");
		assert.deepEqual(buildDataRequest("coingecko", api("coingecko", "/ping"), {}, {}).errors, []);
	});

	it("키가 필요한 제공자인데 없으면 설정 안내 (finnhub·twelve)", () => {
		assert.ok(buildDataRequest("finnhub", api("finnhub", "/quote"), { symbol: "AAPL" }, {}).errors.some((e) => e.includes("키가 없습니다")));
		assert.ok(buildDataRequest("twelve", api("twelve", "/quote"), { symbol: "AAPL" }, {}).errors.some((e) => e.includes("키가 없습니다")));
	});

	it("모르는 파라미터는 거절 (공용 규칙)", () => {
		assert.ok(buildDataRequest("finnhub", api("finnhub", "/quote"), { symbol: "AAPL", symbl: "x" }, CREDS).errors.some((e) => e.includes("symbl")));
	});
});

describe("호출", () => {
	it("쓰기 API 는 네트워크 전에 거절 (Binance 주문·finnhub POST)", async () => {
		globalThis.fetch = (async () => {
			throw new Error("네트워크에 닿으면 안 된다");
		}) as typeof fetch;
		for (const p of ["binance", "finnhub", "twelve"] as DataProvider[]) {
			for (const [id, a] of Object.entries(dataCatalog(p))) {
				if (isDataWrite(a)) await assert.rejects(callDataApi(p, id, {}, CREDS), /쓰기 API/, `${p} ${id}`);
			}
		}
	});

	it("오류 응답에 키가 섞여 와도 메시지에서 지운다", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Invalid API key FINNHUBKEY123" }), { status: 401 })) as typeof fetch;
		await assert.rejects(callDataApi("finnhub", "/quote", { symbol: "AAPL" }, CREDS), (e: Error) => !e.message.includes("FINNHUBKEY123") && e.message.includes("****"));
	});

	it("Twelve Data 의 HTTP 200 + status:error 도 실패", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ status: "error", code: 429, message: "You have run out of API credits" }))) as typeof fetch;
		await assert.rejects(callDataApi("twelve", "/quote", { symbol: "AAPL" }, CREDS), /run out of API credits/);
	});

	it("Binance 오류 코드(음수 code)도 실패", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 })) as typeof fetch;
		await assert.rejects(callDataApi("binance", "GET /api/v3/klines", { symbol: "NOPE", interval: "1d" }, {}), /Invalid symbol/);
	});
});

describe("이름 없는 배열 응답 (Binance)", () => {
	it("캔들 배열에 이름을 붙인다 — 순서: 시각·시가·고가·저가·종가·거래량", () => {
		const k = [[1790035200000, "2776.2", "2777.5", "2715.9", "2753.6", "303015.6", 1790121599999, "831787685.1", 3009482, "150778.8", "413929926.2", "0"]];
		const out = renderDataResult("binance", api("binance", "GET /api/v3/klines"), k);
		assert.match(out.text, /openTime\topen\thigh\tlow\tclose\tvolume/);
		assert.match(out.text, /2026-09-22 09:00\t2776\.2\t2777\.5\t2715\.9\t2753\.6/);
		assert.match(out.text, /close: 종가/);
	});

	it("호가는 가격·잔량으로", () => {
		const out = renderDataResult("binance", api("binance", "GET /api/v3/depth"), { lastUpdateId: 1, bids: [["84170.0", "0.18"]], asks: [["84170.01", "8.5"]] });
		assert.match(out.text, /\[bids\] 1행/);
		assert.match(out.text, /price\tquantity/);
		assert.match(out.text, /84170\.0\t0\.18/);
	});
});
