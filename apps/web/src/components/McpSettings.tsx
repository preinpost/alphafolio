/**
 * 설정 → MCP 서버 (PLAN §38) — 연결한 서버 · 서버별 툴(이름·설명 원문·파라미터) · 판정(바로 실행 / 확인 카드).
 *
 * 추가·연결·삭제는 여기서만 한다 (에이전트 툴 없음). 에이전트는 mcp_call 로 읽기 툴은 바로 쓰고,
 * 쓰기 툴(알림·관심목록 변경 등)은 확인 카드를 띄운다 — 사람이 [확인] 을 눌러야 실행된다 (PLAN §39).
 * 판정 규칙은 packages/mcp/src/policy.ts — 화면은 서버가 판정한 결과를 그대로 보여 준다.
 *
 * OAuth 연결:
 *   웹  — 같은 탭에서 인가 서버로 이동 → 서버 콜백이 /settings/mcp?mcp=ok 로 되돌린다
 *   앱  — 시스템 브라우저로 연다 (WKWebView 안에서 남의 로그인 화면을 띄우지 않는다).
 *         콜백 완료 페이지가 "앱으로 돌아가세요" 를 보여 주고, 앱이 앞으로 오면 목록을 다시 읽는다 (react-query 포커스 재조회)
 */
import { AlertIcon, PlusIcon } from "./icons.tsx";
import { AddForm } from "./mcp/AddForm.tsx";
import { DeleteSheet } from "./mcp/DeleteSheet.tsx";
import { ServerRow } from "./mcp/ServerRow.tsx";
import { ToolsCard } from "./mcp/ToolsCard.tsx";
import { useMcpServers } from "./mcp/useMcpServers.ts";

export function McpSettings() {
	const { notice, setNotice, tests, adding, setAdding, deleting, setDeleting, setSelected, list, items, toolsOf, add, remove, disconnect, test, connect, data, busy, presets, current } =
		useMcpServers();

	return (
		<>
			{notice && (
				<div className={`notice ${notice.ok ? "ok" : "bad"}`} role="status">
					<AlertIcon size={16} />
					<span className="flex-1">{notice.message}</span>
					<button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>
						닫기
					</button>
				</div>
			)}
			{data && !data.oauthReady && (
				<div className="notice warn">
					<AlertIcon size={16} />
					<span>
						서버에 <span className="mono">AF_PUBLIC_URL</span> 이 없어 OAuth 로그인(TradingView 등)을 할 수 없습니다. 관리자에게 요청하세요.
					</span>
				</div>
			)}
			{data && !data.storageReady && (
				<div className="notice bad">
					<AlertIcon size={16} />
					<span>MCP 설정 저장소가 준비되지 않았습니다 (서버 DB 미설정).</span>
				</div>
			)}

			<section className="card" aria-labelledby="mcp-servers-h">
				<div className="card-h">
					<h2 id="mcp-servers-h">연결한 서버</h2>
					<span className="spacer" />
					<span className="eyebrow font-medium">원격(https) 서버만</span>
				</div>
				<div className="rows border-t border-line">
					{list.isLoading && <div className="empty">불러오는 중…</div>}
					{data && items.length === 0 && <div className="empty">연결한 서버가 없습니다.</div>}
					{items.map((s) => (
						<ServerRow
							key={s.id}
							s={s}
							t={tests[s.id]}
							tools={toolsOf(s.id)}
							busy={busy}
							oauthReady={!!data?.oauthReady}
							connecting={connect.isPending && connect.variables === s.id}
							testing={test.isPending && test.variables === s.id}
							testBusy={test.isPending}
							onConnect={() => connect.mutate(s.id)}
							onTest={() => test.mutate(s.id)}
							onDisconnect={() => disconnect.mutate(s.id)}
							onDelete={() => setDeleting(s)}
						/>
					))}
				</div>
				<div className="mcp-add">
					{(presets.length > 0 || !adding) && (
						<div className="add-btns">
							{presets.map((p) => (
								<button key={p.id} className="btn btn-secondary btn-sm" disabled={busy} onClick={() => add.mutate({ preset: p.id })}>
									<PlusIcon size={14} />
									{p.name}
								</button>
							))}
							{!adding && (
								<button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAdding(true)}>
									<PlusIcon size={14} />
									직접 추가
								</button>
							)}
						</div>
					)}
					{adding && (
						<AddForm
							busy={add.isPending}
							serverError={add.error?.message ?? null}
							onAdd={(i) => add.mutate(i)}
							onCancel={() => {
								setAdding(false);
								add.reset();
							}}
						/>
					)}
					<p className="foot-note">
						에이전트는 조회는 바로 하고, 알림·관심목록 변경 같은 <b>쓰기는 확인 카드</b>로 묻습니다. [확인]을 눌러야 실행됩니다. 로그인 토큰과 헤더 값은 암호화되어 서버에만
						남습니다.
					</p>
				</div>
			</section>

			{current && (
				<ToolsCard
					key={current.id}
					servers={items}
					current={current}
					query={toolsOf(current.id)}
					countOf={(id) => toolsOf(id)?.data?.tools?.length ?? null}
					onPick={setSelected}
				/>
			)}

			<DeleteSheet
				server={deleting}
				onCancel={() => setDeleting(null)}
				onConfirm={(s) => {
					setDeleting(null);
					remove.mutate(s.id);
				}}
			/>
		</>
	);
}
