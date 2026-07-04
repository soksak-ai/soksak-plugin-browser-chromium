// 코어 플러그인 API 중 browser 플러그인이 쓰는 표면만 선언.
// soksak-plugin-spec v1 의 SoksakPluginApi 와 동형 — 별도 repo, 코어 소스 비의존.
// 미선언 권한 표면은 런타임에 undefined.

export interface Disposable {
  dispose(): void;
}

// 코어 viewRegistry.PluginViewContext 와 동형.
// viewId = sessions view.id(콘텐츠 배치 인스턴스 안정 키). 사이드바 배치 = null.
export interface PluginViewContext {
  projectId: string;
  root: string | null;
  paneId: string | null;
  viewId: string | null;
  setBadge: (badge: number | "dot" | null) => void;
  setStatus: (status: { code: string; message?: string } | null) => void;
  setTitle: (title: string) => void;
}

export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
}

export interface ParamSpec {
  type: string;
  description?: string;
  required?: boolean;
}

export interface PluginCommandSpec {
  description: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  returns?: string;
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}

export interface CommandOutcome {
  ok: boolean;
  [k: string]: unknown;
}

// app.webview — 코어 네이티브 child webview(WKWebView) 구동.
export interface WebviewApi {
  /** viewId → 전역 유일 label(창 네임스페이스). webviewLabels 단일 진실. */
  label: (viewId: string) => string;
  /** child webview 생성 + 슬롯 rect 에 임베드. 이미 있으면 no-op.
   *  devtoolsOf(inspected label) 지정 시 URL 브라우저 대신 그 브라우저의 DevTools 를 임베드 child 로 연다.
   *  devtoolsScreencast: DevTools 페이지 미리보기 패널(생략 시 설정 devtoolsScreencast 를 따른다). */
  open: (
    label: string,
    o: {
      url: string;
      x: number;
      y: number;
      w: number;
      h: number;
      devtoolsOf?: string;
      devtoolsScreencast?: boolean;
    },
  ) => Promise<void>;
  /** 슬롯 rect 동기화(분할/리사이즈 — 프레임당 1회 권장). */
  bounds: (label: string, x: number, y: number, w: number, h: number) => Promise<void>;
  /** 표시/숨김(탭 전환·최대화의 숨김 슬롯). */
  visible: (label: string, visible: boolean) => Promise<void>;
  /** URL 이동. */
  navigate: (label: string, url: string) => Promise<void>;
  /** URL 을 독립 OS 창(새 브라우저 윈도우)으로 연다. browserNewWindow="window" 모드용. */
  openWindow: (url: string) => Promise<void>;
  /** 세션 히스토리 이동(delta=-1 뒤/+1 앞). */
  history: (label: string, delta: number) => Promise<void>;
  /** 페이지에서 JS 실행 후 결과 문자열 반환(AI/E2E DOM 제어). macOS 한정. */
  eval: (label: string, js: string) => Promise<string>;
  /** init script 주입(document-start/end, 매 내비게이션 재주입). macOS 한정(비-macOS no-op).
   *  반환 Disposable 은 추적용 — WKUserScript 개별 제거는 미지원(webview 수명까지 유지). */
  injectScript: (
    label: string,
    code: string,
    phase?: "document-start" | "document-end",
  ) => Disposable;
  /** webview 이벤트 구독: "nav"({url})·"title"({title})·"status"·"open-external"({url}). 반환=해지. */
  on: (
    label: string,
    event: "nav" | "title" | "status" | "open-external",
    cb: (payload: Record<string, unknown>) => void,
  ) => Disposable;
  /** 현재 살아있는 webview label 목록(prefix 필터). GC/정리용. */
  list: (prefix?: string) => Promise<string[]>;
  /** webview 종료 + 정리. */
  close: (label: string) => Promise<void>;
  /** 창 합성 캡처를 rect(CSS px, 창 좌표)로 crop 한 PNG data URL. 가림 상태에서도 캡처.
   *  드래그 중 표면의 시각 연속 스탠드인(freeze-frame — layout.resize-gesture 와 짝).
   *  어댑터에서는 코어 webview 능력으로 위임(캡처는 창 합성이라 엔진 무관). */
  captureRegion: (rect: { x: number; y: number; w: number; h: number }) => Promise<string>;
}

// app.sidecar — 엔진 사이드카(공유 네이티브 모듈) 채널. 코어는 맹목 relay(docs/SIDECARS.md).
export interface SidecarHandle {
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => Disposable;
  close: () => Promise<void>;
}

// app.data.kv — 즐겨찾기 저장에 쓰는 표면만.
export interface DataKvApi {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  keys: (prefix?: string) => Promise<string[]>;
  watch: (cb: (key: string | null) => void) => Disposable;
}

export interface DataApi {
  kv: DataKvApi;
}

export interface PluginApi {
  pluginId: string;
  locale: () => string;
  commands?: {
    register: (name: string, spec: PluginCommandSpec) => Disposable;
    execute: (name: string, params?: Record<string, unknown>) => Promise<CommandOutcome>;
  };
  events: {
    on: (event: string, fn: (payload: unknown) => void) => Disposable;
    /** 진행 델타 발행(MESSAGE-PROTOCOL §2) — 장시간 명령의 실행 중 상태. 구코어 호환 optional. */
    progress?: (command: string, delta: unknown) => void;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
  };
  webview?: WebviewApi;
  sidecar?: {
    open: (name: string) => Promise<SidecarHandle>;
  };
  data?: DataApi;
  bus: {
    emit: (topic: string, payload: unknown) => void;
    on: (topic: string, fn: (payload: unknown) => void) => Disposable;
  };
  project: {
    current: () => { id: string; root: string | null } | null;
  };
  settings: {
    get: (key: string) => unknown;
    all: () => Record<string, unknown>;
    onChange: (cb: (all: Record<string, unknown>) => void) => Disposable;
  };
}

export interface PluginContext {
  app: PluginApi;
  manifest: unknown;
  dir: string;
  subscriptions: Disposable[];
}
