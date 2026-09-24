/**
 * KIS 실시간 시세 (웹소켓) — 몇 초 동안 구독해서 틱을 모으고 요약한다 (PLAN §37).
 *
 * 흐름: 접속키(/oauth2/Approval, REST 토큰과 별개) → ws 연결 → 구독(tr_type 1) → N초 수신 → 해제(tr_type 2) → 닫기.
 * 호출마다 연결했다 끊는다 — 상주 연결은 두지 않는다 (툴이 원하는 건 "지금 몇 초간의 흐름"이다).
 *
 * 프레임 형식 (KIS 공식 샘플):
 *   데이터   "0|TR_ID|건수|값^값^…"  — 이름 없이 **위치로** 읽는다. 건수가 2 이상이면 필드 수로 잘라 여러 건.
 *   시스템   JSON {header:{tr_id,tr_key}, body:{rt_cd,msg1}} — 구독 응답·오류
 *   PINGPONG 같은 텍스트를 그대로 돌려보낸다
 * 암호화 프레임("1|…")은 체결통보 전용이다 — 카탈로그에서 뺐으므로 오면 버린다.
 *
 * 같은 앱키로 동시에 두 연결을 열면 KIS 가 앞 연결을 끊는다 → 앱키별로 한 번에 하나씩 (streamLock).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { baseUrl, KisError } from "./types.ts";
import type { KisContext } from "./client.ts";
import { issueOnce } from "../tokens.ts";

export interface WsApi {
	name: string;
	category: string;
	trId: string;
	keyDesc: string;
	/** [코드, 한글명, 설명?] — 순서가 곧 프레임의 위치다 */
	fields: Array<[string, string, string?]>;
}

let cached: Record<string, WsApi> | null = null;
export function kisWsCatalog(): Record<string, WsApi> {
	if (!cached) cached = (JSON.parse(readFileSync(new URL("./ws-catalog.json", import.meta.url), "utf8")) as { apis: Record<string, WsApi> }).apis;
	return cached;
}

/** key · TR ID · 이름으로 찾는다 */
export function resolveWsApi(ref: string): { key: string; api: WsApi } | null {
	const r = ref.trim();
	const exact = kisWsCatalog()[r];
	if (exact) return { key: r, api: exact };
	const up = r.toUpperCase();
	for (const [key, api] of Object.entries(kisWsCatalog())) if (api.trId === up || api.name === r) return { key, api };
	return null;
}

export function findWsApis(query: string, limit = 8): Array<{ key: string; api: WsApi }> {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return Object.entries(kisWsCatalog())
		.map(([key, api]) => {
			const hay = `${api.name} ${api.category} ${api.trId}`.toLowerCase();
			return { key, api, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.api.name.localeCompare(b.api.name))
		.slice(0, limit)
		.map(({ key, api }) => ({ key, api }));
}

export const WS_URL = { real: "ws://ops.koreainvestment.com:21000", paper: "ws://ops.koreainvestment.com:31000" } as const;
export const WS_MAX_SECONDS = 30;
export const WS_MAX_SUBS = 5;
/** 구독 하나당 보관하는 최대 건수 — 요약에는 충분하고 메모리는 묶인다 */
export const WS_MAX_RECORDS = 3000;

// ── 접속키 ──────────────────────────────────────────────────

const APPROVAL_TTL_MS = 23 * 3600_000;

export function approvalKeyName(ctx: KisContext): string {
	return `kisws:${ctx.owner}:${ctx.creds.env}:${createHash("sha256").update(ctx.creds.appKey).digest("hex").slice(0, 16)}`;
}

/** 웹소켓 접속키 — REST 토큰과 같은 저장소(D1)에 23시간 캐시한다 */
export async function getApprovalKey(ctx: KisContext): Promise<string> {
	const name = approvalKeyName(ctx);
	const cached = await ctx.store.get(name);
	if (cached && cached.expiresAt > Date.now()) return cached.token;
	return issueOnce(name, async () => {
		const res = await fetch(`${baseUrl(ctx.creds.env)}/oauth2/Approval`, {
			method: "POST",
			headers: { "content-type": "application/json; charset=UTF-8" },
			// 규격의 필드 이름은 secretkey (값은 앱시크릿)
			body: JSON.stringify({ grant_type: "client_credentials", appkey: ctx.creds.appKey, secretkey: ctx.creds.appSecret }),
			signal: AbortSignal.timeout(15_000),
		});
		const text = await res.text();
		let key: unknown;
		try {
			key = (JSON.parse(text) as { approval_key?: unknown }).approval_key;
		} catch {
			/* 아래에서 처리 */
		}
		if (typeof key !== "string" || !key) {
			throw new KisError(`실시간 접속키 발급 실패 (HTTP ${res.status}): ${text.replaceAll(ctx.creds.appSecret, "****").slice(0, 200)}`, { status: res.status, api: "oauth2/Approval" });
		}
		await ctx.store.set(name, { token: key, expiresAt: Date.now() + APPROVAL_TTL_MS });
		return key;
	});
}

// ── 프레임 (순수) ───────────────────────────────────────────

export type Frame =
	| { kind: "data"; trId: string; encrypted: boolean; records: string[][] }
	| { kind: "system"; trId: string; trKey: string; rtCd: string; msg: string }
	| { kind: "ping" };

/** 프레임 한 개를 읽는다. fieldCount 는 해당 TR 의 필드 수 (여러 건 자르기용) */
export function parseFrame(raw: string, fieldCount: (trId: string) => number): Frame | null {
	if (!raw) return null;
	if (raw[0] === "0" || raw[0] === "1") {
		const parts = raw.split("|");
		if (parts.length < 4) return null;
		const trId = parts[1]!;
		const count = Math.max(1, Number.parseInt(parts[2]!, 10) || 1);
		const values = parts.slice(3).join("|").split("^");
		const n = fieldCount(trId);
		const records: string[][] = [];
		if (count > 1 && n > 0 && values.length >= n * count) {
			for (let i = 0; i < count; i++) records.push(values.slice(i * n, (i + 1) * n));
		} else records.push(values);
		return { kind: "data", trId, encrypted: parts[0] === "1", records };
	}
	if (raw[0] === "{") {
		let j: { header?: { tr_id?: string; tr_key?: string }; body?: { rt_cd?: string; msg1?: string } };
		try {
			j = JSON.parse(raw);
		} catch {
			return null;
		}
		if (j.header?.tr_id === "PINGPONG") return { kind: "ping" };
		return { kind: "system", trId: j.header?.tr_id ?? "", trKey: j.header?.tr_key ?? "", rtCd: j.body?.rt_cd ?? "", msg: j.body?.msg1 ?? "" };
	}
	return null;
}

export function subscribeMessage(approvalKey: string, trId: string, trKey: string, on: boolean): string {
	return JSON.stringify({
		header: { approval_key: approvalKey, custtype: "P", tr_type: on ? "1" : "2", "content-type": "utf-8" },
		body: { input: { tr_id: trId, tr_key: trKey } },
	});
}

// ── 구독 ────────────────────────────────────────────────────

export interface StreamSub {
	key: string;
	api: WsApi;
	trKey: string;
	records: string[][];
	/** 구독 응답 — 성공이면 true, 거절이면 오류 메시지 */
	subscribed: boolean;
	error?: string;
}

export interface StreamResult {
	subs: StreamSub[];
	seconds: number;
	closedBy: "timeout" | "server" | "error";
	error?: string;
}

/** 테스트가 가짜를 넣는다 — 브라우저 WebSocket 과 같은 모양의 최소 부분 */
export interface WsLike {
	readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}
export type WsFactory = (url: string) => WsLike;

const defaultFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

/** 프레임의 종목 칸(첫 필드)으로 어느 구독인지 가린다 — 같은 TR 을 여러 종목 구독할 때 */
function matchSub(subs: StreamSub[], trId: string, rec: string[]): StreamSub | undefined {
	const same = subs.filter((s) => s.api.trId === trId);
	if (same.length <= 1) return same[0];
	const head = (rec[0] ?? "").trim().toUpperCase();
	return same.find((s) => s.trKey.toUpperCase() === head) ?? same.find((s) => head.endsWith(s.trKey.toUpperCase()) || s.trKey.toUpperCase().endsWith(head));
}

const locks = new Map<string, Promise<unknown>>();
async function streamLock<T>(lane: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(lane) ?? Promise.resolve();
	const run = prev.catch(() => {}).then(fn);
	const tail = run.catch(() => {});
	locks.set(lane, tail);
	try {
		return await run;
	} finally {
		if (locks.get(lane) === tail) locks.delete(lane);
	}
}

export async function streamKis(
	ctx: KisContext,
	requests: Array<{ api: string; key: string }>,
	opts: { seconds: number; factory?: WsFactory },
): Promise<StreamResult> {
	if (requests.length === 0) throw new Error("구독할 대상이 없습니다.");
	if (requests.length > WS_MAX_SUBS) throw new Error(`한 번에 ${WS_MAX_SUBS}개까지 구독할 수 있습니다.`);
	const subs: StreamSub[] = requests.map((r) => {
		const hit = resolveWsApi(r.api);
		if (!hit) throw new Error(`없는 실시간 API: "${r.api}" — kis_stream { find } 로 찾으세요.`);
		const trKey = r.key.trim();
		if (!trKey) throw new Error(`${hit.api.name}: 종목코드(key)가 필요합니다 — ${hit.api.keyDesc.split("\n")[0]}`);
		return { key: hit.key, api: hit.api, trKey, records: [], subscribed: false };
	});
	const seconds = Math.min(WS_MAX_SECONDS, Math.max(1, Math.round(opts.seconds)));
	const fieldCount = (trId: string): number => subs.find((s) => s.api.trId === trId)?.api.fields.length ?? 0;
	const approval = await getApprovalKey(ctx);
	const factory = opts.factory ?? defaultFactory;

	return streamLock(ctx.creds.appKey, () =>
		new Promise<StreamResult>((resolve) => {
			let ws: WsLike;
			let settled = false;
			let opened = false;
			let closedBy: StreamResult["closedBy"] = "server";
			let error: string | undefined;
			const timers: Array<ReturnType<typeof setTimeout>> = [];

			const finish = (): void => {
				if (settled) return;
				settled = true;
				for (const t of timers) clearTimeout(t);
				try {
					ws.close(1000, "done");
				} catch {
					/* 이미 닫힘 */
				}
				resolve({ subs, seconds, closedBy, ...(error ? { error } : {}) });
			};
			try {
				ws = factory(WS_URL[ctx.creds.env]);
			} catch (e) {
				resolve({ subs, seconds, closedBy: "error", error: `연결 실패: ${(e as Error).message}` });
				return;
			}
			timers.push(
				setTimeout(() => {
					if (opened) return;
					closedBy = "error";
					error = "실시간 서버 연결 시간 초과 (10초)";
					finish();
				}, 10_000),
			);
			ws.onopen = () => {
				opened = true;
				for (const s of subs) ws.send(subscribeMessage(approval, s.api.trId, s.trKey, true));
				timers.push(
					setTimeout(() => {
						closedBy = "timeout";
						for (const s of subs) {
							try {
								ws.send(subscribeMessage(approval, s.api.trId, s.trKey, false));
							} catch {
								/* 끊김 */
							}
						}
						// 해제 메시지가 나갈 틈을 준다
						timers.push(setTimeout(finish, 200));
					}, seconds * 1000),
				);
			};
			ws.onmessage = (ev) => {
				if (settled || typeof ev.data !== "string") return;
				const f = parseFrame(ev.data, fieldCount);
				if (!f) return;
				if (f.kind === "ping") {
					try {
						ws.send(ev.data);
					} catch {
						/* 끊김 */
					}
					return;
				}
				if (f.kind === "system") {
					const s = subs.find((x) => x.api.trId === f.trId && (!f.trKey || x.trKey.toUpperCase() === f.trKey.toUpperCase())) ?? subs.find((x) => x.api.trId === f.trId);
					if (!s) return;
					if (f.rtCd === "0") s.subscribed = true;
					else if (f.rtCd !== "" && closedBy !== "timeout") {
						// 해제 응답·중복 구독 안내는 오류가 아니다
						if (/ALREADY IN SUBSCRIBE/i.test(f.msg)) s.subscribed = true;
						else s.error = f.msg || `거절 (rt_cd ${f.rtCd})`;
					}
					if (subs.every((x) => x.error)) {
						closedBy = "error";
						error = subs.map((x) => x.error).join(" / ");
						finish();
					}
					return;
				}
				if (f.encrypted) return;
				for (const rec of f.records) {
					const s = matchSub(subs, f.trId, rec);
					if (s && s.records.length < WS_MAX_RECORDS) s.records.push(rec);
				}
			};
			ws.onerror = () => {
				if (!opened) {
					closedBy = "error";
					error = "실시간 서버에 연결하지 못했습니다";
					finish();
				}
			};
			ws.onclose = () => finish();
		}),
	);
}

// ── 요약 (순수) ─────────────────────────────────────────────

const PRICE_CODES = ["STCK_PRPR", "FUTS_PRPR", "OPTN_PRPR", "PRPR_NMIX", "LAST", "LAST_PRICE", "NAV", "ANTC_CNPR"];
const VOLUME_CODES = ["CNTG_VOL", "LAST_CNQN", "EVOL", "LAST_QNTT", "ANTC_CNQN"];
const TIME_CODES = ["STCK_CNTG_HOUR", "KHMS", "BSOP_HOUR", "RECV_TIME", "TRNM_HOUR"];
/** 체결 방향 칸 — 값 → 매수/매도 */
const SIDE_CODES: Record<string, { buy: string; sell: string }> = { CCLD_DVSN: { buy: "1", sell: "5" }, QUOTSIGN: { buy: "2", sell: "5" } };

const LADDER = {
	askP: /^(?:FUTS_|OPTN_)?ASKP(\d+)$|^PASK(\d+)$|^ASK_PRICE_(\d+)$/,
	bidP: /^(?:FUTS_|OPTN_)?BIDP(\d+)$|^PBID(\d+)$|^BID_PRICE_(\d+)$/,
	askQ: /^ASKP_RSQN(\d+)$|^VASK(\d+)$|^ASK_QNTT_(\d+)$/,
	bidQ: /^BIDP_RSQN(\d+)$|^VBID(\d+)$|^BID_QNTT_(\d+)$/,
};
const level = (re: RegExp, code: string): number | null => {
	const m = re.exec(code.toUpperCase());
	return m ? Number(m.slice(1).find((x) => x !== undefined)) : null;
};

const num = (v: string | undefined): number | null => {
	if (v === undefined) return null;
	const t = v.trim();
	if (t === "" || !/^[+-]?\d*\.?\d+$/.test(t)) return null;
	return Number(t);
};
const fmt = (n: number): string => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));
const clock = (v: string | undefined): string => {
	const t = (v ?? "").trim();
	return /^\d{6}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t;
};

export interface StreamSummary {
	count: number;
	first?: string;
	last?: string;
	price?: { field: string; open: number; high: number; low: number; close: number };
	volume?: { field: string; total: number; buy: number | null; sell: number | null };
	ladder?: Array<{ level: number; ask: string; askQty: string; bid: string; bidQty: string }>;
	/** 마지막 건 — [한글명, 값] (호가 칸은 ladder 로 빠진다) */
	latest: Array<[string, string]>;
}

export function summarizeStream(api: WsApi, records: string[][]): StreamSummary {
	const codes = api.fields.map((f) => f[0].toUpperCase());
	const idx = (list: string[]): number => {
		for (const c of list) {
			const i = codes.indexOf(c);
			if (i >= 0) return i;
		}
		return -1;
	};
	const out: StreamSummary = { count: records.length, latest: [] };
	if (records.length === 0) return out;
	const ti = idx(TIME_CODES);
	if (ti >= 0) {
		out.first = clock(records[0]![ti]);
		out.last = clock(records.at(-1)![ti]);
	}
	const pi = idx(PRICE_CODES);
	if (pi >= 0) {
		const ps = records.map((r) => num(r[pi])).filter((x): x is number => x !== null && x !== 0);
		if (ps.length > 0) out.price = { field: api.fields[pi]![1], open: ps[0]!, high: Math.max(...ps), low: Math.min(...ps), close: ps.at(-1)! };
	}
	const vi = idx(VOLUME_CODES);
	if (vi >= 0) {
		const sideCode = Object.keys(SIDE_CODES).find((c) => codes.includes(c));
		const si = sideCode ? codes.indexOf(sideCode) : -1;
		let total = 0;
		let buy = 0;
		let sell = 0;
		for (const r of records) {
			const v = num(r[vi]) ?? 0;
			total += v;
			if (si >= 0 && sideCode) {
				const s = (r[si] ?? "").trim();
				if (s === SIDE_CODES[sideCode]!.buy) buy += v;
				else if (s === SIDE_CODES[sideCode]!.sell) sell += v;
			}
		}
		out.volume = { field: api.fields[vi]![1], total, buy: si >= 0 ? buy : null, sell: si >= 0 ? sell : null };
	}
	const last = records.at(-1)!;
	const ladder = new Map<number, { ask: string; askQty: string; bid: string; bidQty: string }>();
	const inLadder = new Set<number>();
	codes.forEach((c, i) => {
		for (const [k, re] of Object.entries(LADDER) as Array<[keyof typeof LADDER, RegExp]>) {
			const lv = level(re, c);
			if (lv === null) continue;
			const row = ladder.get(lv) ?? { ask: "", askQty: "", bid: "", bidQty: "" };
			const v = (last[i] ?? "").trim();
			if (k === "askP") row.ask = v;
			else if (k === "bidP") row.bid = v;
			else if (k === "askQ") row.askQty = v;
			else row.bidQty = v;
			ladder.set(lv, row);
			inLadder.add(i);
		}
	});
	// 1단 호가만 있는 체결 TR 은 표로 빼지 않는다 (마지막 건 목록에 둔다)
	if (ladder.size >= 3) {
		out.ladder = [...ladder.entries()].sort((a, b) => a[0] - b[0]).map(([lv, r]) => ({ level: lv, ...r }));
	} else inLadder.clear();
	api.fields.forEach((f, i) => {
		if (inLadder.has(i)) return;
		const v = (last[i] ?? "").trim();
		if (v === "") return;
		out.latest.push([f[1], v]);
	});
	return out;
}

export function renderStream(r: StreamResult): string {
	const blocks: string[] = [];
	for (const s of r.subs) {
		const head = `[실시간] ${s.api.name} · ${s.trKey} · ${r.seconds}초 구독`;
		if (s.error) {
			blocks.push(`${head}\n구독 실패: ${s.error}`);
			continue;
		}
		const sum = summarizeStream(s.api, s.records);
		if (sum.count === 0) {
			blocks.push(
				`${head} · 수신 0건 (${s.subscribed ? "구독은 성공" : "구독 응답 없음"})\n` +
					"이 시간 동안 체결·호가 변화가 없었습니다 — 장 시간이 아니거나(휴장일 포함, 국내 정규장 09:00~15:30), 거래가 드문 종목이거나, 종목코드 형식이 다를 수 있습니다." +
					`\n코드 형식: ${s.api.keyDesc.split("\n").slice(0, 3).join(" ")}`,
			);
			continue;
		}
		const lines = [`${head} · ${sum.count}건${sum.first ? ` (${sum.first}~${sum.last})` : ""}${s.records.length >= WS_MAX_RECORDS ? ` — ${WS_MAX_RECORDS}건에서 자름` : ""}`];
		if (sum.price) {
			const ch = sum.price.open ? ((sum.price.close - sum.price.open) / sum.price.open) * 100 : 0;
			lines.push(
				`- ${sum.price.field}: 처음 ${fmt(sum.price.open)} → 마지막 ${fmt(sum.price.close)} (${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%) · 구간 고가 ${fmt(sum.price.high)} · 저가 ${fmt(sum.price.low)}`,
			);
		}
		if (sum.volume) {
			const { buy, sell, total } = sum.volume;
			const split = buy !== null && sell !== null && buy + sell > 0 ? ` · 매수 체결 ${fmt(buy)} / 매도 체결 ${fmt(sell)} (매수 ${Math.round((buy / (buy + sell)) * 100)}%)` : "";
			lines.push(`- 구간 ${sum.volume.field} 합계 ${fmt(total)}${split}`);
		}
		if (sum.ladder) {
			lines.push("- 호가 (마지막 수신 시점)", "  | 단계 | 매도호가 | 매도잔량 | 매수호가 | 매수잔량 |", "  |---|---|---|---|---|");
			for (const l of sum.ladder) lines.push(`  | ${l.level} | ${l.ask} | ${l.askQty} | ${l.bid} | ${l.bidQty} |`);
		}
		lines.push(`- 마지막 수신 값: ${sum.latest.map(([k, v]) => `${k}=${v}`).join(" · ")}`);
		blocks.push(lines.join("\n"));
	}
	if (r.error && r.subs.every((s) => !s.error)) blocks.push(`⚠️ ${r.error}`);
	return blocks.join("\n\n");
}
