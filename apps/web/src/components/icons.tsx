/**
 * 인라인 SVG 아이콘 (lucide 경로 기반) — 아이콘 라이브러리 의존성 없이 쓰는 최소 세트.
 * stroke 는 currentColor 라 text-* 로 색을 준다.
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
				strokeWidth={2}
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

export const PlusIcon = icon(
	<>
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	</>,
);

export const ChatIcon = icon(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />);

export const TrendingIcon = icon(
	<>
		<path d="M22 7 13.5 15.5 8.5 10.5 2 17" />
		<path d="M16 7h6v6" />
	</>,
);

export const WalletIcon = icon(
	<>
		<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
		<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
	</>,
);

export const SettingsIcon = icon(
	<>
		<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
		<circle cx="12" cy="12" r="3" />
	</>,
);

export const LogOutIcon = icon(
	<>
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<path d="m16 17 5-5-5-5" />
		<path d="M21 12H9" />
	</>,
);

export const MenuIcon = icon(
	<>
		<path d="M4 6h16" />
		<path d="M4 12h16" />
		<path d="M4 18h16" />
	</>,
);

export const XIcon = icon(
	<>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</>,
);

export const ArrowUpIcon = icon(
	<>
		<path d="m5 12 7-7 7 7" />
		<path d="M12 19V5" />
	</>,
);

export const ArrowDownIcon = icon(
	<>
		<path d="M12 5v14" />
		<path d="m19 12-7 7-7-7" />
	</>,
);

export const StopIcon = icon(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />);

export const CopyIcon = icon(
	<>
		<rect width="14" height="14" x="8" y="8" rx="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	</>,
);

export const TrashIcon = icon(
	<>
		<path d="M3 6h18" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</>,
);

export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);

export const AlertIcon = icon(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 8v4" />
		<path d="M12 16h.01" />
	</>,
);

export const ImageIcon = icon(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<circle cx="9" cy="9" r="2" />
		<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
	</>,
);
