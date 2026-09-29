/**
 * 웹 정적 파일 캐시 정책 (serveStatic).
 *
 * 헤더를 안 붙이면 Cloudflare 가 .js 를 기본 4시간 캐시한다 — sw.js 도 포함이라 배포 후에도 브라우저가
 * **옛 sw.js** 를 받고, 옛 서비스워커가 옛 번들을 계속 줬다 (실측 2026-09-29: 엣지 sw.js 는 이전 번들,
 * 원본은 새 번들). 새로고침해도 안 바뀌던 원인이다.
 *
 *   - 진입점(sw.js · registerSW.js · index.html · manifest) → no-cache: 매번 원본에 확인 (CDN 도 캐시하지 않는다)
 *   - assets/* → 파일명에 해시가 있어 내용이 바뀌면 이름이 바뀐다 → 1년 immutable
 *   - 그 외(아이콘, workbox-<hash>.js) → 헤더 없음 (CDN 기본값)
 */
const ENTRY_FILES = new Set(["sw.js", "registerSW.js", "index.html", "manifest.webmanifest"]);

/** webDir 기준 상대 경로(슬래시 구분) → cache-control 값. 없으면 붙이지 않는다 */
export function staticCacheControl(relPath: string): string | undefined {
	const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (ENTRY_FILES.has(rel)) return "no-cache";
	if (rel.startsWith("assets/")) return "public, max-age=31536000, immutable";
	return undefined;
}
