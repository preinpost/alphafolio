/**
 * 알림 모듈 · 텔레그램 채널 테스트 (PLAN §40).
 *
 * 핵심: ① 사용자가 저장한 값만 쓴다 (env 봇 토큰으로 모든 사람의 알림이 한 채팅에 가지 않게)
 * ② 토큰이 오류 메시지에 새지 않는다 (URL 경로에 들어간다) ③ 개인 채팅만 고른다 ④ 채널 실패가 던지지 않는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Notifier, TELEGRAM_CHAT, TELEGRAM_TOKEN } from "../src/notify/index.ts";
import { botIdOf, describeNetError, escapeHtml, findPrivateChat, getBotName, isBotToken, sendMessage, TelegramError } from "../src/notify/telegram.ts";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";

/** 가짜 api.telegram.org — 호출 기록 + 메서드별 응답 */
function fakeTelegram(replies: Record<string, { status?: number; body: unknown } | (() => never)>) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
		const method = url.split("/").pop() as string;
		const r = replies[method];
		if (typeof r === "function") r();
		if (!r) return new Response(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }), { status: 404 });
		return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

function secretsOf(user: Record<string, string>, env: Record<string, string> = {}) {
	return {
		get: (name: string) => user[name] ?? env[name],
		sourceOf: (name: string) => (user[name] ? "user" : env[name] ? "env" : "none") as "user" | "env" | "none",
	};
}

describe("텔레그램 채널", () => {
	it("봇 토큰 모양", () => {
		assert.equal(isBotToken(TOKEN), true);
		assert.equal(isBotToken(` ${TOKEN} `), true);
		assert.equal(isBotToken("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"), false);
		assert.equal(isBotToken("12:short"), false);
	});

	it("sendMessage: 고정 주소, HTML, 링크 미리보기 끔", async () => {
		const t = fakeTelegram({ sendMessage: { body: { ok: true, result: {} } } });
		await sendMessage(TOKEN, "42", "<b>hi</b>", { fetch: t.fetch });
		assert.equal(t.calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
		assert.deepEqual(t.calls[0]?.body, { chat_id: "42", text: "<b>hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
	});

	it("오류 메시지에 토큰이 남지 않고, 흔한 원인을 안내한다", async () => {
		const t = fakeTelegram({ sendMessage: { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` } } });
		await assert.rejects(sendMessage(TOKEN, "42", "x", { fetch: t.fetch }), (e: unknown) => {
			assert.ok(e instanceof TelegramError);
			assert.doesNotMatch(e.message, new RegExp(TOKEN.split(":")[1] as string));
			assert.match(e.message, /<봇 토큰>/);
			assert.match(e.message, /봇 토큰이 올바르지 않습니다/);
			return true;
		});
		// 네트워크 오류 (URL 이 메시지에 섞이는 경우)
		const boom = fakeTelegram({
			sendMessage: () => {
				throw new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`);
			},
		});
		await assert.rejects(sendMessage(TOKEN, "42", "x", { fetch: boom.fetch }), (e: unknown) => e instanceof TelegramError && !e.message.includes(TOKEN));
		const blocked = fakeTelegram({ sendMessage: { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } } });
		await assert.rejects(sendMessage(TOKEN, "42", "x", { fetch: blocked.fetch }), /먼저 메시지를 보내/);
	});

	it("채팅 찾기: 개인 채팅 중 가장 최근, 그룹은 고르지 않는다", async () => {
		const t = fakeTelegram({
			getUpdates: {
				body: {
					ok: true,
					result: [
						{ update_id: 1, message: { date: 1, chat: { id: 111, type: "private", username: "old" } } },
						{ update_id: 3, message: { date: 3, chat: { id: -999, type: "group" } } },
						{ update_id: 2, message: { date: 2, chat: { id: 222, type: "private", username: "me" } } },
					],
				},
			},
			getMe: { body: { ok: true, result: { username: "alpha_folio_bot" } } },
		});
		assert.deepEqual(await findPrivateChat(TOKEN, { fetch: t.fetch }), { id: "222", name: "@me" });
		assert.equal(await getBotName(TOKEN, { fetch: t.fetch }), "@alpha_folio_bot");
		const empty = fakeTelegram({ getUpdates: { body: { ok: true, result: [{ update_id: 1, message: { date: 1, chat: { id: -5, type: "supergroup" } } }] } } });
		assert.equal(await findPrivateChat(TOKEN, { fetch: empty.fetch }), null);
	});

	it("네트워크 오류는 원인 코드까지 (\"fetch failed\" 만으로는 고칠 수 없다)", () => {
		const aggregate = Object.assign(new Error("fetch failed"), {
			cause: { errors: [{ code: "ETIMEDOUT", address: "149.154.166.110" }, { code: "EHOSTUNREACH", address: "2001:67c:4e8:f004::9" }] },
		});
		assert.equal(describeNetError(aggregate), "fetch failed (ETIMEDOUT 149.154.166.110, EHOSTUNREACH 2001:67c:4e8:f004::9)");
		assert.equal(describeNetError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })), "fetch failed (ENOTFOUND)");
		assert.equal(describeNetError(Object.assign(new Error("x"), { name: "TimeoutError" })), "응답 시간 초과 (10초)");
	});

	it("채팅 id 에 봇 자신의 id 를 넣은 403 은 그렇다고 알려 준다", async () => {
		assert.equal(botIdOf("8501279729:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"), "8501279729");
		const t = fakeTelegram({ sendMessage: { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't send messages to bots" } } });
		await assert.rejects(sendMessage(TOKEN, "123456789", "x", { fetch: t.fetch }), /봇 자신의 id/);
	});

	it("HTML 이스케이프", () => {
		assert.equal(escapeHtml("AT&T <b>"), "AT&amp;T &lt;b&gt;");
	});
});

describe("알림 모듈", () => {
	it("사용자가 저장한 토큰·채팅으로 보낸다 — 제목 굵게, 본문 이스케이프, 앱 링크", async () => {
		const t = fakeTelegram({ sendMessage: { body: { ok: true, result: {} } } });
		const n = new Notifier({ secrets: secretsOf({ [TELEGRAM_TOKEN]: TOKEN, [TELEGRAM_CHAT]: "42" }), publicUrl: "https://af.example.com", telegram: { fetch: t.fetch } });
		assert.deepEqual(n.channels("ms"), ["telegram"]);
		const r = await n.notify("ms", { level: "important", title: "ETH 손절 체결", lines: ["0.84 ETH @ 2,594.2 <USDT>"], path: "/c/abc" });
		assert.deepEqual(r, [{ channel: "telegram", ok: true }]);
		assert.equal(
			t.calls[0]?.body.text,
			'🔔 <b>ETH 손절 체결</b>\n0.84 ETH @ 2,594.2 &lt;USDT&gt;\n<a href="https://af.example.com/c/abc">AlphaFolio 에서 보기</a>',
		);
	});

	it("서버 env 의 토큰·채팅 id 로는 보내지 않는다", async () => {
		const t = fakeTelegram({ sendMessage: { body: { ok: true, result: {} } } });
		const n = new Notifier({ secrets: secretsOf({}, { [TELEGRAM_TOKEN]: TOKEN, [TELEGRAM_CHAT]: "42" }), publicUrl: undefined, telegram: { fetch: t.fetch } });
		assert.deepEqual(n.channels("kim"), []);
		assert.deepEqual(await n.notify("kim", { level: "info", title: "x" }), []);
		assert.equal(t.calls.length, 0);
	});

	it("채널 실패는 던지지 않고 결과로 (체결 결과가 바뀌지 않게)", async () => {
		const t = fakeTelegram({ sendMessage: { status: 403, body: { ok: false, error_code: 403, description: "Forbidden" } } });
		const n = new Notifier({ secrets: secretsOf({ [TELEGRAM_TOKEN]: TOKEN, [TELEGRAM_CHAT]: "42" }), publicUrl: undefined, telegram: { fetch: t.fetch } });
		const [r] = await n.notify("ms", { level: "info", title: "x" });
		assert.equal(r?.ok, false);
		assert.match(r?.error ?? "", /텔레그램 오류 403/);
	});
});
