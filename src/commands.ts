// browser.* 명령 — 내비게이션(navigate/back/forward/reload) + open. 매니페스트 contributes.commands
// 와 1:1(declared≡actual). CLI/MCP 자동 노출. 엔진 조작은 Chromium 어댑터(app.sidecar 채널)
// 경유 — 코어 비결합. eval/dom/media 는 엔진 v1 미지원이라 제공하지 않는다(후속: CDP).
import type { PluginApi, PluginContext } from "./host";
import {
  makeChromium,
  devtoolsLabelFor,
  engineStats,
  devtoolsMapSnapshot,
  idMapSnapshot,
} from "./chromium-adapter";

// 새 브라우저 탭을 열 때 mount 가 homeUrl 대신 소비할 "대기 URL".
let pendingOpenUrl: string | null = null;
export function setPendingUrl(url: string): void {
  pendingOpenUrl = url;
}
export function takePendingUrl(): string | null {
  const u = pendingOpenUrl;
  pendingOpenUrl = null;
  return u;
}

// DevTools 를 새 탭으로 열 때, 그 새 뷰가 마운트되며 "어느 브라우저를 검사할지"(inspected label)와
// screencast 오버라이드를 이어받는 대기값. pendingUrl 과 같은 1회 소비 패턴 — view.open 직전 set,
// 새 뷰 mount 가 take. screencast 생략 = 플러그인 설정(devtoolsScreencast)을 따른다.
export interface PendingDevtools {
  label: string;
  screencast?: boolean;
}
let pendingDevtools: PendingDevtools | null = null;
export function setPendingDevtools(inspectedLabel: string, screencast?: boolean): void {
  pendingDevtools = { label: inspectedLabel, screencast };
}
export function takePendingDevtools(): PendingDevtools | null {
  const p = pendingDevtools;
  pendingDevtools = null;
  return p;
}

// DevTools 탭 열기의 단일 경로(커맨드 핸들러 + 툴바 버튼 공용). 같은 inspected 의 DevTools 탭이 이미
// 살아있으면 새로 만들지 않고 그 탭을 활성화한다(Chrome 의 토글 감각 — 중복 탭 방지).
export async function openDevtoolsTab(
  app: PluginApi,
  inspectedLabel: string,
  screencast?: boolean,
): Promise<{ ok: boolean; focused?: boolean; error?: string }> {
  const existing = devtoolsLabelFor(inspectedLabel);
  if (existing) {
    const viewId = existing.slice("chromium-".length);
    const out = await app.commands
      ?.execute("view.activate", { view: viewId })
      .catch(() => null);
    if (out && out.ok) return { ok: true, focused: true };
    // 활성화 실패(뷰가 방금 닫힘 등) — 새로 여는 경로로 진행.
  }
  // DevTools 는 검사 대상이 화면에 보여야(visible) 동작한다 — 탭 전환식으로 열면 대상 브라우저가
  // 비활성=숨김이 되어 DevTools 가 "tab is inactive"(렌더 정지)를 띄운다. 그래서 대상이 있는 그룹
  // "옆에 나란히 분할"로 연다(둘 다 visible = Chrome docked 동형). 여전히 정식 뷰라 드래그로 합치기/
  // 재배치 가능. 열기 직전 활성 그룹 = 대상 브라우저 그룹(버튼/커맨드가 그 뷰를 대상으로 하므로).
  const active = await app.commands?.execute("view.list", {}).catch(() => null);
  const grp = active && typeof active.groupId === "string" ? active.groupId : null;
  setPendingDevtools(inspectedLabel, screencast);
  const out = await app.commands
    ?.execute("view.open", { program: "browser-chromium" })
    .catch(() => null);
  if (!out || !out.ok) {
    takePendingDevtools();
    return { ok: false, error: "view.open failed" };
  }
  const dtViewId = typeof out.viewId === "string" ? out.viewId : null;
  if (dtViewId && grp) {
    // 대상 옆(오른쪽)으로 분할. 실패해도(단일 뷰 등) 탭으로는 열려 있으니 무해.
    await app.commands
      ?.execute("view.move", { view: dtViewId, dst: grp, zone: "right" })
      .catch(() => {});
  }
  return { ok: true };
}

// 활성 뷰의 label + 현재 URL 레지스트리(마운트=등록, 언마운트=제거).
interface ViewEntry { label: string; getUrl: () => string }
const activeViews = new Map<string, ViewEntry>();
let lastMountedViewId: string | null = null;
let activeViewId: string | null = null;

export function registerLabel(viewId: string, label: string, getUrl: () => string): void {
  activeViews.set(viewId, { label, getUrl });
  lastMountedViewId = viewId;
  activeViewId = viewId;
}
export function unregisterLabel(viewId: string): void {
  activeViews.delete(viewId);
  if (activeViewId === viewId) activeViewId = null;
  if (lastMountedViewId === viewId) lastMountedViewId = null;
}
export function noteActivated(viewId: string): void {
  if (activeViews.has(viewId)) activeViewId = viewId;
}

// 타겟 해소: 명시 viewId → 활성 → 마지막 마운트 → 첫 등록. 명시가 미등록이면 null.
function resolveEntry(explicitViewId?: string): ViewEntry | null {
  if (explicitViewId) return activeViews.get(explicitViewId) ?? null;
  if (activeViewId && activeViews.has(activeViewId)) return activeViews.get(activeViewId)!;
  if (lastMountedViewId && activeViews.has(lastMountedViewId)) return activeViews.get(lastMountedViewId)!;
  const iter = activeViews.values().next();
  return iter.done ? null : iter.value;
}

function explicitTarget(p: Record<string, unknown>): string | undefined {
  const raw = p.viewId ?? p.view;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

const targetParam = {
  viewId: {
    type: "string" as const,
    description: "Target browser view id (e.g. v15). Omit to target the active browser view.",
    required: false,
  },
};

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:") || s.startsWith("data:")) return s;
  if (/^[^\s.]+\.[^\s]{2,}/.test(s) && !s.includes(" ")) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export function registerCommands(ctx: PluginContext): void {
  const app = ctx.app;
  if (!app.commands) return;
  const chromium = makeChromium(app);

  // 활성 뷰 추종(호스트 view.activated).
  const off = app.events.on("view.activated", (p) => {
    const id = (p as { viewId?: string })?.viewId;
    if (typeof id === "string") noteActivated(id);
  });
  ctx.subscriptions.push(off);

  const reg = (name: string, spec: Parameters<NonNullable<typeof app.commands>["register"]>[1]) => {
    ctx.subscriptions.push(app.commands!.register(name, spec));
  };

  reg("stats", {
    description: "Live engine-side browser child ids + label/devtools mappings (E2E/diagnostics — verifies close really destroyed the child).",
    handler: async () => ({
      ok: true,
      ids: await engineStats(app),
      idMap: idMapSnapshot(),
      devtoolsMap: devtoolsMapSnapshot(),
    }),
  });

  reg("ping", {
    description: "Load/version check — returns the plugin id and engine (E2E).",
    handler: () => ({ ok: true, plugin: app.pluginId, engine: "chromium" }),
  });

  reg("navigate", {
    description: "Navigate the active (or specified) browser view to a URL.",
    triggers: { ko: "이동 주소 열기 navigate 크롬" },
    params: { ...targetParam, url: { type: "string", description: "URL or search terms", required: true } },
    handler: async (p) => {
      const e = resolveEntry(explicitTarget(p));
      if (!e) return { ok: false, error: "no active browser view" };
      await chromium.navigate(e.label, normalizeUrl(String(p.url ?? "")));
      return { ok: true };
    },
  });

  reg("back", {
    description: "Go back in the active browser view's history.",
    triggers: { ko: "뒤로 이전 back" },
    params: targetParam,
    handler: async (p) => {
      const e = resolveEntry(explicitTarget(p));
      if (!e) return { ok: false, error: "no active browser view" };
      await chromium.history(e.label, -1);
      return { ok: true };
    },
  });

  reg("forward", {
    description: "Go forward in the active browser view's history.",
    triggers: { ko: "앞으로 다음 forward" },
    params: targetParam,
    handler: async (p) => {
      const e = resolveEntry(explicitTarget(p));
      if (!e) return { ok: false, error: "no active browser view" };
      await chromium.history(e.label, 1);
      return { ok: true };
    },
  });

  reg("reload", {
    description: "Reload the current page in the active browser view.",
    triggers: { ko: "새로고침 리로드 reload" },
    params: targetParam,
    handler: async (p) => {
      const e = resolveEntry(explicitTarget(p));
      if (!e) return { ok: false, error: "no active browser view" };
      await chromium.navigate(e.label, e.getUrl());
      return { ok: true };
    },
  });

  reg("devtools", {
    description: "Open Chrome DevTools for the active browser view as a new tab (splittable/movable like any view). Focuses the existing DevTools tab if one is already open for that view.",
    triggers: { ko: "개발자 도구 인스펙터 devtools 열기" },
    params: {
      ...targetParam,
      screencast: {
        type: "boolean",
        description: "Show the page preview (screencast) panel inside DevTools. Omit to follow the devtoolsScreencast plugin setting.",
        required: false,
      },
    },
    handler: async (p) => {
      const e = resolveEntry(explicitTarget(p));
      if (!e) return { ok: false, error: "no active browser view" };
      // DevTools 도 일반 브라우저 뷰다 — 새 뷰가 마운트되며 inspected(e.label)의 DevTools 프론트엔드를
      // 연다. 이후 분할/이동/닫기는 코어 view 커맨드(드래그와 동일 경로)로 동일하게 제어된다.
      return openDevtoolsTab(app, e.label, typeof p.screencast === "boolean" ? p.screencast : undefined);
    },
  });

  reg("open", {
    description: "Open a new browser content view, optionally at a URL.",
    triggers: { ko: "브라우저 열기 새탭 open" },
    params: { url: { type: "string", description: "URL to open (optional)", required: false } },
    handler: async (p) => {
      const url = typeof p.url === "string" ? p.url : undefined;
      if (url) setPendingUrl(normalizeUrl(url));
      const out = await app.commands!.execute("view.open", { program: "browser-chromium" }).catch(() => null);
      if (!out || !out.ok) {
        if (url) takePendingUrl();
        return { ok: false, error: "view.open failed" };
      }
      return { ok: true };
    },
  });
}
