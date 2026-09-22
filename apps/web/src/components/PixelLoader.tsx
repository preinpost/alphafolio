/** 3x3 픽셀 그리드 로더 — 연결 중 / 응답 대기 / 툴 실행 등에서 사용 */
export function PixelLoader({ className = "" }: { className?: string }) {
  return (
    <span className={`pixel-loader ${className}`} aria-hidden>
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
