import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, getThemeMode, watchSystemTheme } from "./lib/theme.ts";
import { installViewport } from "./lib/viewport.ts";
import "./styles.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
	},
});

// 저장된 모드를 반영하고, system 모드면 OS 설정 변화를 따라간다
applyTheme(getThemeMode());
watchSystemTheme(getThemeMode);
// iOS 키보드가 열려도 헤더·컴포저가 제자리에 있도록 #root 높이를 보이는 영역에 맞춘다
installViewport();

const root = document.getElementById("root");
if (!root) throw new Error("#root 엘리먼트가 없습니다");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>,
);
