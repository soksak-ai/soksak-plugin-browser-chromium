// Chromium 엔진 어댑터 — browser-native 의 app.webview(OS 웹뷰 구동)와 동형 인터페이스를
// 엔진 사이드카 채널(app.sidecar → soksak-sidecar-browser-chromium, 계약 soksak-sidecar-browser-spec)로
// 구현한다. browser-view 의 슬롯추적·URL바·북마크 로직을 그대로 재사용하면서 엔진만 번들 Chromium
// 으로 바꾼다. 코어 비결합: 코어는 이 메시지들의 의미를 모른다(맹목 relay — docs/SIDECARS.md).
import type { Disposable, PluginApi, SidecarHandle, WebviewApi } from "./host";

// label(전역 유일 문자열) → 엔진-로컬 browserId. browser-view 와 commands 가 공유(모듈 싱글턴).
//
// [고아 방지 — 창-스코프 영속] 이 매핑이 JS 메모리에만 있으면 window.reload(플러그인 JS 재기동)
// 시 소실되고, 이전 인스턴스가 만든 native child 는 아무도 못 닫는 유령이 된다(실측 — 파일 탭 위에
// 브라우저가 그대로 떠 있는 버그). sessionStorage 는 창별 + reload 생존이라 매핑의 정본으로 삼는다:
// 재기동 시 복원 → 다시 마운트되는 뷰는 기존 child 를 "입양"(페이지 보존), ADOPT_GRACE_MS 안에
// 입양되지 않은 child 는 회수(진짜 고아). 멀티창 안전 — 다른 창의 child 는 그 창의 저장소 소관.
const STORE_KEY = "soksak-plugin-browser-chromium:children";
const ADOPT_GRACE_MS = 5000;

function loadPersisted(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, number>));
  } catch {
    return new Map();
  }
}
function persist(): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(idByLabel)));
  } catch {
    /* 저장 불가 환경(테스트 등) — 영속 없이 동작 */
  }
  // devtools "열림" 판정(devtoolsLabelFor)은 idByLabel 생존도 본다 — 매핑 변이 통지 공유.
  for (const cb of dtMapListeners) cb();
}

const idByLabel = loadPersisted();

// devtools 마커 — "이 label 은 inspected(값) 브라우저의 DevTools 탭"이라는 정체성. 드래그 분할/이동은
// 뷰 unmount→remount 라서 1회성 pending 값으로는 재마운트에서 정체성이 소실된다(일반 툴바가 나타나는
// 오동작) → idByLabel 과 같은 sessionStorage 영속(창별·reload 생존). 파괴 확정 시에만 지운다.
const DT_KEY = "soksak-plugin-browser-chromium:devtools";
function loadDevtoolsMarks(): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(DT_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  } catch {
    return new Map();
  }
}
const devtoolsByLabel = loadDevtoolsMarks();
// devtools 매핑 변화 구독 — 툴바 버튼의 "열림" 표시 등 UI 가 반응(폴링 금지). 모든 매핑 변이는
// persistDevtools 를 지나므로 여기가 단일 통지 지점.
const dtMapListeners = new Set<() => void>();
export function subscribeDevtoolsMap(cb: () => void): () => void {
  dtMapListeners.add(cb);
  return () => {
    dtMapListeners.delete(cb);
  };
}
function persistDevtools(): void {
  try {
    sessionStorage.setItem(DT_KEY, JSON.stringify(Object.fromEntries(devtoolsByLabel)));
  } catch {
    /* 저장 불가 환경 — 영속 없이 동작 */
  }
  for (const cb of dtMapListeners) cb();
}
/** label 이 DevTools 탭이면 inspected label, 아니면 null. */
export function devtoolsMarkOf(label: string): string | null {
  return devtoolsByLabel.get(label) ?? null;
}
/** inspected 브라우저의 살아있는 DevTools "탭" label(중복 열기 방지·열림 표시용). 없으면 null.
 *  inline child(label "#dt" 접미)는 탭이 아니다 — 파킹돼 살아있어도 탭 판정에서 제외. */
export function devtoolsLabelFor(inspectedLabel: string): string | null {
  for (const [l, insp] of devtoolsByLabel)
    if (insp === inspectedLabel && !l.includes("#dt") && idByLabel.has(l)) return l;
  return null;
}
/** 진단: devtools label → inspected label 매핑 스냅샷(stats 커맨드 노출 — E2E/디버깅). */
export function devtoolsMapSnapshot(): Record<string, string> {
  return Object.fromEntries(devtoolsByLabel);
}

// ── inline DevTools(같은 탭 내부 분할) 마커 ─────────────────────────────────────
// label(호스트 브라우저) → { ratio: 분할축에서 페이지 몫(0..1), side: DevTools 도킹 방향 }.
// 존재 = inline DevTools 열림. devtoolsByLabel 과 같은 sessionStorage 영속 — 이동·reload 생존.
export type InlineSide = "top" | "bottom" | "left" | "right";
export interface InlineMark {
  ratio: number;
  side: InlineSide;
}
const INLINE_KEY = "soksak-plugin-browser-chromium:inline";
function loadInline(): Map<string, InlineMark> {
  try {
    const raw = sessionStorage.getItem(INLINE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, number | InlineMark>;
    const m = new Map<string, InlineMark>();
    for (const [k, v] of Object.entries(obj)) {
      // 구형(숫자 = ratio만) → bottom 도킹으로 승격.
      m.set(k, typeof v === "number" ? { ratio: v, side: "bottom" } : v);
    }
    return m;
  } catch {
    return new Map();
  }
}
const inlineByLabel = loadInline();
function persistInline(): void {
  try {
    sessionStorage.setItem(INLINE_KEY, JSON.stringify(Object.fromEntries(inlineByLabel)));
  } catch {
    /* 저장 불가 환경 — 영속 없이 동작 */
  }
}
/** inline DevTools 가 열려 있으면 { ratio, side }, 아니면 null. */
export function inlineMarkOf(label: string): InlineMark | null {
  return inlineByLabel.get(label) ?? null;
}
export function setInlineMark(label: string, mark: InlineMark): void {
  inlineByLabel.set(label, mark);
  persistInline();
}
export function clearInlineMark(label: string): void {
  inlineByLabel.delete(label);
  persistInline();
}
/** 진단: label → 엔진 child id 매핑 스냅샷. */
export function idMapSnapshot(): Record<string, number> {
  return Object.fromEntries(idByLabel);
}

// 이전 JS 인스턴스에서 넘어온 미입양 label — open() 이 입양하면 제거, grace 후 잔여는 회수.
const unclaimed = new Set<string>(idByLabel.keys());
let sweepScheduled = idByLabel.size > 0;

function scheduleOrphanSweep(app: PluginApi): void {
  if (!sweepScheduled) return;
  sweepScheduled = false;
  setTimeout(() => {
    for (const label of unclaimed) {
      const id = idByLabel.get(label);
      idByLabel.delete(label);
      devtoolsByLabel.delete(label);
      if (id != null) {
        console.warn(`[browser-chromium] 미입양 child 회수: ${label} (id=${id})`);
        void send(app, { type: "close", id });
      }
    }
    unclaimed.clear();
    persist();
    persistDevtools();
  }, ADOPT_GRACE_MS);
}

// close 디바운스 — 뷰 remount(unmount→즉시 mount)·split 이동 시 close 직후 open 이 오면 파괴를 취소하고
// 기존 child 를 재사용해 페이지를 보존한다(안 그러면 매번 about:blank 로 재생성 = 흰 화면 churn).
const pendingClose = new Map<string, ReturnType<typeof setTimeout>>();
const CLOSE_DEBOUNCE_MS = 600;

// 뷰가 워크스페이스 어딘가(활성 프로젝트의 모든 content×그룹)에 존재하는가 — 닫힘 판정의 단일 진실.
// bare view.list(활성 그룹만)로 판정하면 비활성 그룹/다른 content 의 뷰를 "닫힘"으로 오판해 이동 중
// child 를 파괴한다(페이지 소실·devtools 동반닫힘 오발/불발 — 실측 flake). 비활성 프로젝트 축은 스캔
// 밖(프로젝트 전환은 언마운트-파킹 경로라 close 판정에 안 옴).
async function viewExistsAnywhere(app: PluginApi, viewId: string): Promise<boolean> {
  const cl = await app.commands?.execute("content.list", {}).catch(() => null);
  const contents = ((cl && (cl.contents as { id: string }[] | undefined)) || []).map((c) => c.id);
  for (const content of contents.length ? contents : [undefined]) {
    const pl = await app.commands
      ?.execute("panel.list", content ? { content } : {})
      .catch(() => null);
    const groups = ((pl && (pl.panels as { id: string }[] | undefined)) || []).map((g) => g.id);
    for (const g of groups) {
      const r = await app.commands?.execute("view.list", { group: g }).catch(() => null);
      const views = (r && (r.views as { id: string }[] | undefined)) || null;
      if (views && views.some((v) => v.id === viewId)) return true;
    }
  }
  return false;
}

const noop: Disposable = { dispose() {} };

// 사이드카 채널 lazy 싱글턴 — 최초 open 이 dlopen+검증+init(코어). 실패 시 다음 시도에 재개.
let handleP: Promise<SidecarHandle> | null = null;
function engine(app: PluginApi): Promise<SidecarHandle> {
  if (!app.sidecar) return Promise.reject(new Error("sidecar 권한/선언 없음"));
  if (!handleP) {
    handleP = app.sidecar.open("browser-chromium").catch((e) => {
      handleP = null; // 실패는 캐시하지 않는다(스테이징 후 재시도 가능)
      throw e;
    });
  }
  return handleP;
}

async function send(
  app: PluginApi,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const h = await engine(app);
    return await h.send(msg);
  } catch (e) {
    console.warn("[browser-chromium] send 실패:", e);
    return null;
  }
}

/** 엔진 child id 목록(E2E/진단) — close 가 child 를 실제 파괴했는지의 단일 진실(뷰 수만으론 유령을 못 잡는다). */
export async function engineStats(app: PluginApi): Promise<number[]> {
  const out = await send(app, { type: "stats" });
  return out && Array.isArray(out.ids) ? (out.ids as number[]) : [];
}

// browser-view 가 기대하는 WebviewApi 를 Chromium 엔진으로 만족시킨다. v1 미지원 표면(eval/devtools/
// injectScript/nav·title 이벤트)은 안전한 no-op — 후속(DisplayHandler·CDP)에서.
export function makeChromium(app: PluginApi): WebviewApi {
  scheduleOrphanSweep(app); // 이전 JS 인스턴스 잔존 child — 입양 유예 후 회수(1회)
  return {
    label: (viewId: string) => `chromium-${viewId}`,

    open: async (label, o) => {
      // remount/split: 방금 close 예약된 label 이면 파괴 취소 + 기존 child 재사용(다시 표시, 페이지 보존).
      const pc = pendingClose.get(label);
      if (pc) {
        clearTimeout(pc);
        pendingClose.delete(label);
        const rid = idByLabel.get(label);
        if (rid != null) {
          void send(app, { type: "hidden", id: rid, hidden: false });
          return;
        }
      }
      // window.reload 생존 child 입양 — 이전 인스턴스의 매핑(sessionStorage 복원)에 있으면
      // 재생성 대신 재사용(페이지 보존). 표시 상태만 되살린다(bounds 는 슬롯 추적이 곧 동기화).
      if (unclaimed.has(label)) {
        unclaimed.delete(label);
        const rid = idByLabel.get(label);
        if (rid != null) {
          void send(app, { type: "hidden", id: rid, hidden: false });
          return;
        }
      }
      {
        // 이미 있음(보존된 child 의 재마운트) — 재생성 대신 표시만 복원(페이지 보존).
        const rid = idByLabel.get(label);
        if (rid != null) {
          void send(app, { type: "hidden", id: rid, hidden: false });
          return;
        }
      }
      // DevTools 뷰 — URL 브라우저가 아니라 inspected(devtoolsOf) 브라우저의 DevTools 를 임베드 child 로
      // 붙인다. 결과 id 는 일반 브라우저 id 와 동급이라 이 label 에 매핑만 하면 bounds/hidden/close·분할·
      // 이동이 전부 아래 일반 경로로 동작한다. inspected 가 이미 닫혔으면(id 없음) 조용히 포기.
      if (o.devtoolsOf) {
        const inspectedId = idByLabel.get(o.devtoolsOf);
        if (inspectedId == null) {
          console.warn(`[browser-chromium] devtools 대상 미존재: ${o.devtoolsOf}`);
          return;
        }
        // screencast(페이지 미리보기 패널): 명시 오버라이드 > 플러그인 설정. 프로필이 in-memory 라
        // DevTools 자체 토글은 세션마다 증발 — 이 값이 정본(엔진이 로드 후 localStorage 에 강제).
        const screencast =
          o.devtoolsScreencast ?? app.settings?.get("devtoolsScreencast") === true;
        const out = await send(app, {
          type: "devtools-open",
          inspectedId,
          screencast,
          x: Math.round(o.x),
          y: Math.round(o.y),
          w: Math.max(1, Math.round(o.w)),
          h: Math.max(1, Math.round(o.h)),
        });
        const id = out && typeof out.id === "number" ? out.id : null;
        if (id != null) {
          idByLabel.set(label, id);
          devtoolsByLabel.set(label, o.devtoolsOf);
          persist();
          persistDevtools();
        }
        return;
      }
      // 새 링크 열기 정책(browserNewWindow) 반영 — 엔진 on_before_popup 이 이 값으로 라우팅한다.
      const asWindow = app.settings?.get("browserNewWindow") === "window";
      void send(app, { type: "popup-mode", asWindow });
      const out = await send(app, {
        type: "create",
        x: Math.round(o.x),
        y: Math.round(o.y),
        w: Math.max(1, Math.round(o.w)),
        h: Math.max(1, Math.round(o.h)),
        url: o.url,
      });
      const id = out && typeof out.id === "number" ? out.id : null;
      if (id != null) {
        idByLabel.set(label, id);
        persist();
      }
    },

    bounds: async (label, x, y, w, h) => {
      const id = idByLabel.get(label);
      if (id == null) return;
      await send(app, {
        type: "bounds",
        id,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.max(1, Math.round(w)),
        h: Math.max(1, Math.round(h)),
      });
    },

    visible: async (label, visible) => {
      const id = idByLabel.get(label);
      if (id == null) return;
      await send(app, { type: "hidden", id, hidden: !visible });
    },

    navigate: async (label, url) => {
      const id = idByLabel.get(label);
      if (id == null) return;
      await send(app, { type: "load", id, url });
    },

    history: async (label, delta) => {
      const id = idByLabel.get(label);
      if (id == null) return;
      await send(app, { type: delta < 0 ? "back" : "forward", id });
    },

    close: async (label) => {
      const id = idByLabel.get(label);
      if (id == null) return;
      if (pendingClose.has(label)) return; // 이미 파괴 예약됨
      // 즉시 숨김 판정(단발): 뷰가 워크스페이스에서 이미 사라졌으면 진짜 닫힘 — 서피스를 지금 숨긴다.
      // 파괴 확정은 아래 디바운스 그대로(입양 보호). 안 숨기면 탭은 닫혔는데 native child 가
      // 디바운스+close_browser 왕복(수 초) 동안 화면에 잔존한다(실측 — DevTools 닫기 2~3s 유령).
      // 이동(unmount→remount)이면 뷰가 아직 목록에 있어 숨기지 않는다(이동 중 깜빡임 방지).
      {
        // inline DevTools child(label "#dt" 접미)는 자기 뷰가 없다 — 호스트 뷰 존재로 판정.
        const viewId = label.slice("chromium-".length).split("#")[0];
        void viewExistsAnywhere(app, viewId)
          .then((exists) => {
            if (!exists && pendingClose.has(label)) {
              void send(app, { type: "hidden", id, hidden: true });
            }
          })
          .catch(() => {});
      }
      // 파괴를 디바운스 — remount(unmount→즉시 mount)면 open 이 취소하고 기존 child 를 재사용해
      // 페이지를 보존한다. 진짜 닫힘이면 CLOSE_DEBOUNCE_MS 후 실제 파괴. idByLabel 은 파괴 확정
      // 시에만 지운다(재사용 위해 유지).
      const t = setTimeout(() => {
        void (async () => {
          pendingClose.delete(label);
          // 단발 판정(폴링 아님 — 파괴 결정 시점 1회): 뷰가 아직 워크스페이스 어딘가에 있으면
          // 이동/비활성 탭 파킹 — child 보존(숨김만, 활성화 시 open 이 표시 복원).
          // inline DevTools child(label "#dt" 접미)는 자기 뷰가 없다 — 호스트 뷰 존재로 판정.
          const viewId = label.slice("chromium-".length).split("#")[0];
          if (await viewExistsAnywhere(app, viewId)) {
            void send(app, { type: "hidden", id, hidden: true });
            return; // 매핑 유지 — 재마운트가 입양
          }
          idByLabel.delete(label);
          devtoolsByLabel.delete(label);
          inlineByLabel.delete(label);
          persist();
          persistDevtools();
          persistInline();
          void send(app, { type: "close", id });
          // 파킹된 inline DevTools child 회수 — 토글 오프 상태로 호스트가 진짜 닫히면 소유
          // 컴포넌트가 없어 아무도 못 닫는다(유령). inline 열림 상태면 그쪽 디바운스도 닫는데,
          // 이미 닫힌 id 의 close 는 엔진이 조용히 건너뛴다(중복 무해).
          const dtInline = idByLabel.get(`${label}#dt`);
          if (dtInline != null) {
            idByLabel.delete(`${label}#dt`);
            persist();
            void send(app, { type: "close", id: dtInline });
          }
          // 검사 대상이 진짜 닫힘 — 그 DevTools 탭도 함께 닫는다(Chrome 동형). 대상 없는 DevTools 는
          // ws 가 끊겨 "Debugging connection was closed" 잔해가 되고 재접속도 불가(타깃 소멸).
          for (const [dtLabel, inspected] of devtoolsByLabel) {
            if (inspected === label) {
              const dtViewId = dtLabel.slice("chromium-".length);
              void app.commands?.execute("view.close", { view: dtViewId }).catch(() => {});
            }
          }
        })();
      }, CLOSE_DEBOUNCE_MS);
      pendingClose.set(label, t);
    },

    // 이벤트 배선 — 엔진 채널 이벤트를 label 단위 콜백으로 demux.
    //   nav/title = DisplayHandler(주소·제목 변화, id 필터 = 이 label 의 child 만) → URL 바·탭 제목.
    //   open-external = 새 링크(target=_blank/window.open). "새 탭" 모드에선 엔진 on_before_popup 이
    //   팝업을 취소하고 {event:"popup-url", url, id} 를 배달 → browser-view 의 openExternal(새 인앱
    //   탭)로. id = 소스 브라우저(자기 소유만 소비 — 멀티창 중복 수신 방지; id 미상(null)은 단일
    //   소비자 가정으로 수용). "새 창" 모드는 엔진이 네이티브 팝업으로 직접 처리.
    on: (label, event, cb) => {
      const engineEvent =
        event === "open-external" ? "popup-url" : event === "nav" || event === "title" ? event : null;
      if (!engineEvent) return noop;
      let un: Disposable | null = null;
      let disposed = false;
      void engine(app)
        .then((h) => {
          const d = h.on(engineEvent, (p) => {
            const src = typeof p.id === "number" ? (p.id as number) : null;
            // 모든 이벤트는 "소스 id == 이 label 의 child" 정확 매칭으로만 소비한다. popup 도
            // 동일 — 구독자(뷰)마다 콜백이 불리므로 느슨한 창-소유 필터는 뷰 수만큼 탭을
            // 중복 생성한다(실측: 뷰 7개 → 새 탭 7개). 소스 뷰 하나만 연다.
            if (src == null || idByLabel.get(label) !== src) return;
            if (engineEvent === "popup-url") cb({ url: p.url });
            else cb(engineEvent === "nav" ? { url: p.url } : { title: p.title });
          });
          if (disposed) d.dispose();
          else un = d;
        })
        .catch(() => {});
      return {
        dispose() {
          disposed = true;
          un?.dispose();
        },
      };
    },
    // 나머지 v1 미지원 — 안전한 no-op. openWindow 는 "새 창" 모드를 엔진이 네이티브로 처리하므로 불요.
    openWindow: async () => {},
    eval: async () => "",
    injectScript: () => noop,
    list: async (prefix?: string) =>
      [...idByLabel.keys()].filter((l) => !prefix || l.startsWith(prefix)),
  };
}
