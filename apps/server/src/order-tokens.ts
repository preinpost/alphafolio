/**
 * 주문 확인 토큰 — 사람의 클릭 없이는 주문이 나가지 않게 한다.
 *
 * 왜 필요한가:
 *   에이전트에게 주문 실행 툴을 주면 **LLM 이 스스로 실제 주문을 낼 수 있다.**
 *   우리는 `web_search`·`market_news` 로 외부의 신뢰할 수 없는 텍스트를 컨텍스트에
 *   넣고 있어서, 기사·웹페이지에 심긴 지시문이 주문으로 이어질 경로가 실재한다.
 *
 * 구조:
 *   1. 에이전트는 `order_prepare` 로 **준비만** 한다 → 서명된 토큰이 담긴 확인 카드
 *   2. 사람이 카드에서 [확인] 클릭 → `POST /api/orders/execute` 가 토큰을 받아 실행
 *
 * 토큰에는 동작(OrderAction — 신규·정정·취소·조건주문) 전체가 담기고 서명돼 있어 모델이 위조·변조할 수 없고,
 * **1회용 + 짧은 만료**라 재사용도 안 된다. nonce 는 브로커의 멱등성 키로도 쓰여
 * 더블클릭·네트워크 재시도가 중복 주문이 되지 않는다.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OrderAction } from "@alphafolio/broker";

export const ORDER_TOKEN_TTL_MS = 2 * 60_000;

export interface OrderTokenPayload {
	/** 토큰을 발급받은 사용자 — 다른 사용자가 쓰지 못하게 검증한다 */
	u: string;
	/** 실행할 동작 전체 — 실행기는 이 값만 보고 증권사·API 를 고른다 */
	action: OrderAction;
	/** epoch ms */
	exp: number;
	/** 1회용 식별자 = 브로커 멱등성 키 (토스 clientOrderId) */
	nonce: string;
}

function sign(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

/** 서명 토큰 공통 필드 — 주문 외의 확인 카드(MCP 쓰기, PLAN §39)도 같은 구조를 쓴다 (서명 키는 용도별로 다르다) */
export interface SignedPayload {
	u: string;
	exp: number;
	nonce: string;
}

export function createOrderToken<P extends { u: string } = Omit<OrderTokenPayload, "exp" | "nonce">>(
	payload: P,
	secret: string,
	now = Date.now(),
): { token: string; payload: P & { exp: number; nonce: string } } {
	const full = {
		...payload,
		exp: now + ORDER_TOKEN_TTL_MS,
		// 토스 clientOrderId 제약: 최대 36자, 영숫자·-·_
		nonce: `af${randomBytes(12).toString("hex")}`,
	};
	const body = Buffer.from(JSON.stringify(full)).toString("base64url");
	return { token: `${body}.${sign(body, secret)}`, payload: full };
}

export type VerifyFailure =
	| "malformed"
	| "bad-signature"
	| "expired"
	| "used"
	| "wrong-user";

export type VerifyResult<P extends SignedPayload = OrderTokenPayload> =
	| { ok: true; payload: P }
	| { ok: false; reason: VerifyFailure };

/**
 * 사용된 nonce. 메모리에만 둔다 — 재시작하면 기존 토큰이 무효가 되는데,
 * 어차피 2분짜리라 실질 영향이 없고 저장소를 늘릴 이유도 없다.
 */
export class OrderTokenGuard<P extends SignedPayload = OrderTokenPayload> {
	private readonly used = new Map<string, number>();
	private lastSweep = Date.now();

	verify(token: string | undefined, secret: string, user: string, now = Date.now()): VerifyResult<P> {
		if (!token) return { ok: false, reason: "malformed" };

		const dot = token.lastIndexOf(".");
		if (dot <= 0) return { ok: false, reason: "malformed" };

		const body = token.slice(0, dot);
		const mac = token.slice(dot + 1);
		if (!safeEqual(mac, sign(body, secret))) return { ok: false, reason: "bad-signature" };

		let payload: P;
		try {
			payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as P;
		} catch {
			return { ok: false, reason: "malformed" };
		}

		if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
		// 서명이 맞아도 다른 사용자의 토큰이면 거절한다 (가구 구성원 간에도)
		if (payload.u !== user) return { ok: false, reason: "wrong-user" };
		if (this.used.has(payload.nonce)) return { ok: false, reason: "used" };

		return { ok: true, payload };
	}

	/**
	 * 실행 직전에 소비한다. **주문을 보내기 전에** 호출해야 더블클릭이 두 번
	 * 나가지 않는다 (실패해도 재사용을 허용하지 않는 쪽이 안전하다).
	 */
	consume(nonce: string, now = Date.now()): void {
		this.sweep(now);
		this.used.set(nonce, now + ORDER_TOKEN_TTL_MS);
	}

	private sweep(now: number): void {
		if (now - this.lastSweep < 60_000) return;
		this.lastSweep = now;
		for (const [nonce, expiresAt] of this.used) {
			if (expiresAt < now) this.used.delete(nonce);
		}
	}
}

export function failureMessage(reason: VerifyFailure): string {
	switch (reason) {
		case "expired":
			return "주문 확인 시간이 지났습니다 (2분). 다시 요청해 주세요.";
		case "used":
			return "이미 처리된 주문입니다.";
		case "wrong-user":
			return "다른 사용자의 주문 확인입니다.";
		default:
			return "주문 확인 정보가 올바르지 않습니다.";
	}
}
