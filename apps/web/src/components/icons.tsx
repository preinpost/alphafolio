/**
 * 인라인 SVG 아이콘 — 아이콘 라이브러리 의존성 없이 쓰는 최소 세트.
 * OpenDesign 개선안(assets/shell.js)과 같은 도형·선 굵기(1.75).
 * stroke 는 currentColor 라 text-* / 부모 color 로 색을 준다.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function icon(paths: ReactNode) {
	return function Icon({ size = 18, ...props }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.75}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden
				{...props}
			>
				{paths}
			</svg>
		);
	};
}

// ── 내비게이션 ──────────────────────────────────────────────────────────
export const ChatIcon = icon(<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />);

export const TrendingIcon = icon(
	<>
		<path d="M3 17l6-6 4 4 8-8" />
		<path d="M15 7h6v6" />
	</>,
);

export const WalletIcon = icon(
	<>
		<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
		<path d="M16 12h4.5" />
		<path d="M3.5 9h17" />
	</>,
);

export const SettingsIcon = icon(
	<>
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
	</>,
);

export const MenuIcon = icon(<path d="M4 7h16M4 12h16M4 17h10" />);

export const LogOutIcon = icon(
	<>
		<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
		<path d="M10 17l-5-5 5-5" />
		<path d="M5 12h11" />
	</>,
);

export const ChevronLeftIcon = icon(<path d="M15 6l-6 6 6 6" />);
export const ChevronRightIcon = icon(<path d="M9 6l6 6-6 6" />);
export const ChevronDownIcon = icon(<path d="M6 9l6 6 6-6" />);

// ── 동작 ────────────────────────────────────────────────────────────────
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const XIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const ArrowUpIcon = icon(<path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowDownIcon = icon(<path d="M12 5v14M6 13l6 6 6-6" />);
export const StopIcon = icon(<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />);

export const EditIcon = icon(
	<>
		<path d="M4 20h4L19 9l-4-4L4 16z" />
		<path d="M13.5 6.5l4 4" />
	</>,
);

export const CopyIcon = icon(
	<>
		<rect x="8.5" y="8.5" width="11" height="11" rx="2" />
		<path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
	</>,
);

export const TrashIcon = icon(
	<>
		<path d="M4.5 7h15M10 11v6M14 11v6" />
		<path d="M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12" />
		<path d="M9.5 7V4.5h5V7" />
	</>,
);

export const SearchIcon = icon(
	<>
		<circle cx="11" cy="11" r="6.5" />
		<path d="M20 20l-4.2-4.2" />
	</>,
);

export const RefreshIcon = icon(
	<>
		<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
		<path d="M4 4v4h4" />
		<path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
		<path d="M20 20v-4h-4" />
	</>,
);

export const ImageIcon = icon(
	<>
		<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
		<circle cx="9" cy="10" r="1.6" />
		<path d="M20.5 16l-5-5-8 8.5" />
	</>,
);

export const PauseIcon = icon(<path d="M9 6v12M15 6v12" />);
export const PlayIcon = icon(<path d="M8 5.5v13l10-6.5z" />);

export const LinkIcon = icon(
	<>
		<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
		<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
	</>,
);

// ── 상태 ────────────────────────────────────────────────────────────────
export const AlertIcon = icon(
	<>
		<path d="M12 3.5l9.5 16.5h-19z" />
		<path d="M12 10v4.5M12 17.5v.01" />
	</>,
);

export const InfoIcon = icon(
	<>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 11v5.5M12 7.5v.01" />
	</>,
);

export const BellIcon = icon(
	<>
		<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
		<path d="M10 20.5a2 2 0 0 0 4 0" />
	</>,
);

export const ShieldIcon = icon(<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />);

// ── 화면 · 계정 ─────────────────────────────────────────────────────────
export const SunIcon = icon(
	<>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
	</>,
);

export const MoonIcon = icon(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);

export const UserIcon = icon(
	<>
		<circle cx="12" cy="8" r="4" />
		<path d="M4 21a8 8 0 0 1 16 0" />
	</>,
);

export const MonitorIcon = icon(
	<>
		<rect x="3" y="4" width="18" height="13" rx="2" />
		<path d="M8 21h8M12 17v4" />
	</>,
);

export const KeyIcon = icon(
	<>
		<circle cx="8" cy="15" r="4" />
		<path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2" />
	</>,
);

export const EyeIcon = icon(
	<>
		<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
		<circle cx="12" cy="12" r="2.8" />
	</>,
);

export const EyeOffIcon = icon(
	<>
		<path d="M3 3l18 18" />
		<path d="M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1.1" />
		<path d="M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2" />
	</>,
);
