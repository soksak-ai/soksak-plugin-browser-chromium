// browser 플러그인 전역 CSS — 단일 <style> 1회 주입.
// .bv-* 셀렉터는 코어 App.css 에서 그대로 이식(선택자 변경 없음).
// 컨테이너(.browser-view)는 투명(레이어 원칙) — .bv-area 가 홀이라 아래 webview 가 비친다.
export const GLOBAL_CSS = `
.browser-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: transparent;
  color: var(--fg, #ddd);
  font: 12px var(--app-font, system-ui, sans-serif);
}
.bv-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg, #1e1e1e);
  border-bottom: 1px solid var(--bd-soft, #2a2a2a);
  -webkit-user-select: none;
  user-select: none;
}
.bv-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg, #ddd);
  opacity: 0.7;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  width: 24px;
  height: 22px;
  border-radius: 4px;
  padding: 0;
}
.bv-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}
.bv-btn:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.2);
}
.bv-btn.on {
  opacity: 1;
  color: #e2b93d;
}
.bv-url {
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  padding: 0 10px;
  background: rgba(127, 127, 127, 0.12);
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--fg, #ddd);
  font-size: 12px;
  outline: none;
}
.bv-url:focus {
  border-color: var(--acc, #6cf);
}
/* 즐겨찾기 목록 — flex 형제라 열리면 webview 본문(.bv-area)이 그만큼 줄어든다. */
.bv-bm-list {
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
  background: var(--bg, #1e1e1e);
  border-bottom: 1px solid var(--bd-soft, #2a2a2a);
  padding: 4px;
}
.bv-bm-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.bv-bm-item:hover {
  background: rgba(127, 127, 127, 0.16);
}
.bv-bm-title {
  flex: 0 0 auto;
}
.bv-bm-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.55;
  font-size: 11px;
}
.bv-bm-empty {
  padding: 8px 10px;
  font-size: 12px;
  opacity: 0.6;
}
/* 홀: 이 영역만 투명해 "아래" child webview 가 비친다(레이어 원칙). */
.bv-area {
  flex: 1 1 auto;
  min-height: 0;
  background: transparent;
}
/* inline DevTools(같은 탭 내부 분할) — 페이지/DevTools 두 홀 사이의 리사이즈 divider.
   6px DOM 띠는 어느 child rect 에도 안 덮여(두 홀 사이 갭) 마우스를 직접 받는다. */
.bv-dt-divider {
  flex: 0 0 6px;
  cursor: row-resize;
  background: var(--bd-soft, #2a2a2a);
  -webkit-user-select: none;
  user-select: none;
}
.bv-dt-divider:hover {
  background: var(--acc, #4a8cff);
}
.bv-dt-area {
  min-height: 0;
  background: transparent;
}
/* inline 분할 래퍼 — 방향(flexDirection)은 도킹 side 에 따라 inline style 로 지정. */
.bv-split {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  min-width: 0;
}
`;

export function injectStyles(): void {
  const STYLE_ID = "sk-browser-style";
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    // 항상 최신으로 갱신 — 존재 가드만 하면 어떤 경로로든 살아남은 옛 <style> 이 새 규칙을 영원히
    // 가린다(스타일만 안 바뀌는 유령 버그 부류의 원천 차단). textContent 교체는 멱등·저비용.
    if (existing.textContent !== GLOBAL_CSS) existing.textContent = GLOBAL_CSS;
    return;
  }
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = GLOBAL_CSS;
  document.head.appendChild(s);
}
