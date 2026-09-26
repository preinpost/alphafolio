/**
 * 텔레그램에서 감시를 **보고 · 멈추고 · 지운다** (PLAN §40). 만들기·켜기·다시 켜기는 AlphaFolio 앱에서만.
 *
 *   /list   감시 목록 + [⏸ 일시정지] [🗑 삭제] 버튼
 *   /stop   비상 정지 (켜진 감시 전부 일시정지) — 한 번 더 확인
 *   삭제    두 번 확인 (손절 감시를 지우면 보호가 사라진다)
 *
 * 받는 방식: 사용자 봇마다 **롱 폴링**(getUpdates) — 공개 엔드포인트가 필요 없다.
 * 인증: 저장된 채팅 id 의 **개인 채팅**에서, 그 사람이 보낸 것만. 나머지는 모두 무시한다 (봇 이름을 아는 남의 명령).
 * 버튼 데이터에는 트리거 id 만 담고, 누를 때마다 WatchOps 가 \"이 사용자의 트리거인가\" 를 다시 확인한다.
 *
 * 재기동하면 텔레그램이 쌓아 둔 메시지가 한꺼번에 온다 — 2분 넘게 지난 명령은 버린다. 확인 버튼은 10분이 지나면 다시 묻는다.
 */
import { kstShort } from "@alphafolio/broker";
import type { WatchSummary } from "@alphafolio/broker/watch-tools";
import { TriggerError } from "../triggers.ts";
import type { WatchOps } from "../watch-api.ts";
import { answerCallback, call, editMessage, escapeHtml, sendMessage, TelegramError, type Buttons, type TelegramDeps } from "./telegram.ts";

const POLL_TIMEOUT_SEC = 25;
const STALE_COMMAND_SEC = 120;
const CONFIRM_TTL_SEC = 600;
const RECONCILE_MS = 30_000;

interface Update {
	update_id: number;
	message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: { id: number } };
	callback_query?: {
		id: string;
		data?: string;
		from: { id: number };
		message?: { message_id: number; date: number; chat: { id: number; type: string } };
	};
}

export interface BotCreds {
	token: string;
	chatId: string;
}

export interface TelegramBotsOptions {
	ops: WatchOps;
	/** 사용자가 직접 저장한 봇 토큰·채팅 id (없으면 null) */
	creds: (user: string) => BotCreds | null;
	users: () => string[];
	publicUrl: string | undefined;
	telegram?: TelegramDeps;
	now?: () => number;
}

const STATE_ICON: Record<WatchSummary["state"], string> = { armed: "🟢", paused: "⏸", done: "✔️", expired: "⌛", off: "⚪" };

/** 목록 메시지 + 버튼 — 순수 함수 (테스트용) */
export function renderList(list: WatchSummary[], publicUrl?: string): { html: string; buttons: Buttons } {
	if (list.length === 0) {
		return { html: `감시가 없습니다. 만들기는 AlphaFolio 에서 합니다${publicUrl ? ` — <a href="${escapeHtml(publicUrl)}">열기</a>` : ""}.`, buttons: [] };
	}
	const lines = list.map((w, i) => {
		const bits = [`발동 ${w.fires}${w.maxFires ? `/${w.maxFires}` : ""}회`, `만료 ${w.expiresAt.slice(5, 10).replace("-", "/")}`];
		if (w.state === "armed" && w.nextEvalAt) bits.push(`다음 평가 ${kstShort(w.nextEvalAt)}`);
		return `${STATE_ICON[w.state]} <b>${i + 1}. ${escapeHtml(w.name)}</b>\n${escapeHtml(w.text)}\n${bits.join(" · ")}`;
	});
	const buttons: Buttons = list.map((w, i) => [
		...(w.state === "armed" ? [{ text: `⏸ ${i + 1} 일시정지`, callback_data: `p:${w.id}` }] : []),
		{ text: `🗑 ${i + 1} 삭제`, callback_data: `d:${w.id}` },
	]);
	const paused = list.some((w) => w.state === "paused");
	return { html: `<b>감시 ${list.length}개</b>\n\n${lines.join("\n\n")}${paused ? "\n\n다시 켜기는 AlphaFolio 앱(설정 → 감시)에서 합니다." : ""}`, buttons };
}

const HELP =
	"<b>AlphaFolio 감시</b>\n/list — 감시 목록 (일시정지·삭제 버튼)\n/stop — 비상 정지 (켜진 감시 전부 일시정지)\n\n감시 만들기·다시 켜기는 AlphaFolio 앱에서 합니다.";

/** 한 사용자의 봇 — 롱 폴링 루프 */
class BotLoop {
	private offset = 0;
	private stopped = false;
	private readonly abort = new AbortController();
	problem: string | null = null;

	readonly user: string;
	readonly creds: BotCreds;
	private readonly o: TelegramBotsOptions;

	constructor(user: string, creds: BotCreds, o: TelegramBotsOptions) {
		this.user = user;
		this.creds = creds;
		this.o = o;
	}

	private now(): number {
		return this.o.now?.() ?? Date.now();
	}

	start(): void {
		void this.run();
	}

	stop(): void {
		this.stopped = true;
		this.abort.abort();
	}

	private async run(): Promise<void> {
		while (!this.stopped) {
			try {
				const updates = await call<Update[]>(
					this.creds.token,
					"getUpdates",
					{ offset: this.offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message", "callback_query"] },
					// 멈추면(stop) 걸어 둔 롱 폴링도 바로 끊는다
					{ fetch: this.o.telegram?.fetch ?? (((u: string, init?: RequestInit) => fetch(u, { ...init, signal: AbortSignal.any([init?.signal ?? this.abort.signal, this.abort.signal]) })) as typeof fetch) },
					(POLL_TIMEOUT_SEC + 10) * 1000,
				);
				this.problem = null;
				for (const u of updates) {
					this.offset = Math.max(this.offset, u.update_id + 1);
					await this.handle(u).catch((err: unknown) => console.warn(`[telegram] 처리 실패 user=${this.user}: ${err instanceof Error ? err.message : err}`));
				}
			} catch (err) {
				if (this.stopped) return;
				const conflict = err instanceof TelegramError && err.code === 409;
				this.problem = conflict ? "다른 곳이 이 봇의 메시지를 읽고 있습니다 (웹훅 또는 다른 프로그램) — 명령을 받을 수 없습니다" : err instanceof Error ? err.message : String(err);
				console.warn(`[telegram] 수신 실패 user=${this.user}: ${this.problem}`);
				await new Promise((r) => setTimeout(r, conflict ? 60_000 : 10_000).unref());
			}
		}
	}

	async handle(u: Update): Promise<void> {
		const chat = this.creds.chatId;
		const nowSec = Math.floor(this.now() / 1000);
		if (u.message) {
			const m = u.message;
			// 저장된 개인 채팅에서, 그 사람이 보낸 것만
			if (String(m.chat.id) !== chat || m.chat.type !== "private" || String(m.from?.id) !== chat) return;
			if (nowSec - m.date > STALE_COMMAND_SEC) return;
			const cmd = (m.text ?? "").trim().split(/[\s@]/)[0]?.toLowerCase() ?? "";
			if (cmd === "/list") {
				const { html, buttons } = renderList(this.o.ops.list(this.user), this.o.publicUrl);
				await sendMessage(this.creds.token, chat, html, this.o.telegram, buttons);
			} else if (cmd === "/stop") {
				const armed = this.o.ops.list(this.user).filter((w) => w.state === "armed").length;
				if (armed === 0) await sendMessage(this.creds.token, chat, "켜진 감시가 없습니다.", this.o.telegram);
				else
					await sendMessage(this.creds.token, chat, `켜진 감시 <b>${armed}개</b>를 모두 일시정지할까요?\n다시 켜기는 앱에서만 할 수 있습니다.`, this.o.telegram, [
						[
							{ text: "⏸ 전부 일시정지", callback_data: "S" },
							{ text: "취소", callback_data: "x" },
						],
					]);
			} else if (cmd === "/help" || cmd === "/start") {
				await sendMessage(this.creds.token, chat, HELP, this.o.telegram);
			} else {
				await sendMessage(this.creds.token, chat, `감시 만들기·바꾸기는 AlphaFolio 에서 합니다${this.o.publicUrl ? ` — <a href="${escapeHtml(this.o.publicUrl)}">열기</a>` : ""}.\n\n${HELP}`, this.o.telegram);
			}
			return;
		}

		const q = u.callback_query;
		if (!q?.message) return;
		if (String(q.from.id) !== chat || String(q.message.chat.id) !== chat || q.message.chat.type !== "private") return;
		const data = q.data ?? "";
		const msgId = q.message.message_id;
		const reply = (text: string, buttons?: Buttons) => editMessage(this.creds.token, chat, msgId, text, this.o.telegram, buttons);
		const stale = nowSec - q.message.date > CONFIRM_TTL_SEC;
		try {
			if (data === "x") {
				await answerCallback(this.creds.token, q.id, "취소했습니다", this.o.telegram);
				await reply("취소했습니다.");
			} else if (data === "S") {
				if (stale) return void (await reply("확인이 오래됐습니다. /stop 을 다시 보내 주세요."));
				const n = await this.o.ops.stopAll(this.user, "telegram");
				await answerCallback(this.creds.token, q.id, `${n}개 일시정지`, this.o.telegram);
				await reply(`⏸ 감시 ${n}개를 일시정지했습니다. 다시 켜기는 앱에서 합니다.`);
			} else if (data.startsWith("p:")) {
				const w = await this.o.ops.pause(this.user, data.slice(2), "telegram");
				await answerCallback(this.creds.token, q.id, `일시정지: ${w.name}`, this.o.telegram);
				const { html, buttons } = renderList(this.o.ops.list(this.user), this.o.publicUrl);
				await reply(html, buttons);
			} else if (data.startsWith("d:")) {
				const w = this.o.ops.list(this.user).find((x) => x.id === data.slice(2));
				if (!w) return void (await answerCallback(this.creds.token, q.id, "이미 없는 감시입니다", this.o.telegram));
				await answerCallback(this.creds.token, q.id, "한 번 더 확인해 주세요", this.o.telegram);
				await sendMessage(
					this.creds.token,
					chat,
					`<b>${escapeHtml(w.name)}</b> 을(를) 삭제할까요?\n${escapeHtml(w.text)}\n되돌릴 수 없습니다. 잠시 멈추려면 일시정지를 쓰세요.`,
					this.o.telegram,
					[
						[
							{ text: "🗑 삭제", callback_data: `D:${w.id}` },
							{ text: "취소", callback_data: "x" },
						],
					],
				);
			} else if (data.startsWith("D:")) {
				if (stale) return void (await reply("확인이 오래됐습니다. /list 에서 다시 눌러 주세요."));
				const w = await this.o.ops.remove(this.user, data.slice(2), "telegram");
				await answerCallback(this.creds.token, q.id, "삭제했습니다", this.o.telegram);
				await reply(`🗑 삭제했습니다 — ${escapeHtml(w.name)}`);
			} else {
				await answerCallback(this.creds.token, q.id, "알 수 없는 버튼입니다", this.o.telegram);
			}
		} catch (err) {
			const msg = err instanceof TriggerError ? err.message : "처리하지 못했습니다";
			await answerCallback(this.creds.token, q.id, msg, this.o.telegram);
			if (!(err instanceof TriggerError)) throw err;
		}
	}
}

/** 사용자별 봇 루프 관리 — 설정에서 토큰·채팅 id 가 바뀌면 30초 안에 따라간다 (refresh 로 즉시) */
export class TelegramBots {
	private readonly o: TelegramBotsOptions;
	private readonly loops = new Map<string, BotLoop>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(o: TelegramBotsOptions) {
		this.o = o;
	}

	start(): void {
		this.reconcile();
		this.timer = setInterval(() => this.reconcile(), RECONCILE_MS);
		this.timer.unref();
	}

	stopAll(): void {
		if (this.timer) clearInterval(this.timer);
		for (const l of this.loops.values()) l.stop();
		this.loops.clear();
	}

	/** 한 사용자 즉시 — 연결 테스트 전(getUpdates 가 겹치지 않게 멈춤)·후(다시 시작) */
	refresh(user: string, opts: { suspend?: boolean } = {}): void {
		const cur = this.loops.get(user);
		const want = opts.suspend ? null : this.o.creds(user);
		if (cur && (!want || want.token !== cur.creds.token || want.chatId !== cur.creds.chatId)) {
			cur.stop();
			this.loops.delete(user);
		}
		if (want && !this.loops.has(user)) {
			const loop = new BotLoop(user, want, this.o);
			this.loops.set(user, loop);
			loop.start();
		}
	}

	reconcile(): void {
		const users = new Set(this.o.users());
		for (const u of [...this.loops.keys()]) if (!users.has(u)) this.refresh(u, { suspend: true });
		for (const u of users) this.refresh(u);
	}

	/** 설정 화면용 — 명령을 받고 있는가 */
	status(user: string): { listening: boolean; problem: string | null } {
		const l = this.loops.get(user);
		return { listening: !!l && !l.problem, problem: l?.problem ?? null };
	}

	/** 테스트용 — 루프 없이 업데이트 하나 처리 */
	static forTest(user: string, creds: BotCreds, o: TelegramBotsOptions): { handle: (u: Update) => Promise<void> } {
		const l = new BotLoop(user, creds, o);
		return { handle: (u) => l.handle(u) };
	}
}
