/**
 * 네트워크 경계 — 사용자가 입력한 URL 로 **서버가** 요청을 보낸다.
 *
 * 그대로 fetch 하면 SSRF 다: 공유 서버 안에서 `http://127.0.0.1:8080`, 클라우드 메타데이터
 * (`169.254.169.254`), 사설망 장비를 사용자 입력으로 두드릴 수 있다. 그래서
 *   - https 만 (개발용 AF_MCP_ALLOW_PRIVATE=1 일 때만 http·사설 주소 허용)
 *   - DNS 로 **해석된 주소**를 연결 직전에 검사한다 (호스트 이름만 보면 사설 IP 를 가리키는 도메인에 뚫린다).
 *     검사와 연결이 같은 lookup 이라 DNS 리바인딩(검사 때와 연결 때 다른 주소)도 통하지 않는다.
 *   - 리다이렉트를 따라가지 않는다 (공개 주소 → 내부 주소로 튕기기 차단)
 *
 * MCP 서버 URL 뿐 아니라 OAuth 메타데이터·토큰 엔드포인트도 원격 서버가 알려준 주소라 같은 경로를 탄다.
 */
import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export class McpUrlError extends Error {}

/** fetch 와 같은 모양 — 테스트는 가짜를 넣는다 */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface NetPolicy {
	/** 개발용 — http·localhost·사설 주소 허용 */
	allowPrivate: boolean;
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8],
	["169.254.0.0", 16], // 링크 로컬 · 클라우드 메타데이터
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4], // 멀티캐스트
	["240.0.0.0", 4],
] as const) {
	BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7], // ULA
	["fe80::", 10], // 링크 로컬
	["ff00::", 8],
	["64:ff9b::", 96], // NAT64 — 내부 IPv4 로 번역될 수 있다
] as const) {
	BLOCKED.addSubnet(net, prefix, "ipv6");
}

/**
 * 공인 주소가 아니면 true.
 * IPv4-mapped IPv6(::ffff:10.0.0.1, 16진 ::ffff:a00:1)는 BlockList 가 IPv4 규칙으로 판정한다 (Node 24 확인).
 */
export function isPrivateAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return BLOCKED.check(ip, "ipv4");
	if (family === 6) return BLOCKED.check(ip, "ipv6");
	return true; // IP 가 아니면 판단 불가 — 막는다
}

/**
 * 사용자 입력 URL 검증. 사람이 읽을 수 있는 이유로 실패한다 (설정 화면에 그대로 뜬다).
 * DNS 검사는 여기서 하지 않는다 — 연결 시점에 한다 (safeFetch).
 */
export function parseRemoteUrl(raw: string, policy: NetPolicy): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new McpUrlError("URL 형식이 아닙니다");
	}
	if (url.protocol !== "https:" && !(policy.allowPrivate && url.protocol === "http:")) {
		throw new McpUrlError("https 주소만 쓸 수 있습니다 (원격 MCP 서버)");
	}
	if (url.username || url.password) throw new McpUrlError("주소에 계정 정보를 넣을 수 없습니다 — 인증은 헤더·OAuth 로");
	url.hash = "";
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!policy.allowPrivate) {
		if (isIP(host) && isPrivateAddress(host)) throw new McpUrlError("사설·내부 주소는 쓸 수 없습니다");
		if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new McpUrlError("내부 호스트는 쓸 수 없습니다");
	}
	return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 해석된 주소 중 하나라도 사설이면 연결하지 않는다 (http.request 의 lookup 자리 — 연결과 같은 해석 결과를 쓴다) */
export function guardedLookup(hostname: string, options: LookupAllOptions | Record<string, unknown>, cb: LookupCb): void {
	lookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
		if (err) return cb(err, []);
		const bad = addresses.find((a) => isPrivateAddress(a.address));
		if (bad) {
			const e = new Error(`내부 주소로 해석되는 호스트입니다 (${hostname})`) as NodeJS.ErrnoException;
			e.code = "EPRIVATE";
			return cb(e, []);
		}
		if ((options as { all?: boolean }).all) return cb(null, addresses);
		const first = addresses[0];
		if (!first) return cb(Object.assign(new Error(`주소 없음: ${hostname}`), { code: "ENOTFOUND" }), []);
		cb(null, first.address, first.family);
	});
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "AlphaFolio/1.0 (MCP client)";

/**
 * SSRF 방어 fetch. 응답 본문은 스트림 그대로 돌려준다 (SSE 를 끝까지 버퍼링하지 않게).
 * 본문이 8MB 를 넘으면 끊는다.
 */
export function createSafeFetch(policy: NetPolicy): FetchLike {
	return (raw, init) =>
		new Promise<Response>((resolve, reject) => {
			let url: URL;
			try {
				url = parseRemoteUrl(raw, policy);
			} catch (err) {
				reject(err);
				return;
			}
			const request = url.protocol === "https:" ? httpsRequest : httpRequest;
			const req = request(
				url,
				{
					method: init.method,
					headers: {
						// UA 가 없으면 TradingView 앞단(WAF)이 403 HTML 을 준다 (실측 2026-09-24)
						"user-agent": USER_AGENT,
						...init.headers,
						...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}),
					},
					...(policy.allowPrivate ? {} : { lookup: guardedLookup as never }),
					signal: init.signal,
				},
				(res: IncomingMessage) => {
					let seen = 0;
					res.on("data", (chunk: Buffer) => {
						seen += chunk.length;
						if (seen > MAX_BODY_BYTES) res.destroy(new Error("응답이 너무 큽니다 (8MB 초과)"));
					});
					const headers = new Headers();
					for (const [k, v] of Object.entries(res.headers)) {
						if (v === undefined) continue;
						for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
					}
					const status = res.statusCode ?? 502;
					// 204·304 등 본문 없는 상태는 Response 생성자가 본문을 거부한다
					const noBody = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
					if (noBody) res.resume();
					resolve(
						new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
							status,
							statusText: res.statusMessage ?? "",
							headers,
						}),
					);
				},
			);
			req.on("error", reject);
			if (init.body !== undefined) req.write(init.body);
			req.end();
		});
}
