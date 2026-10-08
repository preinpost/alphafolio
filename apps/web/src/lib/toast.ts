/**
 * 짧은 결과 알림 (토스트) — 화면 아래 가운데. 어디서든 toast("…") 로 띄운다.
 * 되돌리기 같은 동작이 있으면 6초, 없으면 3.2초 뒤 사라진다. 그리는 곳은 components/Toasts.tsx.
 */
import { useSyncExternalStore } from "react";

export interface ToastItem {
	id: number;
	text: string;
	sub?: string;
	action?: { label: string; run: () => void };
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function toast(text: string, opts: { sub?: string; action?: ToastItem["action"]; ms?: number } = {}): void {
	const id = ++seq;
	// 한꺼번에 쌓이면 화면을 가린다 — 최근 3개만
	items = [...items, { id, text, sub: opts.sub, action: opts.action }].slice(-3);
	emit();
	setTimeout(() => dismissToast(id), opts.ms ?? (opts.action ? 6000 : 3200));
}

export function dismissToast(id: number): void {
	const next = items.filter((t) => t.id !== id);
	if (next.length === items.length) return;
	items = next;
	emit();
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function useToasts(): ToastItem[] {
	return useSyncExternalStore(subscribe, () => items);
}
