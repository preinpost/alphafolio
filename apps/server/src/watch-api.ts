/**
 * 감시 트리거 조작 · /api/watch/* (PLAN §40).
 *
 * 조작은 여기 한 곳에서 한다 — 앱 화면·에이전트 툴·텔레그램이 같은 함수를 부르고, **누가 무엇을 할 수 있는지**도 여기서 정한다:
 *   켜기(확인 토큰)·다시 켜기  → 앱만
 *   일시정지                   → 앱·에이전트·텔레그램
 *   삭제·비상 정지             → 앱·텔레그램 (에이전트 없음)
 * 모든 상태 변경은 이벤트로 남기고 떠 있는 화면에 알린다.
 */
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TriggerSpec } from "@alphafolio/broker";
import type { WatchSummary } from "@alphafolio/broker/watch-tools";
import { HttpError, readJson } from "./ledger-api.ts";
import { createOrderToken, type OrderTokenGuard, type VerifyFailure } from "./order-tokens.ts";
import { toSummary, TriggerError, type TriggerRecord, type TriggerStore } from "./triggers.ts";
import type { WatchEvent } from "./watcher.ts";

/** 켜기 확인은 급하지 않다 — 주문(2분)보다 길게 */
export const WATCH_TOKEN_TTL_MS = 10 * 60_000;

export interface WatchTokenPayload {
	u: string;
	watch: TriggerSpec;
	exp: number;
	nonce: string;
}

/** 주문·MCP 확인 토큰과 키를 나눈다 — 서로의 실행 경로에 넣으면 서명에서 떨어진다 */
export function watchConfirmSecret(master: string): string {
	return createHmac("sha256", master).update("alphafolio/watch-confirm/v1").digest("hex");
}

export type Actor = "app" | "agent" | "telegram";
const ACTOR_LABEL: Record<Actor, string> = { app: "앱", agent: "에이전트", telegram: "텔레그램" };

export interface WatchOpsDeps {
	store: TriggerStore;
	confirm: { secret: string; guard: OrderTokenGuard<WatchTokenPayload> };
	/** 화면·채널 알림 — 상태 변경은 화면에만 (deliver 에 channels:false) */
	deliver: (ev: WatchEvent, opts?: { channels?: boolean }) => Promise<unknown>;
	channels: (user: string) => string[];
	/** 텔레그램 명령 수신 상태 (설정 화면 표시용) */
	commandStatus?: (user: string) => { listening: boolean; problem: string | null };
	now?: () => number;
}

function failure(reason: VerifyFailure): string {
	switch (reason) {
		case "expired":
			return "확인 시간이 지났습니다 (10분). 챗에서 다시 준비해 주세요.";
		case "used":
			return "이미 켠 감시입니다.";
		case "wrong-user":
			return "다른 사용자의 확인 카드입니다.";
		default:
			return "확인 정보가 올바르지 않습니다.";
	}
}

export class WatchOps {
	private readonly d: WatchOpsDeps;

	constructor(deps: WatchOpsDeps) {
		this.d = deps;
	}

	private now(): number {
		return this.d.now?.() ?? Date.now();
	}

	summary(rec: TriggerRecord): WatchSummary {
		return toSummary(rec, this.now());
	}

	list(user: string): WatchSummary[] {
		return this.d.store.list(user).map((r) => this.summary(r));
	}

	/** 에이전트 툴의 발급기 */
	prepare(user: string, spec: TriggerSpec): { token: string; expiresAt: number } {
		const { token, payload } = createOrderToken({ u: user, watch: spec }, this.d.confirm.secret, this.now(), WATCH_TOKEN_TTL_MS);
		console.log(`[watch] 준비 user=${user} ${spec.name} nonce=${payload.nonce}`);
		return { token, expiresAt: payload.exp };
	}

	/** 사람이 카드에서 [켜기] — 감시가 시작되는 유일한 경로 */
	async arm(user: string, token: string): Promise<WatchSummary> {
		const v = this.d.confirm.guard.verify(token, this.d.confirm.secret, user, this.now());
		if (!v.ok) throw new HttpError(400, failure(v.reason));
		// 저장 전에 소비 — 더블클릭으로 두 개가 켜지지 않게 (실패해도 재사용 없음, 다시 준비하면 된다)
		this.d.confirm.guard.consume(v.payload.nonce, this.now(), WATCH_TOKEN_TTL_MS);
		const rec = await this.d.store.create(user, v.payload.watch);
		await this.log(rec, "armed", "app", `켰습니다 — ${rec.name}`);
		console.log(`[watch] 켬 user=${user} ${rec.id} ${rec.name}`);
		return this.summary(rec);
	}

	async pause(user: string, id: string, by: Actor): Promise<WatchSummary> {
		const rec = await this.d.store.pause(user, id);
		await this.log(rec, "paused", by, `일시정지 (${ACTOR_LABEL[by]})`);
		return this.summary(rec);
	}

	async resume(user: string, id: string, by: Actor): Promise<WatchSummary> {
		if (by !== "app") throw new TriggerError(403, "다시 켜기는 앱 화면에서만 할 수 있습니다");
		const rec = await this.d.store.resume(user, id);
		await this.log(rec, "resumed", by, "다시 켰습니다");
		return this.summary(rec);
	}

	async remove(user: string, id: string, by: Actor): Promise<WatchSummary> {
		if (by === "agent") throw new TriggerError(403, "삭제는 사용자가 앱·텔레그램에서 합니다");
		const rec = await this.d.store.remove(user, id);
		await this.log(rec, "removed", by, `삭제 (${ACTOR_LABEL[by]})`);
		return this.summary(rec);
	}

	async stopAll(user: string, by: Actor): Promise<number> {
		if (by === "agent") throw new TriggerError(403, "비상 정지는 사용자가 앱·텔레그램에서 합니다");
		const n = await this.d.store.stopAll(user);
		const at = this.now();
		await this.d.store.addEvent({ triggerId: "*", member: user, at, kind: "stopped", barT: null, detail: { name: "전체", count: n, by }, notified: null });
		await this.d.deliver(
			{ user, triggerId: "*", name: "전체", kind: "stopped", at, message: { level: "important", title: "감시 비상 정지", lines: [`켜져 있던 감시 ${n}개를 일시정지했습니다 (${ACTOR_LABEL[by]}).`], path: "/settings/watch" } },
			{ channels: by !== "telegram" },
		);
		console.log(`[watch] 비상 정지 user=${user} ${n}개 by=${by}`);
		return n;
	}

	private async log(rec: TriggerRecord, kind: "armed" | "paused" | "resumed" | "removed", by: Actor, text: string): Promise<void> {
		const at = this.now();
		await this.d.store.addEvent({ triggerId: rec.id, member: rec.member, at, kind, barT: null, detail: { name: rec.name, by }, notified: null });
		// 상태 변경은 화면에만 알린다 (텔레그램으로 한 조작을 텔레그램에 다시 보내지 않는다)
		await this.d.deliver(
			{ user: rec.member, triggerId: rec.id, name: rec.name, kind, at, message: { level: "info", title: rec.name, lines: [text], path: "/settings/watch" } },
			{ channels: false },
		);
	}

	/** 앱 화면 목록 — 평가 오류·대화 링크까지 */
	async view(user: string) {
		const now = this.now();
		return {
			items: this.d.store.list(user).map((r) => ({ ...toSummary(r, now), lastError: r.lastError, conversationId: r.conversationId, createdAt: r.createdAt })),
			// DB 가 없으면 화면이 "저장소 준비 안 됨" 을 보이도록 빈 목록으로 (오류로 던지지 않는다)
			events: this.d.store.ready ? await this.d.store.events(user, 30) : [],
			channels: this.d.channels(user),
			telegram: this.d.commandStatus?.(user) ?? { listening: false, problem: null },
			storageReady: this.d.store.ready,
		};
	}
}

function asHttp(err: unknown): never {
	if (err instanceof TriggerError) throw new HttpError(err.status, err.message);
	throw err;
}

/** 처리한 경로면 응답 본문, 아니면 undefined */
export async function handleWatch(req: IncomingMessage, path: string, user: string, ops: WatchOps): Promise<unknown> {
	try {
		if (path === "/api/watch" && req.method === "GET") return await ops.view(user);
		// ⚠️ 확인 카드의 [켜기] 만 부른다 — 에이전트는 사용자 인증 토큰이 없어 여기에 올 수 없다
		if (path === "/api/watch/arm" && req.method === "POST") {
			const body = await readJson(req);
			return { ok: true, watch: await ops.arm(user, String(body.token ?? "")) };
		}
		if (path === "/api/watch/stop-all" && req.method === "POST") return { stopped: await ops.stopAll(user, "app") };
		const m = /^\/api\/watch\/(w[0-9a-f]{8})(\/pause|\/resume)?$/.exec(path);
		if (!m) return undefined;
		const id = m[1] as string;
		if (m[2] === "/pause" && req.method === "POST") return await ops.pause(user, id, "app");
		if (m[2] === "/resume" && req.method === "POST") return await ops.resume(user, id, "app");
		if (!m[2] && req.method === "DELETE") return await ops.remove(user, id, "app");
		return undefined;
	} catch (err) {
		asHttp(err);
	}
}
