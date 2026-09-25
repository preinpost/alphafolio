import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * 순수 SPA 빌드 — SSR 없음.
 * Capacitor(iOS)가 이 dist를 그대로 webDir로 쓰므로 서버 사이드 렌더링을 도입하면 안 된다 (PLAN.md §8.4).
 *
 * 개발: vite dev 서버(5173)가 /api·/ws 를 서버(8080)로 프록시한다.
 * 배포: 서버가 dist를 정적 서빙한다.
 */
const SERVER_PORT = process.env.AF_PORT ?? "8080";

/** 앱 버전 = 루트 package.json (릴리스 워크플로가 올린다). 화면 버전 표시·서버 버전과 비교 (App.tsx) */
const APP_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	plugins: [
		react(),
		tailwindcss(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["favicon-64.png", "apple-touch-icon.png"],
			manifest: {
				name: "AlphaFolio",
				short_name: "AlphaFolio",
				description: "개인 금융 에이전트 — 투자 + 가계부",
				theme_color: "#f6f8fb",
				background_color: "#f6f8fb",
				display: "standalone",
				start_url: "/",
				lang: "ko",
				icons: [
					{ src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
					{ src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
					{ src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
				// ⚠️ HTML은 런타임 캐시하지 않는다 — 예전 index.html이 서빙되어 구버전 번들로
				// 롤백되는 경합이 있었다 (기존 구현에서 확인된 문제).
				runtimeCaching: [],
			},
		}),
	],
	server: {
		port: 5173,
		host: true, // 같은 네트워크의 모바일 기기에서 접속 가능
		proxy: {
			"/api": `http://localhost:${SERVER_PORT}`,
			"/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
		},
	},
});
