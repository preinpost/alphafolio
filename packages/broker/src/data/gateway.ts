/**
 * 데이터 제공자 범용 조회 — finnhub · Twelve Data · CoinGecko · Binance 의 공식 규격(catalogs/*.json)에 있는
 * **조회(GET) API 전부** (PLAN §35).
 *
 * KIS·토스 범용 조회와 같은 원칙 (파라미터 검증·출력은 oas.ts 공용):
 *   - 쓰기는 실행하지 않는다 — Binance 주문은 확인 카드 경로(4b)로만, 자금 이동 API 는 영구 차단
 *   - API 키·서명·timestamp 는 서버가 넣는다 (모델 값 무시). **키는 오류 메시지·출력에 절대 싣지 않는다**
 *     (finnhub 는 키가 URL 쿼리에 들어가므로 오류에 URL 을 넣지 않는다)
 *   - 무료 요금제 한도에 맞춰 제공자별 호출 간격을 둔다
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildOasRequest, describeOasParams, renderOasResult, type OasApi, type OasParam } from "../oas.ts";

export type DataProvider = "finnhub" | "twelve" | "coingecko" | "binance";
export const DATA_PROVIDERS: readonly DataProvider[] = ["finnhub", "twelve", "coingecko", "binance"];

export interface DataApi extends OasApi {
	/** none=공개 · key=API 키 · signed=키 + HMAC 서명 (Binance) */
	auth?: "key" | "signed";
}

/** 사용자별 자격증명 — 없으면 undefined (그 제공자의 키가 필요한 API 만 실패한다) */
export interface DataCreds {
	finnhub?: string;
	twelve?: string;
	coingecko?: string;
	binance?: { key: string; secret: string; testnet?: boolean };
}

interface ProviderSpec {
	label: string;
	base: (c: DataCreds) => string;
	/** 무료 요금제 기준 최소 호출 간격 */
	intervalMs: number;
	/** 서버가 채우는 파라미터 */
	serverParams: ReadonlySet<string>;
	/** 키 없이도 되는가 (공개 API) */
	keyOptional: boolean;
	/** 설정 화면 안내 */
	keyHint: string;
}

export const PROVIDERS: Record<DataProvider, ProviderSpec> = {
	finnhub: {
		label: "Finnhub",
		base: () => "https://finnhub.io/api/v1",
		intervalMs: 1100, // 무료 60회/분
		serverParams: new Set(["token"]),
		keyOptional: false,
		keyHint: "설정 → 데이터 (Finnhub)",
	},
	twelve: {
		label: "Twelve Data",
		base: () => "https://api.twelvedata.com",
		intervalMs: 7600, // 무료 8회/분
		serverParams: new Set(["apikey"]),
		keyOptional: false,
		keyHint: "설정 → 데이터 (Twelve Data)",
	},
	coingecko: {
		label: "CoinGecko",
		base: () => "https://api.coingecko.com/api/v3",
		intervalMs: 2100, // 데모 30회/분
		serverParams: new Set(["x_cg_demo_api_key"]),
		keyOptional: true, // 키 없이도 공개 한도로 된다
		keyHint: "설정 → 데이터 (CoinGecko)",
	},
	binance: {
		label: "Binance",
		base: (c) => (c.binance?.testnet ? "https://testnet.binance.vision" : "https://api.binance.com"),
		intervalMs: 120, // 요청 가중치 한도가 넉넉하다 (6000/분)
		serverParams: new Set(["timestamp", "signature"]),
		keyOptional: true, // 시세는 공개, 계좌(signed)만 키 필요
		keyHint: "설정 → 코인 (Binance)",
	},
};

export class DataGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DataGatewayError";
	}
}

// ── 카탈로그 ────────────────────────────────────────────────

interface RawCatalog {
	provider: string;
	version: string;
	count: number;
	paramDefs: OasParam[];
	strings: string[];
	apis: Record<string, Omit<DataApi, "params" | "fields"> & { params: Record<string, number>; fields: Record<string, number> }>;
}

const catalogs = new Map<DataProvider, Record<string, DataApi>>();

/** 카탈로그를 읽고 번호로 가리킨 파라미터·필드 설명을 펼친다 (build-oas-catalog.mjs 의 중복 제거) */
export function dataCatalog(provider: DataProvider): Record<string, DataApi> {
	const hit = catalogs.get(provider);
	if (hit) return hit;
	const raw = JSON.parse(readFileSync(new URL(`./catalogs/${provider}.json`, import.meta.url), "utf8")) as RawCatalog;
	const apis: Record<string, DataApi> = {};
	for (const [id, a] of Object.entries(raw.apis)) {
		apis[id] = {
			...a,
			params: Object.fromEntries(Object.entries(a.params).map(([n, i]) => [n, raw.paramDefs[i]!])),
			fields: Object.fromEntries(Object.entries(a.fields).map(([k, i]) => [k, raw.strings[i]!])),
		};
	}
	catalogs.set(provider, apis);
	return apis;
}

export const isDataWrite = (api: DataApi): boolean => api.method !== "GET";

export function resolveDataApi(provider: DataProvider, ref: string): { id: string; api: DataApi } | null {
	const apis = dataCatalog(provider);
	const r = ref.trim();
	if (apis[r]) return { id: r, api: apis[r] };
	const lower = r.toLowerCase();
	const byId = Object.entries(apis).find(([id]) => id.toLowerCase() === lower);
	if (byId) return { id: byId[0], api: byId[1] };
	// 경로로도 (예: "/quote", "GET /api/v3/klines")
	const path = lower.replace(/^get\s+/, "");
	const byPath = Object.entries(apis).filter(([, a]) => a.method === "GET" && a.path.toLowerCase() === path);
	return byPath.length === 1 ? { id: byPath[0]![0], api: byPath[0]![1] } : null;
}

export interface FoundDataApi {
	provider: DataProvider;
	id: string;
	api: DataApi;
	score: number;
}

export function findDataApis(query: string, provider?: DataProvider, limit = 8): FoundDataApi[] {
	const tokens = query
		.toLowerCase()
		.split(/[\s,·/()[\]{}"'?!.]+/)
		.filter((t) => t.length >= 2);
	if (tokens.length === 0) return [];
	const out: FoundDataApi[] = [];
	for (const p of provider ? [provider] : DATA_PROVIDERS) {
		for (const [id, api] of Object.entries(dataCatalog(p))) {
			const summary = api.summary.toLowerCase();
			const path = api.path.toLowerCase();
			const tag = api.tag.toLowerCase();
			const desc = api.desc.toLowerCase();
			let score = 0;
			for (const t of tokens) {
				if (summary.includes(t)) score += 6;
				if (path.includes(t)) score += 4;
				if (tag.includes(t)) score += 3;
				if (id.toLowerCase().includes(t)) score += 2;
				if (desc.includes(t)) score += 1;
			}
			if (score > 0) out.push({ provider: p, id, api, score });
		}
	}
	return out
		.sort((a, b) => b.score - a.score || Number(isDataWrite(a.api)) - Number(isDataWrite(b.api)) || a.api.path.length - b.api.path.length)
		.slice(0, limit);
}

// ── 호출 ────────────────────────────────────────────────────

const lanes = new Map<string, { tail: Promise<void>; last: number }>();
async function throttled<T>(lane: string, intervalMs: number, fn: () => Promise<T>): Promise<T> {
	const l = lanes.get(lane) ?? { tail: Promise.resolve(), last: 0 };
	lanes.set(lane, l);
	const run = l.tail.then(async () => {
		const wait = l.last + intervalMs - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		l.last = Date.now();
	});
	l.tail = run.catch(() => {});
	await run;
	return fn();
}

/** Binance HMAC-SHA256 서명 — 보내는 쿼리 문자열 그대로에 서명한다 */
export function binanceSign(query: string, secret: string): string {
	return createHmac("sha256", secret).update(query).digest("hex");
}

/** 오류 메시지에서 키를 지운다 — 제공자가 응답에 키를 되돌려주는 경우까지 */
function scrub(text: string, creds: DataCreds): string {
	let t = text;
	for (const s of [creds.finnhub, creds.twelve, creds.coingecko, creds.binance?.key, creds.binance?.secret]) {
		if (s && s.length >= 6) t = t.split(s).join("****");
	}
	return t;
}

export interface BuiltDataRequest {
	url: string;
	headers: Record<string, string>;
}

/**
 * 실제로 보낼 URL·헤더 — 순수 함수 (테스트가 인증 주입·서명을 한 글자씩 검사한다).
 * 모델 입력은 buildOasRequest 가 검증하고, 인증은 여기서만 붙인다.
 */
export function buildDataRequest(
	provider: DataProvider,
	api: DataApi,
	input: Record<string, unknown>,
	creds: DataCreds,
	now: number = Date.now(),
): { built: BuiltDataRequest | null; errors: string[] } {
	const spec = PROVIDERS[provider];
	const { req, errors } = buildOasRequest(api, input, { serverParams: spec.serverParams, now });
	const headers: Record<string, string> = { accept: "application/json" };
	const q = new URLSearchParams(req.query);

	switch (provider) {
		case "finnhub":
			if (!creds.finnhub) errors.push(`Finnhub 키가 없습니다 — ${spec.keyHint}`);
			else headers["X-Finnhub-Token"] = creds.finnhub; // 쿼리 대신 헤더 — URL(로그)에 키가 남지 않게
			break;
		case "twelve":
			if (!creds.twelve) errors.push(`Twelve Data 키가 없습니다 — ${spec.keyHint}`);
			else headers.Authorization = `apikey ${creds.twelve}`;
			break;
		case "coingecko":
			if (creds.coingecko) headers["x-cg-demo-api-key"] = creds.coingecko;
			break;
		case "binance":
			if (api.auth === "key" || api.auth === "signed") {
				if (!creds.binance) errors.push(`이 Binance API 는 계좌 키가 필요합니다 — ${spec.keyHint}`);
				else headers["X-MBX-APIKEY"] = creds.binance.key;
			}
			if (api.auth === "signed" && creds.binance) {
				q.set("timestamp", String(now));
				if ("recvWindow" in api.params && !q.has("recvWindow")) q.set("recvWindow", "5000");
			}
			break;
	}
	if (errors.length > 0) return { built: null, errors };
	let qs = q.toString();
	if (provider === "binance" && api.auth === "signed" && creds.binance) {
		qs = `${qs}&signature=${binanceSign(qs, creds.binance.secret)}`;
	}
	return { built: { url: `${spec.base(creds)}${req.path}${qs ? `?${qs}` : ""}`, headers }, errors: [] };
}

export async function callDataApi(
	provider: DataProvider,
	ref: string,
	input: Record<string, unknown>,
	creds: DataCreds,
): Promise<{ id: string; api: DataApi; data: unknown }> {
	const found = resolveDataApi(provider, ref);
	if (!found) throw new DataGatewayError(`없는 ${PROVIDERS[provider].label} API: "${ref}" — data_find 로 먼저 찾으세요.`);
	const { id, api } = found;
	if (isDataWrite(api)) {
		throw new DataGatewayError(
			`"${api.summary || id}" 은(는) 쓰기 API 라 범용 조회로 실행하지 않습니다.` +
				(provider === "binance" ? " Binance 주문은 binance_order 로 준비하고 확인 카드에서 실행합니다." : ""),
		);
	}
	const { built, errors } = buildDataRequest(provider, api, input, creds);
	if (!built) throw new DataGatewayError(`${PROVIDERS[provider].label} ${api.summary || id} — 고쳐 다시 호출하세요:\n- ${errors.join("\n- ")}`);

	return throttled(`${provider}:${creds[provider] ? "k" : "anon"}`, PROVIDERS[provider].intervalMs, async () => {
		const res = await fetch(built.url, { headers: built.headers, signal: AbortSignal.timeout(20_000) });
		const text = await res.text();
		let data: unknown;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			// URL 은 싣지 않는다 (키가 들어 있을 수 있다)
			throw new DataGatewayError(`${PROVIDERS[provider].label} 응답을 읽지 못했습니다 (HTTP ${res.status}): ${scrub(text.slice(0, 160), creds)}`);
		}
		const o = data as Record<string, unknown> | null;
		// Twelve Data 는 HTTP 200 에 {status:"error"} 로 실패를 알린다
		const softError = o && typeof o === "object" && !Array.isArray(o) && (o.status === "error" || (provider === "binance" && typeof o.code === "number" && o.code < 0));
		if (!res.ok || softError) {
			const msg = String(o?.message ?? o?.msg ?? o?.error ?? text.slice(0, 160));
			throw new DataGatewayError(`${PROVIDERS[provider].label} ${api.summary || id} 실패 (HTTP ${res.status}): ${scrub(msg, creds)}`);
		}
		return { id, api, data };
	});
}

/** epoch ms → 한국 시간 "YYYY-MM-DD HH:mm" */
const kst = (ms: unknown): string => {
	const n = Number(ms);
	if (!Number.isFinite(n)) return String(ms);
	return new Date(n + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
};

/**
 * 이름 없는 배열 응답에 이름을 붙인다 — Binance 캔들·호가는 [시각, 시가, 고가, …] 순서 배열이고 규격에 필드 설명도 없어서,
 * 그대로 주면 모델이 어느 값이 종가인지 추측한다 (순서는 Binance 문서 기준).
 */
export function shapeDataResult(provider: DataProvider, path: string, data: unknown): unknown {
	if (provider !== "binance") return data;
	if (/\/(ui)?[kK]lines$/.test(path) && Array.isArray(data)) {
		return data.map((k) =>
			Array.isArray(k)
				? {
						openTime: kst(k[0]),
						open: k[1],
						high: k[2],
						low: k[3],
						close: k[4],
						volume: k[5],
						closeTime: kst(k[6]),
						quoteVolume: k[7],
						trades: k[8],
						takerBuyBaseVolume: k[9],
						takerBuyQuoteVolume: k[10],
					}
				: k,
		);
	}
	if (/\/depth$/.test(path) && data && typeof data === "object" && !Array.isArray(data)) {
		const o = data as Record<string, unknown>;
		const side = (v: unknown) => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? { price: x[0], quantity: x[1] } : x)) : v);
		return { ...o, bids: side(o.bids), asks: side(o.asks) };
	}
	return data;
}

/** 이름 붙인 Binance 응답의 필드 설명 (규격에 없다) */
const BINANCE_FIELDS: Record<string, string> = {
	"[].openTime": "캔들 시작 시각 (한국 시간)",
	"[].open": "시가",
	"[].high": "고가",
	"[].low": "저가",
	"[].close": "종가",
	"[].volume": "거래량 (기준 자산)",
	"[].closeTime": "캔들 종료 시각 (한국 시간)",
	"[].quoteVolume": "거래대금 (호가 자산, 예: USDT)",
	"[].trades": "체결 건수",
	"bids[].price": "매수 호가",
	"bids[].quantity": "매수 잔량",
	"asks[].price": "매도 호가",
	"asks[].quantity": "매도 잔량",
};

export function renderDataResult(
	provider: DataProvider,
	api: DataApi,
	data: unknown,
	opts: { limit?: number; fields?: string[] } = {},
): ReturnType<typeof renderOasResult> {
	const shaped = shapeDataResult(provider, api.path, data);
	const withFields = provider === "binance" ? { ...api, fields: { ...BINANCE_FIELDS, ...api.fields } } : api;
	return renderOasResult(withFields, shaped, opts);
}

export function describeDataApi(provider: DataProvider, id: string, api: DataApi): string {
	const params = describeOasParams(api, PROVIDERS[provider].serverParams);
	return [
		`${PROVIDERS[provider].label} · ${id} — ${api.summary} [${api.tag}]${isDataWrite(api) ? " · 쓰기(범용 조회로 실행 불가)" : ""}`,
		`${api.method} ${api.path}${api.auth === "signed" ? " · 계좌(서명) — 서버가 서명" : api.auth === "key" && provider === "binance" ? " · API 키 필요" : ""}`,
		api.desc ? `설명: ${api.desc.slice(0, 600)}` : "",
		"파라미터:",
		...(params.length > 0 ? params : ["  (없음)"]),
	]
		.filter(Boolean)
		.join("\n");
}
