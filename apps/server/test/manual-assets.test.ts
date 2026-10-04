/** 직접 입력 자산 REST — 남의 자산에 닿지 않고, 잘못된 입력은 400 으로 저장되지 않는다. */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ManualAsset } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { HttpError } from "../src/ledger-api.ts";
import { handleManualAssets, ManualAssetStore, MAX_MANUAL_ASSETS } from "../src/manual-assets.ts";

let d1: FakeD1;
let store: ManualAssetStore;

async function call(member: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
	req.method = method;
	return handleManualAssets(req, path, member, store);
}

async function status(p: Promise<unknown>, code: number): Promise<void> {
	await assert.rejects(p, (err: unknown) => {
		assert.ok(err instanceof HttpError, String(err));
		assert.equal(err.status, code, err.message);
		return true;
	});
}

const valid = { name: "주택청약", kind: "deposit", currency: "KRW", amount: 12_000_000, memo: "매달 10만원" };

beforeEach(() => {
	d1 = installFakeD1();
	let t = 0;
	store = new ManualAssetStore(() => d1.cfg, () => new Date(Date.UTC(2026, 9, 4, 0, 0, t++)));
});
afterEach(() => {
	d1.restore();
	d1.db.close();
});

describe("직접 입력 자산", () => {
	it("만들고 · 고치고 · 지운다 — 금액을 고치면 updatedAt 이 바뀐다", async () => {
		const made = (await call("ms", "POST", "/api/assets/manual", valid)) as ManualAsset;
		assert.equal(made.kind, "deposit");
		assert.equal(made.memo, "매달 10만원");

		const fixed = (await call("ms", "PATCH", `/api/assets/manual/${made.id}`, { amount: 12_100_000, memo: "" })) as ManualAsset;
		assert.equal(fixed.amount, 12_100_000);
		assert.equal(fixed.memo, null, "빈 메모는 null");
		assert.equal(fixed.name, "주택청약", "안 보낸 필드는 그대로");
		assert.notEqual(fixed.updatedAt, made.updatedAt);

		assert.deepEqual(((await call("ms", "GET", "/api/assets/manual")) as { items: ManualAsset[] }).items.map((x) => x.amount), [12_100_000]);
		await call("ms", "DELETE", `/api/assets/manual/${made.id}`);
		assert.deepEqual(((await call("ms", "GET", "/api/assets/manual")) as { items: ManualAsset[] }).items, []);
	});

	it("남의 자산은 보이지도 고쳐지지도 지워지지도 않는다 (404)", async () => {
		const mine = (await call("ms", "POST", "/api/assets/manual", valid)) as ManualAsset;
		assert.deepEqual(((await call("eve", "GET", "/api/assets/manual")) as { items: unknown[] }).items, []);
		await status(call("eve", "PATCH", `/api/assets/manual/${mine.id}`, { amount: 0 }), 404);
		await status(call("eve", "DELETE", `/api/assets/manual/${mine.id}`), 404);
		assert.equal(((await store.list("ms"))[0])?.amount, 12_000_000);
	});

	it("잘못된 입력은 400 — 아무것도 저장하지 않는다", async () => {
		for (const bad of [
			{ ...valid, name: "" },
			{ ...valid, name: "x".repeat(61) },
			{ ...valid, kind: "stock" },
			{ ...valid, currency: "JPY" },
			{ ...valid, amount: -1 },
			{ ...valid, amount: "100" },
			{ ...valid, amount: Number.POSITIVE_INFINITY },
			{ ...valid, memo: 3 },
		]) {
			await status(call("ms", "POST", "/api/assets/manual", bad), 400);
		}
		assert.deepEqual(await store.list("ms"), []);
		const made = (await call("ms", "POST", "/api/assets/manual", valid)) as ManualAsset;
		await status(call("ms", "PATCH", `/api/assets/manual/${made.id}`, { kind: "cash" }), 400);
		assert.equal((await store.list("ms"))[0]?.kind, "deposit");
	});

	it(`한 사람 ${MAX_MANUAL_ASSETS}개까지`, async () => {
		for (let i = 0; i < MAX_MANUAL_ASSETS; i++) await store.create("ms", { ...valid, kind: "other", currency: "KRW", name: `n${i}` });
		await status(call("ms", "POST", "/api/assets/manual", valid), 400);
		assert.ok(await call("sj", "POST", "/api/assets/manual", valid), "다른 사람은 따로 센다");
	});

	it("모르는 경로·메서드는 처리하지 않는다", async () => {
		assert.equal(await call("ms", "PUT", "/api/assets/manual"), undefined);
		assert.equal(await call("ms", "GET", "/api/assets/manual/../x"), undefined);
	});
});
