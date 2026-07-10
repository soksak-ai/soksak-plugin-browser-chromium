// Chromium 엔진 어댑터 — browser-native 의 app.webview(OS 웹뷰 구동)와 동형 인터페이스를
// 엔진 사이드카 채널(app.sidecar → soksak-sidecar-browser-chromium, 계약 soksak-sidecar-browser-spec)로
// 구현한다. browser-view 의 슬롯추적·URL바·북마크 로직을 그대로 재사용하면서 엔진만 번들 Chromium
// 으로 바꾼다. 코어 비결합: 코어는 이 메시지들의 의미를 모른다(맹목 relay — docs/SIDECARS.md).
import { fieldOf, type Disposable, type PluginApi, type SidecarHandle, type WebviewApi } from "./host";
import { reconcileOrphans } from "./orphan-reconcile";

// label(전역 유일 문자열) → 엔진-로컬 browserId. browser-view 와 commands 가 공유(모듈 싱글턴).
//
// [유령 child 방지 — 창-스코프 영속] 이 매핑이 JS 메모리에만 있으면 window.reload(플러그인 JS 재기동)
// 시 소실되고, 이전 인스턴스가 만든 native child 는 아무도 못 닫는 유령이 된다(실측 — 파일 탭 위에
// 브라우저가 그대로 떠 있는 버그). sessionStorage 는 창별 + reload 생존이라 매핑의 정본으로 삼는다:
// 재기동 시 복원 → 다시 마운트되는 뷰가 기존 child 를 재사용(페이지 보존), ADOPT_GRACE_MS 안에
// 재사용되지 않은 child 는 회수(잔존 확정). 멀티창 안전 — 다른 창의 child 는 그 창의 저장소 소관.
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

// [수명주기 방벽 — kit lifecycle(claims)과의 관계] offscreen 은 kit 의 claim(공유 소유 장부,
// 발화 시점 재확인)으로 인스턴스 경계 close 경합을 막는다. 이 어댑터는 다른 방벽을 이미 보유한다:
// deactivate 시 cancelInstanceTimers 가 전 타이머를 소거(+instanceDead 로 이후 디바운스 차단)하고,
// 미인수 child 는 인수 유예 후 reconcile 이 회수한다. devLoad 는 deactivate 를 await 하므로 옛
// 타이머는 새 인스턴스보다 먼저 죽는다. 두 방벽은 등가 — 여기의 close 경로는 뷰 존재 판정
// (viewExistsAnywhere: 이동/파킹=보존, 닫힘=파괴)이 결합된 검증 행동이라 kit 흡수는 회귀 리스크가
// 이득을 초과한다고 판정(2026-07-10). 새 수명주기 코드는 kit 을 쓰라 — 여기만 예외로 남긴다.
const idByLabel = loadPersisted();
// eval 왕복 대기(evalId → resolve) — eval-result 이벤트(스펙 §8)로 완결된다.
const pendingEvals = new Map<number, (r: { ok: boolean; value: unknown }) => void>();
let evalWired = false;

// [유령 child 방지 — 생성 장부] 이 창이 만든 엔진 child id 의 매핑-독립 장부. 매핑(idByLabel)은 close
// 디바운스가 지우는데, 그 뒤 실제 파괴(send close)가 실패·증발하면(플러그인 reload 가 타이머를
// 지움, 채널 일시 실패) child 는 살아있는데 아무도 참조하지 않는 유령으로 잔존한다(실측 — 옛 크기
// surface 가 화면을 덮음). 장부는 생성 시 기록, reconcile(sweep)이 "엔진에 살아있는데 매핑 없는"
// id 를 회수하고 죽은 항목을 잊는다(자가치유). 창-스코프: 다른 창 child 는 장부 밖이라 안전.
const CREATED_KEY = "soksak-plugin-browser-chromium:created";
function loadCreated(): Set<number> {
  try {
    const raw = sessionStorage.getItem(CREATED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}
const allCreated = loadCreated();
function persistCreated(): void {
  try {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify([...allCreated]));
  } catch {
    /* 저장 불가 환경 — 영속 없이 동작 */
  }
}
function noteCreated(id: number): void {
  allCreated.add(id);
  persistCreated();
}

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
/** 진단: 이 창이 생성했던 child id 장부(reconcile 의 근거 — stats 커맨드 노출). */
export function ledgerSnapshot(): number[] {
  return [...allCreated];
}

/** 수동 회수(gc 커맨드) — sweep 의 장부 대조와 동일 로직을 즉시 실행하고 판정을 반환한다.
 *  잔존 의심 시 진단·회수 도구. 조회 실패면 아무것도 하지 않는다(장부 보존). */
export async function runReconcile(app: PluginApi): Promise<Record<string, unknown>> {
  const live = await engineStats(app);
  if (live == null) return { ok: false, reason: "engine stats unavailable" };
  const mapped = [...idByLabel.values()];
  // 회수 근거는 엔진의 소유 기록(stats.surfaces.owner) 우선 — 장부는 유실될 수 있다(스펙 §8
  // Ownership; offscreen 과 동일 규칙). owner 미지원(구 dylib)이면 장부 대조 폴백.
  const mine = await engineOwnedIds(app);
  const { close, forget } =
    mine != null
      ? { close: mine.filter((id) => !mapped.includes(id)), forget: [...allCreated].filter((id) => !live.includes(id)) }
      : reconcileOrphans({ live, mapped, ledger: [...allCreated] });
  for (const id of close) sendClose(app, id);
  for (const id of forget) allCreated.delete(id);
  if (forget.length) persistCreated();
  return { ok: true, live, mapped, ownerBased: mine != null, ledger: ledgerSnapshot(), closed: close, forgot: forget };
}

// 엔진이 이 플러그인 소유로 기록한 생존 id — owner 미지원 엔진이면 null(폴백 신호).
async function engineOwnedIds(app: PluginApi): Promise<number[] | null> {
  const st = await send(app, { type: "stats" }).catch(() => null);
  const surfaces = (st as { surfaces?: Array<{ id: number; owner: string }> } | null)?.surfaces;
  if (!Array.isArray(surfaces)) return null;
  return surfaces.filter((x) => x.owner === "soksak-plugin-browser-chromium").map((x) => x.id);
}

// 이전 JS 인스턴스에서 넘어온 미인수 label — open() 이 재사용하면 제거, grace 후 잔여는 회수.
const unclaimed = new Set<string>(idByLabel.keys());
let sweepScheduled = true; // 인스턴스당 1회 — 매핑이 비어도 장부 대조(reconcile)는 돌아야 한다.
// 이 인스턴스가 건 타이머(디바운스 파괴·sweep) — deactivate 시 전부 소거해 stale 클로저가
// reload 뒤 발화해 sessionStorage(다음 인스턴스의 매핑/장부)를 덮어쓰는 것을 막는다(실측 —
// 재사용 인계 실패 + 새 id 생성 + 옛 child 유령 잔존의 근원).
const instanceTimers = new Set<ReturnType<typeof setTimeout>>();

export function scheduleOrphanSweep(app: PluginApi): void {
  if (!sweepScheduled) return;
  sweepScheduled = false;
  const t = setTimeout(() => {
    instanceTimers.delete(t);
    // 1) 미인수 mapped child 회수(재사용 유예 만료).
    for (const label of unclaimed) {
      const id = idByLabel.get(label);
      idByLabel.delete(label);
      devtoolsByLabel.delete(label);
      if (id != null) {
        console.warn(`[browser-chromium] 미인수 child 회수: ${label} (id=${id})`);
        sendClose(app, id);
      }
    }
    unclaimed.clear();
    persist();
    persistDevtools();
    // 2) 엔진 대조 — 장부에 있는데 매핑이 참조하지 않는 생존 child = 유령 잔존(어떤 경로로 새었든) 회수.
    //    죽은 장부 항목은 잊는다. 다른 창 child(장부 밖)는 건드리지 않는다(orphan-reconcile.ts).
    void Promise.all([engineStats(app), engineOwnedIds(app)]).then(([live, mine]) => {
      if (live == null) return; // 엔진 조회 실패 — 장부 보존, 다음 인스턴스가 재시도(자가치유 유지)
      const mapped = [...idByLabel.values()];
      const { close, forget } =
        mine != null
          ? { close: mine.filter((id) => !mapped.includes(id)), forget: [...allCreated].filter((id) => !live.includes(id)) }
          : reconcileOrphans({ live, mapped, ledger: [...allCreated] });
      for (const id of close) {
        console.warn(`[browser-chromium] 미회수 잔존 child 회수: id=${id}`);
        sendClose(app, id);
      }
      for (const id of forget) allCreated.delete(id);
      if (forget.length) persistCreated();
    });
  }, ADOPT_GRACE_MS);
  instanceTimers.add(t);
}

/** deactivate 훅 — 이 인스턴스의 예약 타이머(디바운스 파괴·sweep)를 전부 소거한다. child 와 매핑은
 *  남긴다(다음 인스턴스가 재사용=페이지 보존, 인수되지 않으면 그쪽 reconcile 이 회수). */
let instanceDead = false;
export function cancelInstanceTimers(): void {
  instanceDead = true; // 이후 close() 는 디바운스를 걸지 않는다(아래) — 소거 뒤 등록되는 타이머 차단
  for (const t of instanceTimers) clearTimeout(t);
  instanceTimers.clear();
  for (const t of pendingClose.values()) clearTimeout(t);
  pendingClose.clear();
}

// close 디바운스 — 뷰 remount(unmount→즉시 mount)·split 이동 시 close 직후 open 이 오면 파괴를 취소하고
// 기존 child 를 재사용해 페이지를 보존한다(안 그러면 매번 about:blank 로 재생성 = 흰 화면 churn).
const pendingClose = new Map<string, ReturnType<typeof setTimeout>>();
const CLOSE_DEBOUNCE_MS = 600;

// close 를 보낸 엔진 id — 파괴 진행 중 child 에 어떤 op(bounds/hidden/navigate/중복 close)도 보내지
// 않는다. 엔진도 자체 가드(CLOSE_REQUESTED)가 있지만, 애초에 죽어가는 child 를 찌르지 않는 게
// 플러그인의 몫(실측 — 중복 close 의 hidden 경로가 파괴 중 view 를 만져 SIGSEGV).
const closeSent = new Set<number>();
// close 경로 단계 카운터 — stats 커맨드 노출(진단: close 유실/분기 오판을 즉시 관찰).
export const pluginDbg = {
  closeCalls: 0, instanceDeadSkip: 0, debounceSet: 0, debounceFired: 0,
  existsTrue: 0, existsFalse: 0, existsNull: 0, sendCloses: 0,
};
function sendClose(app: PluginApi, id: number): void {
  if (closeSent.has(id)) return;
  closeSent.add(id);
  pluginDbg.sendCloses++;
  void send(app, { type: "close", id });
}

// 뷰가 워크스페이스 어딘가(활성 프로젝트의 모든 sheet×panel)에 존재하는가 — 닫힘 판정의 단일 진실.
// bare view.list(활성 panel 만)로 판정하면 비활성 panel/다른 sheet 의 뷰를 "닫힘"으로 오판해 이동 중
// child 를 파괴한다(페이지 소실·devtools 동반닫힘 오발/불발 — 실측 flake). 비활성 프로젝트 축은 스캔
// 밖(프로젝트 전환은 언마운트-파킹 경로라 close 판정에 안 옴).
async function viewExistsAnywhere(app: PluginApi, viewId: string): Promise<boolean | null> {
  const cl = await app.commands?.execute("space.list", {}).catch(() => null);
  // 조회 자체가 실패(플러그인 dispose 중·부팅 경합)면 "없음"이 아니라 판단 불가(null) — 호출자는
  // 파괴하지 않는다(오판 파괴 = 살아있는 페이지 소실). 실제 "없음"은 조회 성공+미발견일 때만.
  if (cl == null) return null;
  const spaces = (fieldOf<{ id: string }[]>(cl, "spaces") ?? []).map((c) => c.id);
  for (const space of spaces.length ? spaces : [undefined]) {
    const pl = await app.commands
      ?.execute("panel.list", space ? { space } : {})
      .catch(() => null);
    const panels = (fieldOf<{ id: string }[]>(pl, "panels") ?? []).map((g) => g.id);
    for (const panel of panels) {
      const r = await app.commands?.execute("view.list", { panel }).catch(() => null);
      const views = fieldOf<{ id: string }[]>(r, "views") ?? null;
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
let lastEngineDbg: unknown = null;
/** 진단: 엔진 close 단계 카운터(마지막 stats 응답의 dbg). */
export function engineDbgSnapshot(): unknown {
  return lastEngineDbg;
}
export async function engineStats(app: PluginApi): Promise<number[] | null> {
  const out = await send(app, { type: "stats" });
  if (out && out.dbg !== undefined) lastEngineDbg = out.dbg;
  // 실패(null)와 "child 0개"([])를 구분한다 — 실패를 [] 로 뭉개면 reconcile 이 장부를 통째로
  // forget 해(전부 "죽음"으로 오판) 실제 잔존 child 가 영영 안 잡힌다(실측).
  if (out == null) return null;
  return Array.isArray(out.ids) ? (out.ids as number[]) : [];
}

// browser-view 가 기대하는 WebviewApi 를 Chromium 엔진으로 만족시킨다. v1 미지원 표면(eval/devtools/
// injectScript/nav·title 이벤트)은 안전한 no-op — 후속(DisplayHandler·CDP)에서.
export function makeChromium(app: PluginApi): WebviewApi {
  scheduleOrphanSweep(app); // 이전 JS 인스턴스 잔존 child — 재사용 유예 후 회수(1회)
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
      // window.reload 생존 child 재사용 — 이전 인스턴스의 매핑(sessionStorage 복원)에 있으면
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
          noteCreated(id);
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
        owner: "soksak-plugin-browser-chromium",
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
        noteCreated(id);
      }
    },

    bounds: async (label, x, y, w, h) => {
      const id = idByLabel.get(label);
      if (id == null || closeSent.has(id)) return;
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
      if (id == null || closeSent.has(id)) return;
      await send(app, { type: "hidden", id, hidden: !visible });
    },

    // 캡처는 창 합성(코어 능력)이라 엔진 무관 — 코어 webview 능력으로 위임("webview" 권한).
    captureRegion: async (rect) => {
      const core = app.webview;
      if (!core?.captureRegion) throw new Error("코어 webview 캡처 능력 없음(webview 권한 필요)");
      return core.captureRegion(rect);
    },

    navigate: async (label, url) => {
      const id = idByLabel.get(label);
      if (id == null || closeSent.has(id)) return;
      await send(app, { type: "load", id, url });
    },

    // 로딩 정지 — 엔진 stop verb(soksak-sidecar-browser-spec). 툴바의 reload↔stop 토글이 쓴다.
    stop: async (label) => {
      const id = idByLabel.get(label);
      if (id == null || closeSent.has(id)) return;
      await send(app, { type: "stop", id });
    },

    history: async (label, delta) => {
      const id = idByLabel.get(label);
      if (id == null || closeSent.has(id)) return;
      await send(app, { type: delta < 0 ? "back" : "forward", id });
    },

    close: async (label) => {
      pluginDbg.closeCalls++;
      const id = idByLabel.get(label);
      if (id == null) return;
      // deactivate(reload) 뒤의 unmount-close — 파괴를 예약하지 않는다. 이 시점의 판정 커맨드는
      // 이미 dispose 돼 "뷰 없음"으로 오판하고(실측 — 살아있는 뷰의 child 파괴 + 매핑 "{}" 클로버
      // → 재사용 인계 실패), child 는 다음 인스턴스가 재사용하거나 reconcile 이 회수한다.
      if (instanceDead) {
        pluginDbg.instanceDeadSkip++;
        return;
      }
      if (pendingClose.has(label)) return; // 이미 파괴 예약됨
      // 즉시 숨김 판정(단발): 뷰가 워크스페이스에서 이미 사라졌으면 진짜 닫힘 — 서피스를 지금 숨긴다.
      // 파괴 확정은 아래 디바운스 그대로(재사용 보호). 안 숨기면 탭은 닫혔는데 native child 가
      // 디바운스+close_browser 왕복(수 초) 동안 화면에 잔존한다(실측 — DevTools 닫기 2~3s 유령).
      // 이동(unmount→remount)이면 뷰가 아직 목록에 있어 숨기지 않는다(이동 중 깜빡임 방지).
      {
        // inline DevTools child(label "#dt" 접미)는 자기 뷰가 없다 — 호스트 뷰 존재로 판정.
        const viewId = label.slice("chromium-".length).split("#")[0];
        void viewExistsAnywhere(app, viewId)
          .then((exists) => {
            if (exists === false && pendingClose.has(label)) {
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
          pluginDbg.debounceFired++;
          pendingClose.delete(label);
          // 단발 판정(폴링 아님 — 파괴 결정 시점 1회): 뷰가 아직 워크스페이스 어딘가에 있으면
          // 이동/비활성 탭 파킹 — child 보존(숨김만, 활성화 시 open 이 표시 복원).
          // inline DevTools child(label "#dt" 접미)는 자기 뷰가 없다 — 호스트 뷰 존재로 판정.
          const viewId = label.slice("chromium-".length).split("#")[0];
          const exists = await viewExistsAnywhere(app, viewId);
          if (exists === true) pluginDbg.existsTrue++;
          else if (exists === false) pluginDbg.existsFalse++;
          else pluginDbg.existsNull++;
          if (exists !== false) {
            // true=이동/파킹(숨김만) · null=판단 불가(보존 — 오판 파괴 금지, reconcile 이 후처리)
            if (exists) void send(app, { type: "hidden", id, hidden: true });
            return; // 매핑 유지 — 재마운트가 재사용
          }
          idByLabel.delete(label);
          devtoolsByLabel.delete(label);
          inlineByLabel.delete(label);
          persist();
          persistDevtools();
          persistInline();
          sendClose(app, id);
          // 파킹된 inline DevTools child 회수 — 토글 오프 상태로 호스트가 진짜 닫히면 소유
          // 컴포넌트가 없어 아무도 못 닫는다(유령). inline 열림 상태면 그쪽 디바운스도 닫는데,
          // 이미 닫힌 id 의 close 는 엔진이 조용히 건너뛴다(중복 무해).
          const dtInline = idByLabel.get(`${label}#dt`);
          if (dtInline != null) {
            idByLabel.delete(`${label}#dt`);
            persist();
            sendClose(app, dtInline);
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
      pluginDbg.debounceSet++;
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
        event === "open-external" ? "popup-url" : event === "nav" || event === "title" || event === "loading" || event === "favicon" ? event : null;
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
            if (engineEvent === "popup-url" || engineEvent === "favicon") cb({ url: p.url });
            else if (engineEvent === "loading")
              cb({ loading: !!p.loading, canBack: !!p.canBack, canForward: !!p.canForward });
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
    // 페이지 JS 실행(엔진 eval verb, 스펙 §8) — body 는 async 함수 본문, JSON 직렬화 값을 return.
    // 결과는 eval-result 이벤트로 회수한다. WebviewApi.eval 의 문자열 계약(native/WKWebView 유래)과
    // 맞추기 위해 값을 JSON 문자열로 돌려준다 — 소비자(evalJson 류)가 JSON.parse 한다.
    eval: async (label: string, body: string): Promise<string> => {
      const id = idByLabel.get(label);
      if (id == null) throw new Error(`no engine child for ${label}`);
      const h = await engine(app);
      if (!evalWired) {
        evalWired = true;
        h.on("eval-result", (p) => {
          const cb = typeof p.evalId === "number" ? pendingEvals.get(p.evalId as number) : undefined;
          if (cb) cb({ ok: !!p.ok, value: p.value });
        });
      }
      const out = await h.send({ type: "eval", id, js: body });
      const evalId = (out as { evalId?: number }).evalId;
      if (typeof evalId !== "number") throw new Error(String((out as { error?: string }).error ?? "eval 실패"));
      const r = await new Promise<{ ok: boolean; value: unknown }>((resolve) => {
        const t = setTimeout(() => {
          pendingEvals.delete(evalId);
          resolve({ ok: false, value: "eval 응답 시간 초과" });
        }, 15000);
        pendingEvals.set(evalId, (res) => {
          clearTimeout(t);
          pendingEvals.delete(evalId);
          resolve(res);
        });
      });
      if (!r.ok) throw new Error(String(r.value));
      return JSON.stringify(r.value === undefined ? null : r.value);
    },
    injectScript: () => noop,
    list: async (prefix?: string) =>
      [...idByLabel.keys()].filter((l) => !prefix || l.startsWith(prefix)),
  };
}
