/**
 * 설정 — 전부 env에서 온다 (PLAN.md §6).
 *   로컬: 저장소 루트 .env
 *   배포: compose.yaml 의 environment
 *
 * 브로커 키 이름은 기존 pi-* 패키지가 하드코딩으로 읽으므로 여기서 다루지 않는다.
 * (KIS_APP_KEY 등은 process.env 그대로 패키지에 전달)
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCorsOrigins } from "./cors.ts";

/** 저장소 루트 (apps/server/src → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 루트 .env 를 process.env 에 병합한다. 이미 설정된 값이 우선. */
export function loadDotEnv(): string | null {
	const file = join(REPO_ROOT, ".env");
	if (!existsSync(file)) return null;

	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return file;
}

export interface Config {
	host: string;
	port: number;
	auth: { user: string; password: string; secret: string; generatedPassword: boolean; ephemeralSecret: boolean };
	agent: { cwd: string; agentDir: string; sessionsDir: string; model: string | undefined; authPath: string | undefined };
	login: { maxAttempts: number; windowSec: number; lockoutSec: number; trustProxy: boolean };
	/** KIS 실전/모의 — 서버 단위 설정. 모의계좌는 별도 앱키가 필요하다. */
	kisEnv: "real" | "paper";
	/** 유휴 런타임 정리 기준(분). 0이면 정리하지 않는다. */
	idleMinutes: number;
	webDir: string;
	dataDir: string;
	/** iOS 앱(Capacitor) 등 크로스 오리진 클라이언트 허용 목록 (cors.ts) */
	corsOrigins: string[];
}

/**
 * pi 자격증명(auth.json) 위치.
 *
 * PI_CODING_AGENT_DIR 을 우리 agentDir 로 바꾸면(확장 설정을 찾게 하려고) pi 의 기본
 * auth.json 경로도 같이 바뀐다 — 그대로 두면 로컬에서 LLM 로그인이 통째로 안 잡힌다.
 * 그래서 명시적으로 고른다:
 *   1. AF_PI_AUTH_PATH (배포에서 마운트 경로 지정)
 *   2. <agentDir>/auth.json
 *   3. ~/.pi/agent/auth.json — 로컬 개발 편의 (기존 pi 로그인 재사용)
 * 셋 다 없으면 undefined → env API 키로 동작한다.
 */
function hasCredentials(path: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return Object.keys(parsed).length > 0;
	} catch {
		return false;
	}
}

function resolveAuthPath(agentDir: string): string | undefined {
	const explicit = process.env.AF_PI_AUTH_PATH?.trim();
	if (explicit) return explicit;

	for (const candidate of [join(agentDir, "auth.json"), join(homedir(), ".pi", "agent", "auth.json")]) {
		// pi 가 빈 auth.json 을 만들어두는 경우가 있어 "존재"만으로 고르면 안 된다
		// (빈 파일이 진짜 로그인 정보를 가려서 조용히 인증이 깨진다)
		if (existsSync(candidate) && hasCredentials(candidate)) return candidate;
	}
	return undefined;
}

export function loadConfig(): Config {
	const password = process.env.AF_AUTH_PASSWORD?.trim() ?? "";
	const secret = process.env.AF_AUTH_SECRET?.trim() ?? "";

	// 비밀번호·시크릿이 없으면 생성한다. 시크릿이 매 기동 바뀌면 기존 토큰이 무효화되므로
	// 배포 환경에서는 반드시 env로 고정해야 한다 (로그에 경고).
	const generatedPassword = password === "";
	const ephemeralSecret = secret === "";

	const dataDir = process.env.AF_DATA_DIR ?? join(REPO_ROOT, ".data");
	const agentDir = process.env.AF_AGENT_DIR ?? join(REPO_ROOT, "agent-config");

	return {
		host: process.env.AF_HOST ?? "0.0.0.0",
		port: Number(process.env.AF_PORT ?? 8080),
		auth: {
			user: process.env.AF_AUTH_USER ?? "alpha",
			password: generatedPassword ? randomBytes(9).toString("base64url") : password,
			secret: ephemeralSecret ? randomBytes(32).toString("hex") : secret,
			generatedPassword,
			ephemeralSecret,
		},
		agent: {
			cwd: process.env.AF_AGENT_CWD ?? join(dataDir, "workspace"),
			// 저장소의 agent-config — models.json·settings.json·확장 패키지가 여기 있다.
			// 예전 기본값(.data/agent)은 비어 있어서 models.json 과 확장이 전혀 적용되지 않았다.
			agentDir,
			sessionsDir: process.env.AF_SESSIONS_DIR ?? join(dataDir, "sessions"),
			model: process.env.AF_DEFAULT_MODEL,
			authPath: resolveAuthPath(agentDir),
		},
		login: {
			maxAttempts: Number(process.env.AF_LOGIN_MAX_ATTEMPTS ?? 5),
			windowSec: Number(process.env.AF_LOGIN_WINDOW_SEC ?? 300),
			lockoutSec: Number(process.env.AF_LOGIN_LOCKOUT_SEC ?? 900),
			trustProxy: process.env.AF_TRUST_PROXY === "1",
		},
		kisEnv: process.env.AF_KIS_ENV === "paper" ? "paper" : "real",
		idleMinutes: Number(process.env.AF_IDLE_MINUTES ?? 60),
		webDir: process.env.AF_WEB_DIR ?? join(REPO_ROOT, "apps/web/dist"),
		dataDir,
		corsOrigins: parseCorsOrigins(process.env.AF_CORS_ORIGINS),
	};
}

