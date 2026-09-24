/**
 * KIS 실시간 시세 (PLAN §37) — 프레임 읽기·구독 흐름·요약.
 * 웹소켓은 가짜(FakeWs)로 대신한다. 실제 서버 실측은 spike/09-kis-stream.ts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { memoryTokenStore } from "../src/tokens.ts";
import type { KisContext } from "../src/kis/client.ts";
import {
	approvalKeyName,
	getApprovalKey,
	kisWsCatalog,
	parseFrame,
	renderStream,
	resolveWsApi,
	streamKis,
	subscribeMessage,
	summarizeStream,
	WS_MAX_SUBS,
	type WsLike,
} from "../src/kis/stream.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const cat = kisWsCatalog();
const api = (tr: string) => resolveWsApi(tr)!.api;

describe("실시간 카탈로그", () => {
	it("53종 · TR ID 중복 없음 · 체결통보(계좌 알림)는 없다", () => {
		const list = Object.values(cat);
		assert.equal(list.length, 53);
		assert.equal(new Set(list.map((a) => a.trId)).size, 53);
		assert.equal(list.some((a) => /통보/.test(a.name)), false);
		assert.equal(resolveWsApi("H0STCNI0"), null, "국내 체결통보");
	});

	it("필드 순서가 규격 그대로 — 위치로 읽으므로 하나라도 밀리면 값이 뒤섞인다", () => {
		const f = api("H0STCNT0").fields.map((x) => x[0]);
		assert.equal(f.length, 46);
		assert.deepEqual(f.slice(0, 3), ["MKSC_SHRN_ISCD", "STCK_CNTG_HOUR", "STCK_PRPR"]);
		assert.equal(f[12], "CNTG_VOL");
		assert.equal(f[21], "CCLD_DVSN");
		assert.equal(api("HDFSCNT0").fields.length, 26);
		assert.equal(api("h0stasp0").trId, "H0STASP0", "소문자도 찾는다");
	});
});

describe("프레임", () => {
	const count = (tr: string) => cat[resolveWsApi(tr)?.key ?? ""]?.fields.length ?? 0;

	it("데이터 한 건", () => {
		const f = parseFrame("0|H0STCNT0|001|005930^093001^71300", count);
		assert.deepEqual(f, { kind: "data", trId: "H0STCNT0", encrypted: false, records: [["005930", "093001", "71300"]] });
	});

	it("여러 건은 필드 수로 자른다", () => {
		const n = count("H0STCNT0");
		const a = Array.from({ length: n }, (_, i) => `a${i}`);
		const b = Array.from({ length: n }, (_, i) => `b${i}`);
		const f = parseFrame(`0|H0STCNT0|002|${[...a, ...b].join("^")}`, count);
		assert.equal(f?.kind, "data");
		assert.deepEqual(f?.kind === "data" && f.records, [a, b]);
	});

	it("값에 | 가 있어도 자르지 않는다 · 암호화 표시", () => {
		const f = parseFrame("1|H0STCNT0|001|x|y^z", count);
		assert.deepEqual(f?.kind === "data" && [f.encrypted, f.records], [true, [["x|y", "z"]]]);
	});

	it("시스템 메시지·PINGPONG·잡음", () => {
		assert.deepEqual(parseFrame(JSON.stringify({ header: { tr_id: "H0STCNT0", tr_key: "005930" }, body: { rt_cd: "0", msg1: "SUBSCRIBE SUCCESS" } }), count), {
			kind: "system", trId: "H0STCNT0", trKey: "005930", rtCd: "0", msg: "SUBSCRIBE SUCCESS",
		});
		assert.deepEqual(parseFrame(JSON.stringify({ header: { tr_id: "PINGPONG" } }), count), { kind: "ping" });
		assert.equal(parseFrame("", count), null);
		assert.equal(parseFrame("{broken", count), null);
		assert.equal(parseFrame("0|H0STCNT0", count), null);
	});

	it("구독·해제 메시지 — tr_type 1/2", () => {
		const on = JSON.parse(subscribeMessage("APPROVAL", "H0STCNT0", "005930", true));
		assert.deepEqual(on, { header: { approval_key: "APPROVAL", custtype: "P", tr_type: "1", "content-type": "utf-8" }, body: { input: { tr_id: "H0STCNT0", tr_key: "005930" } } });
		assert.equal(JSON.parse(subscribeMessage("APPROVAL", "H0STCNT0", "005930", false)).header.tr_type, "2");
	});
});

// ── 가짜 웹소켓 ──────────────────────────────────────────────

class FakeWs implements WsLike {
	static all: FakeWs[] = [];
	static openNow = 0;
	static maxOpen = 0;
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	sent: string[] = [];
	closed = false;
	readonly url: string;
	readonly script: (ws: FakeWs, msg: { header: { tr_type: string }; body: { input: { tr_id: string; tr_key: string } } }) => void;
	constructor(url: string, script: FakeWs["script"]) {
		this.url = url;
		this.script = script;
		FakeWs.all.push(this);
		FakeWs.openNow++;
		FakeWs.maxOpen = Math.max(FakeWs.maxOpen, FakeWs.openNow);
		setTimeout(() => {
			this.readyState = 1;
			this.onopen?.({});
		}, 5);
	}
	send(data: string): void {
		this.sent.push(data);
		if (data.startsWith("{")) {
			const m = JSON.parse(data);
			if (m.header?.approval_key) this.script(this, m);
		}
	}
	emit(data: string): void {
		this.onmessage?.({ data });
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		FakeWs.openNow--;
		this.readyState = 3;
		setTimeout(() => this.onclose?.({}), 0);
	}
}

const ack = (tr: string, key: string, rt = "0", msg = "SUBSCRIBE SUCCESS") => JSON.stringify({ header: { tr_id: tr, tr_key: key }, body: { rt_cd: rt, msg1: msg } });

function tick(code: string, time: string, price: string, vol: string, side: string): string {
	const f = api("H0STCNT0").fields.map(() => "");
	f[0] = code;
	f[1] = time;
	f[2] = price;
	f[12] = vol;
	f[21] = side;
	return `0|H0STCNT0|001|${f.join("^")}`;
}

function ctxWithApproval(): KisContext {
	const store = memoryTokenStore();
	const ctx: KisContext = { creds: { appKey: `APPKEY${Math.random()}`, appSecret: "APPSECRET-xyz", env: "real" }, store, owner: "tester" };
	void store.set(approvalKeyName(ctx), { token: "APPROVAL-1", expiresAt: Date.now() + 3600_000 });
	return ctx;
}

describe("구독 흐름", () => {
	it("구독 → 수신 → 해제 → 닫기, PINGPONG 은 그대로 돌려준다, 종목별로 나눈다", async () => {
		FakeWs.all = [];
		const r = await streamKis(
			ctxWithApproval(),
			[
				{ api: "H0STCNT0", key: "005930" },
				{ api: "H0STCNT0", key: "000660" },
			],
			{
				seconds: 1,
				factory: (url) =>
					new FakeWs(url, (ws, m) => {
						if (m.header.tr_type !== "1") return;
						const key = m.body.input.tr_key;
						ws.emit(ack("H0STCNT0", key));
						if (key === "005930") {
							ws.emit(tick("005930", "093001", "71300", "10", "1"));
							ws.emit(JSON.stringify({ header: { tr_id: "PINGPONG", datetime: "x" } }));
							ws.emit(tick("005930", "093002", "71400", "5", "5"));
						} else ws.emit(tick("000660", "093001", "180000", "3", "1"));
					}),
			},
		);
		const ws = FakeWs.all[0]!;
		assert.equal(ws.url, "ws://ops.koreainvestment.com:21000");
		const types = ws.sent.filter((s) => s.startsWith("{") && s.includes("approval_key")).map((s) => JSON.parse(s).header.tr_type);
		assert.deepEqual(types, ["1", "1", "2", "2"], "구독 둘 → 해제 둘");
		assert.ok(ws.sent.some((s) => s.includes("PINGPONG")), "PINGPONG 에코");
		assert.ok(ws.closed);
		assert.equal(r.closedBy, "timeout");
		assert.deepEqual(r.subs.map((s) => [s.trKey, s.subscribed, s.records.length]), [["005930", true, 2], ["000660", true, 1]]);
	});

	it("거절된 구독은 오류로 · 전부 거절이면 바로 끝낸다", async () => {
		const t0 = Date.now();
		const r = await streamKis(ctxWithApproval(), [{ api: "HDFFF020", key: "ESZ26" }], {
			seconds: 20,
			factory: (url) => new FakeWs(url, (ws, m) => m.header.tr_type === "1" && ws.emit(ack("HDFFF020", "ESZ26", "9", "SUBSCRIBE ERROR : mci send failed"))),
		});
		assert.ok(Date.now() - t0 < 2000, "20초를 기다리지 않는다");
		assert.equal(r.closedBy, "error");
		assert.match(r.subs[0]!.error ?? "", /mci send failed/);
		assert.match(renderStream(r), /구독 실패: SUBSCRIBE ERROR/);
	});

	it("같은 앱키는 한 번에 한 연결 — 두 번째는 앞의 것이 끝난 뒤 연다 (KIS 가 앞 연결을 끊는다)", async () => {
		FakeWs.openNow = 0;
		FakeWs.maxOpen = 0;
		const ctx = ctxWithApproval();
		const factory = (url: string) => new FakeWs(url, (ws, m) => m.header.tr_type === "1" && ws.emit(ack(m.body.input.tr_id, m.body.input.tr_key)));
		await Promise.all([
			streamKis(ctx, [{ api: "H0STCNT0", key: "005930" }], { seconds: 1, factory }),
			streamKis(ctx, [{ api: "H0STASP0", key: "005930" }], { seconds: 1, factory }),
		]);
		assert.equal(FakeWs.maxOpen, 1);
	});

	it("입력 검증 — 없는 TR·빈 종목코드·개수 초과는 연결 전에 거절", async () => {
		const ctx = ctxWithApproval();
		const factory = () => assert.fail("연결하면 안 된다");
		await assert.rejects(streamKis(ctx, [{ api: "H0STCNI0", key: "x" }], { seconds: 1, factory }), /없는 실시간 API/);
		await assert.rejects(streamKis(ctx, [{ api: "H0STCNT0", key: " " }], { seconds: 1, factory }), /종목코드/);
		const many = Array.from({ length: WS_MAX_SUBS + 1 }, () => ({ api: "H0STCNT0", key: "005930" }));
		await assert.rejects(streamKis(ctx, many, { seconds: 1, factory }), /까지/);
	});
});

describe("접속키", () => {
	it("발급은 한 번 — 캐시 재사용, 규격 필드(secretkey), 오류에서 시크릿을 지운다", async () => {
		const bodies: string[] = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			assert.match(String(input), /\/oauth2\/Approval$/);
			bodies.push(String(init?.body));
			return new Response(JSON.stringify({ approval_key: "AK-123" }));
		}) as typeof fetch;
		const ctx: KisContext = { creds: { appKey: "APPKEY-1", appSecret: "SECRET-abcdef", env: "real" }, store: memoryTokenStore(), owner: "u" };
		assert.equal(await getApprovalKey(ctx), "AK-123");
		assert.equal(await getApprovalKey(ctx), "AK-123");
		assert.equal(bodies.length, 1);
		assert.deepEqual(JSON.parse(bodies[0]!), { grant_type: "client_credentials", appkey: "APPKEY-1", secretkey: "SECRET-abcdef" });

		globalThis.fetch = (async () => new Response('{"error":"bad secretkey SECRET-zzzzzz"}', { status: 403 })) as typeof fetch;
		const other: KisContext = { creds: { appKey: "APPKEY-2", appSecret: "SECRET-zzzzzz", env: "real" }, store: memoryTokenStore(), owner: "u" };
		await assert.rejects(getApprovalKey(other), (e: Error) => /접속키 발급 실패/.test(e.message) && !e.message.includes("SECRET-zzzzzz"));
	});
});

describe("요약", () => {
	it("체결: 구간 시가·고가·저가·마지막, 체결량 합과 매수/매도 체결 (체결구분 1=매수, 5=매도)", () => {
		const a = api("H0STCNT0");
		const rows = [tick("005930", "093001", "71300", "10", "1"), tick("005930", "093002", "71500", "4", "5"), tick("005930", "093003", "71200", "6", "1")].map(
			(t) => t.split("|")[3]!.split("^"),
		);
		const s = summarizeStream(a, rows);
		assert.equal(s.count, 3);
		assert.equal(s.first, "09:30:01");
		assert.equal(s.last, "09:30:03");
		assert.deepEqual(s.price && [s.price.open, s.price.high, s.price.low, s.price.close], [71300, 71500, 71200, 71200]);
		assert.deepEqual(s.volume && [s.volume.total, s.volume.buy, s.volume.sell], [20, 16, 4]);
		assert.match(renderStream({ subs: [{ key: "k", api: a, trKey: "005930", records: rows, subscribed: true }], seconds: 3, closedBy: "timeout" }), /매수 80%/);
	});

	it("호가: 10단계 표로 빼고, 나머지 값은 마지막 건 목록에", () => {
		const a = api("H0STASP0");
		const rec = a.fields.map(([code]) => {
			const m = /^(ASKP|BIDP)(\d+)$/.exec(code) ?? /^(ASKP_RSQN|BIDP_RSQN)(\d+)$/.exec(code);
			if (!m) return code === "MKSC_SHRN_ISCD" ? "005930" : "";
			const lv = Number(m[2]);
			return m[1] === "ASKP" ? String(71000 + lv * 100) : m[1] === "BIDP" ? String(71000 - (lv - 1) * 100) : String(lv * 10);
		});
		const s = summarizeStream(a, [rec]);
		assert.equal(s.ladder?.length, 10);
		assert.deepEqual(s.ladder?.[0], { level: 1, ask: "71100", askQty: "10", bid: "71000", bidQty: "10" });
		assert.equal(s.latest.some(([k]) => k.startsWith("매도호가")), false, "호가 칸은 목록에서 빠진다");
	});

	it("0건 — 장 시간·휴장 안내와 구독 여부", () => {
		const t = renderStream({ subs: [{ key: "k", api: api("H0STCNT0"), trKey: "005930", records: [], subscribed: true }], seconds: 5, closedBy: "timeout" });
		assert.match(t, /수신 0건 \(구독은 성공\)/);
		assert.match(t, /휴장일/);
	});
});
