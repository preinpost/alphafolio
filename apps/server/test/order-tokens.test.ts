/**
 * 주문 확인 토큰 테스트.
 *
 * 이 토큰이 "에이전트는 주문을 낼 수 없다"는 보장의 전부다. 위조·변조·재사용·
 * 타인 사용이 하나라도 뚫리면 LLM 이 실제 주문을 낼 수 있게 되므로, 그 네 가지를
 * 각각 명시적으로 검증한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createOrderToken,
	failureMessage,
	ORDER_TOKEN_TTL_MS,
	OrderTokenGuard,
	type OrderTokenPayload,
} from "../src/order-tokens.ts";

const SECRET = "test-master-secret-0123456789";

function base(): Omit<OrderTokenPayload, "exp" | "nonce"> {
	return {
		u: "ms",
		action: {
			kind: "place",
			broker: "toss",
			symbol: "005930",
			market: "KR",
			currency: "KRW",
			side: "BUY",
			orderType: "LIMIT",
			quantity: 10,
			price: 277_500,
			estimatedAmount: 2_775_000,
		},
	};
}

type Place = Extract<OrderTokenPayload["action"], { kind: "place" }>;
const place = (p: OrderTokenPayload): Place => p.action as Place;

/** 토큰 본문을 바꿔치기한다 (서명은 원본 그대로 둔다). */
function tamper(token: string, mutate: (p: OrderTokenPayload) => void): string {
	const [body, mac] = token.split(".");
	const payload = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8")) as OrderTokenPayload;
	mutate(payload);
	const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${forged}.${mac}`;
}

describe("정상 경로", () => {
	it("발급한 토큰을 같은 사용자가 검증할 수 있다", () => {
		const guard = new OrderTokenGuard();
		const { token, payload } = createOrderToken(base(), SECRET);
		const r = guard.verify(token, SECRET, "ms");

		assert.equal(r.ok, true);
		assert.equal(r.ok && place(r.payload).symbol, "005930");
		assert.equal(r.ok && place(r.payload).quantity, 10);
		assert.equal(r.ok && r.payload.nonce, payload.nonce);
	});

	it("만료 시각이 TTL 안에 있다", () => {
		const now = Date.now();
		const { payload } = createOrderToken(base(), SECRET, now);
		assert.equal(payload.exp, now + ORDER_TOKEN_TTL_MS);
	});

	it("nonce 가 토스 clientOrderId 제약을 만족한다 (36자 이하, 영숫자·-·_)", () => {
		for (let i = 0; i < 50; i++) {
			const { payload } = createOrderToken(base(), SECRET);
			assert.ok(payload.nonce.length <= 36, `nonce 가 너무 길다: ${payload.nonce.length}`);
			assert.match(payload.nonce, /^[a-zA-Z0-9\-_]+$/);
		}
	});

	it("nonce 가 매번 다르다 (멱등성 키로 쓰이므로 충돌하면 안 된다)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(createOrderToken(base(), SECRET).payload.nonce);
		assert.equal(seen.size, 200);
	});
});

describe("변조 차단", () => {
	it("수량을 부풀린 토큰을 거절한다", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET);
		const forged = tamper(token, (p) => {
			place(p).quantity = 10_000;
		});
		const r = guard.verify(forged, SECRET, "ms");
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "bad-signature");
	});

	it("매수를 매도로 바꾼 토큰을 거절한다", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET);
		const forged = tamper(token, (p) => {
			place(p).side = "SELL";
		});
		assert.equal(guard.verify(forged, SECRET, "ms").ok, false);
	});

	it("증권사를 바꾼 토큰을 거절한다 (토스로 준비한 주문을 KIS 로)", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET);
		const forged = tamper(token, (p) => {
			place(p).broker = "kis";
		});
		assert.equal(guard.verify(forged, SECRET, "ms").ok, false);
	});

	it("신규 주문을 취소로 바꾼 토큰을 거절한다 (동작 종류 변조)", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET);
		const forged = tamper(token, (p) => {
			(p.action as { kind: string }).kind = "cancel";
		});
		assert.equal(guard.verify(forged, SECRET, "ms").ok, false);
	});

	it("만료 시각을 늘린 토큰을 거절한다", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET);
		const forged = tamper(token, (p) => {
			p.exp = Date.now() + 86_400_000;
		});
		assert.equal(guard.verify(forged, SECRET, "ms").ok, false);
	});

	it("다른 시크릿으로 만든 토큰을 거절한다", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), "attacker-secret");
		const r = guard.verify(token, SECRET, "ms");
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "bad-signature");
	});

	it("형식이 깨진 값을 거절한다", () => {
		const guard = new OrderTokenGuard();
		for (const bad of ["", "abc", "abc.def", "...", "eyJ9"]) {
			assert.equal(guard.verify(bad, SECRET, "ms").ok, false, `"${bad}" 가 통과되면 안 된다`);
		}
		assert.equal(guard.verify(undefined, SECRET, "ms").ok, false);
	});
});

describe("만료", () => {
	it("만료된 토큰을 거절한다", () => {
		const guard = new OrderTokenGuard();
		const past = Date.now() - ORDER_TOKEN_TTL_MS - 1_000;
		const { token } = createOrderToken(base(), SECRET, past);
		const r = guard.verify(token, SECRET, "ms");
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "expired");
	});

	it("만료 직전에는 통과한다", () => {
		const guard = new OrderTokenGuard();
		const now = Date.now();
		const { token } = createOrderToken(base(), SECRET, now);
		assert.equal(guard.verify(token, SECRET, "ms", now + ORDER_TOKEN_TTL_MS - 1).ok, true);
	});
});

describe("1회용", () => {
	it("소비한 토큰은 다시 쓸 수 없다 (더블클릭·재전송 방어)", () => {
		const guard = new OrderTokenGuard();
		const { token, payload } = createOrderToken(base(), SECRET);

		assert.equal(guard.verify(token, SECRET, "ms").ok, true);
		guard.consume(payload.nonce);

		const second = guard.verify(token, SECRET, "ms");
		assert.equal(second.ok, false);
		assert.equal(second.ok === false && second.reason, "used");
	});

	it("서로 다른 토큰은 독립적이다", () => {
		const guard = new OrderTokenGuard();
		const a = createOrderToken(base(), SECRET);
		const b = createOrderToken(base(), SECRET);

		guard.consume(a.payload.nonce);
		assert.equal(guard.verify(a.token, SECRET, "ms").ok, false);
		assert.equal(guard.verify(b.token, SECRET, "ms").ok, true);
	});
});

describe("사용자 격리", () => {
	it("다른 사용자의 토큰을 거절한다 (가구 구성원 간에도)", () => {
		const guard = new OrderTokenGuard();
		const { token } = createOrderToken(base(), SECRET); // u: "ms"
		const r = guard.verify(token, SECRET, "wife");
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "wrong-user");
	});
});

describe("실패 메시지", () => {
	it("사유마다 사람이 읽을 수 있는 안내를 준다", () => {
		for (const reason of ["expired", "used", "wrong-user", "malformed", "bad-signature"] as const) {
			const msg = failureMessage(reason);
			assert.ok(msg.length > 0);
			// 내부 용어를 그대로 노출하지 않는다
			assert.doesNotMatch(msg, /signature|nonce|hmac/i);
		}
	});
});
