import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, getThemeMode, watchSystemTheme } from "./lib/theme.ts";
import "./styles.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
	},
});

// 저장된 모드를 반영하고, system 모드면 OS 설정 변화를 따라간다
applyTheme(getThemeMode());
watchSystemTheme(getThemeMode);

const root = document.getElementById("root");
if (!root) throw new Error("#root 엘리먼트가 없습니다");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>,
);
