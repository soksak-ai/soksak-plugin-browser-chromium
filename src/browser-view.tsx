// 브라우저 콘텐츠 뷰 — 코어 native child webview(WKWebView) 를 플러그인에서 직접 구동.
// BrowserView.tsx(코어) 의 충실한 이식:
//   - app.webview.* API 로 invoke 교체
//   - ctx.viewId 로 label 파생
//   - app.data.kv 로 즐겨찾기 저장(key: bm:<url>)
//   - useSessions 구독 제거 → ResizeObserver + window resize 로 대체
//   - 아이콘: lucide-style inline SVG(코어 Icon 컴포넌트 비의존)

import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { PluginApi, PluginViewContext } from "./host";
import { t } from "./i18n";
import {
  makeChromium,
  devtoolsMarkOf,
  devtoolsLabelFor,
  subscribeDevtoolsMap,
  inlineMarkOf,
  setInlineMark,
  clearInlineMark,
  type InlineMark,
  type InlineSide,
} from "./chromium-adapter";
import {
  registerLabel,
  unregisterLabel,
  setPendingUrl,
  takePendingUrl,
  openDevtoolsTab,
  registerInlineController,
} from "./commands";
import type { WebviewApi } from "./host";

// ── IME 조합 중 Enter 무시 (코어 imeKeys.ts 이식) ────────────────────────────
function isComposingEnter(
  e: React.KeyboardEvent,
): boolean {
  return e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229);
}

// 드래그(라이브 리사이즈) 중 네이티브 webview 재배치 상한. WKWebView set_size 는 비싸서
// 매 프레임(60~120Hz) 호출하면 OS 자체 라이브 리사이즈와 겹쳐 CPU 가 폭발한다 → ~30Hz 로
// 제한하고 드래그 끝에 정확한 최종 rect 로 1회 스냅한다(시각 추종은 유지).
const LIVE_THROTTLE_MS = 32;
// inline divider 이중 시작 가드 — divider 는 DOM 띠라 실 mousedown 을 받고, 코어 네이티브
// 브릿지([data-native-drag])도 합성 mousedown 을 쏜다(child 위로 드래그가 이어지도록). 둘 중
// 먼저 온 쪽만 리스너를 건다(코어 그룹 divider 의 resizeDragActive 와 동형).
let dtDividerDragActive = false;
// 슬롯 rect 가 이 프레임 수만큼 연속 무변화면(=드래그 아님) 추종 루프를 멈춘다(idle 폴링 0).
const STABLE_STOP_FRAMES = 4;

// 디바이더 드래그(layout.resize-gesture) 진행 여부 — 모듈 스코프: 본체 뷰가 구독·갱신하고
// inline DevTools 컴포넌트의 bounds 싱크도 같은 게이트를 본다(둘 다 이 파일).
// 드래그 동안 surface bounds 커밋을 전면 유예한다(성능 헌법 5·5a).
let resizeGestureActive = false;

// ── URL 정규화 (코어 BrowserView.tsx 와 동일) ────────────────────────────────
function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  if (!s.includes(" ") && s.includes(".")) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// ── 즐겨찾기 타입 ────────────────────────────────────────────────────────────
interface Bookmark {
  url: string;
  title: string;
}

// ── Inline SVG 아이콘 (lucide-style, stroke=currentColor) ────────────────────
function IconBack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function IconForward() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function IconReload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function IconStarFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
function IconStar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
// 도킹 방향 아이콘 — 사각 외곽 + 도킹 변의 채움 막대(VSCode 패널 위치 아이콘 동형).
function IconDock({ side }: { side: "top" | "bottom" | "left" | "right" }) {
  const bar =
    side === "bottom" ? (
      <rect x="5" y="13" width="14" height="6" rx="1" fill="currentColor" stroke="none" />
    ) : side === "top" ? (
      <rect x="5" y="5" width="14" height="6" rx="1" fill="currentColor" stroke="none" />
    ) : side === "left" ? (
      <rect x="5" y="5" width="6" height="14" rx="1" fill="currentColor" stroke="none" />
    ) : (
      <rect x="13" y="5" width="6" height="14" rx="1" fill="currentColor" stroke="none" />
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {bar}
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

// ── BrowserViewImpl ───────────────────────────────────────────────────────────
function BrowserViewImpl({
  app,
  ctx,
  initialUrl,
  devtoolsOf,
  devtoolsScreencast,
}: {
  app: PluginApi;
  ctx: PluginViewContext;
  initialUrl: string;
  // 설정 시 이 뷰는 URL 브라우저가 아니라 devtoolsOf(inspected label) 브라우저의 DevTools 임베드 탭이다.
  devtoolsOf?: string | null;
  // DevTools screencast(페이지 미리보기) 오버라이드 — 생략 시 설정 devtoolsScreencast 를 따른다.
  devtoolsScreencast?: boolean;
}) {
  const lang = app.locale();
  // 엔진 = 번들 Chromium(엔진 사이드카). app.webview(OS 웹뷰) 대신 app.sidecar 채널
  // 어댑터를 쓴다 — 슬롯추적/URL바 로직은 동일, 엔진만 교체.
  const webview = useMemo(() => makeChromium(app), [app]);

  // viewId → 전역 유일 label(창 네임스페이스) — webview 단일 진실에서만 파생.
  // ctx.viewId 없는 배치(사이드바)에서는 웹뷰를 열지 않는다.
  const label = ctx.viewId && webview ? webview.label(ctx.viewId) : null;

  // DevTools 정체성 — 최초 마운트는 pending(prop), 재마운트(드래그 분할/이동·window.reload)는
  // 어댑터의 영속 마커에서 복원한다. 드래그 이동 = unmount→remount 라 prop 만으로는 소실됨.
  const devtoolsTarget = devtoolsOf ?? (label ? devtoolsMarkOf(label) : null);

  const areaRef = useRef<HTMLDivElement>(null);
  // inline DevTools(같은 탭 내부 분할) — { ratio: 분할축 페이지 몫, side: 도킹 방향 }, null = 닫힘.
  // 재마운트는 어댑터 마커에서 복원(이동·reload 생존). 토글 오프는 child 를 파킹(어댑터 판정이
  // 호스트 뷰 존재를 보고 보존) — 다시 켜면 입양으로 DevTools 상태가 그대로 살아난다.
  const [inlineDt, setInlineDt] = useState<InlineMark | null>(() =>
    label ? inlineMarkOf(label) : null,
  );
  const inlineScRef = useRef<boolean | undefined>(undefined);
  // updater 안에 side-effect(마커 저장)를 두지 않는다 — React 는 updater 를 재호출할 수 있어
  // 토글이 뒤집힌다. 현재값은 ref 로 읽고, 다음 상태를 밖에서 계산해 저장+set 을 한 번씩만.
  const inlineDtRef = useRef<InlineMark | null>(inlineDt);
  inlineDtRef.current = inlineDt;
  const toggleInline = useCallback(
    (screencast?: boolean, side?: InlineSide): InlineMark | null => {
      if (!label) return null;
      const cur = inlineDtRef.current;
      let next: InlineMark | null;
      if (cur == null) {
        inlineScRef.current = screencast;
        const prev = inlineMarkOf(label);
        next = { ratio: prev?.ratio ?? 0.55, side: side ?? prev?.side ?? "bottom" };
      } else if (side && side !== cur.side) {
        // 이미 열림 + side 지정 = 토글 대신 도킹 방향 전환.
        next = { ...cur, side };
      } else {
        next = null;
      }
      if (next) setInlineMark(label, next);
      else clearInlineMark(label);
      inlineDtRef.current = next;
      setInlineDt(next);
      return next;
    },
    [label],
  );
  useEffect(() => {
    if (!ctx.viewId) return;
    return registerInlineController(ctx.viewId, toggleInline);
  }, [ctx.viewId, toggleInline]);
  // 이 브라우저의 DevTools "탭"이 살아있는가 — 어댑터 매핑 구독(버튼 열림 표시, 폴링 0).
  const [dtTabOpen, setDtTabOpen] = useState<boolean>(() =>
    label ? devtoolsLabelFor(label) != null : false,
  );
  useEffect(() => {
    if (!label) return;
    const update = () => setDtTabOpen(devtoolsLabelFor(label) != null);
    update();
    return subscribeDevtoolsMap(update);
  }, [label]);
  // 내부 divider 드래그 — 분할축 비율 조절. divider 는 두 홀 사이 6px DOM 띠라 마우스를 직접
  // 받고(아래 레이어의 child 는 이 띠를 안 덮음), child 위로 이어지는 드래그는 코어 브릿지
  // ([data-native-drag])가 중계한다. ratio = 분할축에서 "페이지" 몫 — side 에 따라 페이지가
  // 앞(bottom/right)이거나 뒤(top/left)라서 환산이 갈린다.
  const onDtDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (dtDividerDragActive) return; // 실 DOM + 브릿지 합성 mousedown 중복 시작 무시
      const area = areaRef.current;
      const wrap = area?.parentElement;
      if (!area || !wrap || !label || !inlineDt) return;
      dtDividerDragActive = true;
      const side = inlineDt.side;
      const horizontal = side === "left" || side === "right";
      const pageFirst = side === "bottom" || side === "right"; // 흐름상 페이지가 divider 앞
      const wr = wrap.getBoundingClientRect();
      const start = horizontal ? wr.left : wr.top;
      const usable = Math.max(1, (horizontal ? wr.width : wr.height) - 6);
      let last = inlineDt;
      const onMove = (ev: MouseEvent) => {
        const pos = horizontal ? ev.clientX : ev.clientY;
        const frac = (pos - start) / usable;
        const ratio = Math.min(0.85, Math.max(0.15, pageFirst ? frac : 1 - frac));
        last = { ...last, ratio };
        setInlineDt(last);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        dtDividerDragActive = false;
        setInlineMark(label, last);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [label, inlineDt],
  );

  const openedRef = useRef(false);
  const lastRectRef = useRef("");
  // 라이브 리사이즈(가장자리 드래그) 진행 여부 — 코어 app.events("window.live-resize") 게이트.
  const liveRef = useRef(false);
  // freeze-frame 스탠드인 — 제스처 시작 시점 슬롯의 캡처(data URL + 논리 크기).
  // CEF surface 는 DOM 위 합성이라, 스탠드인이 보이려면 캡처 도착 후 surface 를 숨긴다
  // (숨김이 먼저면 캡처 도착까지 공백 — 순서가 본질). WKWebView(아래층)와 다른 지점.
  const [freeze, setFreeze] = useState<{ url: string; w: number; h: number } | null>(null);
  // 마지막으로 네이티브 bounds 를 보낸 시각(드래그 중 ~30Hz 스로틀 기준).
  const lastSentRef = useRef(0);
  // 마지막 가시성(탭 활성 여부). 코어는 엔진 child 를 모르므로(네이티브 webview 만 숨김) 탭 전환
  // 숨김을 플러그인이 처리한다: 슬롯 컨테이너가 display:none(offsetParent=null)이면 hidden(true).
  const lastVisibleRef = useRef(true);
  // 최신 visible 값 — open 완료 시점에 재적용(생성 경쟁 보정).
  // 콘텐츠 배치에서는 항상 visible=true. 탭 전환 숨김은 코어가 처리한다.
  const [localUrl, setLocalUrl] = useState(initialUrl);
  // reload 명령이 최신 URL 에 접근할 수 있도록 ref 동기화(클로저 스탈 방지).
  const localUrlRef = useRef(initialUrl);
  const [input, setInput] = useState(initialUrl);
  const [bmOpen, setBmOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const inputFocusRef = useRef(false);

  // 즐겨찾기 로드 + 구독
  useEffect(() => {
    if (!app.data) return;
    let cancelled = false;

    async function loadBookmarks() {
      const keys = await app.data!.kv.keys("bm:");
      if (cancelled) return;
      const items: Bookmark[] = [];
      for (const k of keys) {
        const v = await app.data!.kv.get(k);
        if (cancelled) return;
        if (v && typeof v === "object" && "url" in v && "title" in v) {
          items.push(v as Bookmark);
        }
      }
      if (!cancelled) setBookmarks(items);
    }

    void loadBookmarks();
    const d = app.data.kv.watch(() => {
      void loadBookmarks();
    });
    return () => {
      cancelled = true;
      d.dispose();
    };
  }, [app.data]);

  // URL 상태 변화(네비게이션/외부) → 입력칸 동기화(직접 입력 중엔 방해 안 함).
  useEffect(() => {
    localUrlRef.current = localUrl;
    if (!inputFocusRef.current) setInput(localUrl);
  }, [localUrl]);

  // bounds 측정+전송. 반환: "sent"=네이티브로 보냄 / "pending"=변화 있으나 드래그 스로틀로
  // 보류(다음 프레임 재시도) / "same"=무변화. 동일 rect 는 IPC 를 보내지 않고(skip), 드래그
  // 중(liveRef)엔 네이티브 재배치를 LIVE_THROTTLE_MS(~30Hz)로 제한한다. force=드래그 끝의
  // 정확 스냅(스로틀 무시).
  const syncBounds = useCallback(
    (force = false): "sent" | "pending" | "same" => {
      // 디바이더 드래그 중엔 측정(reflow)도 전송도 하지 않는다 — freeze-frame 이 시각을
      // 잇고, 끝(force)에 최종 rect 로 1회 스냅한다(성능 헌법 5·5a).
      if (resizeGestureActive && !force) return "same";
      const el = areaRef.current;
      if (!el || !openedRef.current || !webview || !label) return "same";
      // 숨김(다른 탭) 상태면 bounds 를 보내지 않는다 — 가시성은 IntersectionObserver 가 관리(아래).
      if (!lastVisibleRef.current) return "same";
      const r = el.getBoundingClientRect();
      // 정수 스냅: rect 소수점 → 네이티브 반올림이 홀과 어긋남 방지(ceil/floor).
      const x = Math.ceil(r.left);
      const y = Math.ceil(r.top);
      const w = Math.max(1, Math.floor(r.right) - x);
      const h = Math.max(1, Math.floor(r.bottom) - y);
      const key = `${x},${y},${w},${h}`;
      if (key === lastRectRef.current) return "same";
      if (!force && liveRef.current) {
        // 변화는 있으나 직전 전송 후 스로틀 간격 전 → 보류(rect/시각은 다음 프레임에 반영).
        if (performance.now() - lastSentRef.current < LIVE_THROTTLE_MS) return "pending";
      }
      lastRectRef.current = key;
      lastSentRef.current = performance.now();
      void webview.bounds(label, x, y, w, h);
      return "sent";
    },
    [webview, label],
  );

  // 최초 1회 webview 생성 + 언마운트 정리.
  // 비동기 open 전에 언마운트 → closed 플래그로 늦은 생성 즉시 회수(고아 방지).
  useEffect(() => {
    if (!label || !webview) return;
    const el = areaRef.current;
    if (!el) return;
    let closed = false;
    const r = el.getBoundingClientRect();
    webview
      .open(label, {
        url: localUrl,
        x: r.left,
        y: r.top,
        w: Math.max(1, r.width),
        h: Math.max(1, r.height),
        devtoolsOf: devtoolsTarget ?? undefined,
        devtoolsScreencast,
      })
      .then(() => {
        if (closed) {
          void webview.close(label).catch(() => {});
          return;
        }
        openedRef.current = true;
        // 생성 경쟁 보정: open 완료 후 현재 visible 재적용
        void webview.visible(label, true).catch(() => {});
        syncBounds();
      })
      .catch((e: unknown) => console.error("browser_open:", e));

    // 명령 레지스트리에 label 등록(navigator 명령 라우팅용).
    // getUrl 클로저는 컴포넌트 state 의 최신 localUrl 을 반환한다.
    registerLabel(ctx.viewId!, label, () => localUrlRef.current);

    return () => {
      closed = true;
      openedRef.current = false;
      unregisterLabel(ctx.viewId!);
      void webview.close(label).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // bounds 구동원 — 네이티브 webview 가 DOM 슬롯(.bv-area)을 추종한다. DOM 엔 "위치 이동"
  // 이벤트가 없어(ResizeObserver 는 크기만) 추종에 rAF 가 필요하지만, 영구 60fps rAF 폴링은
  // idle 에도 매 프레임 getBoundingClientRect(강제 reflow)를 태우고, 리사이즈 중엔 매 프레임
  // 네이티브 재배치를 유발해 CPU 가 폭발한다. 그래서 "움직일 때만" 도는 자가종료 추종 루프로
  // 바꾼다:
  //   - rect 가 STABLE_STOP_FRAMES 연속 무변화면 루프를 멈춘다(idle 폴링 0).
  //   - 실제 트리거에서만 다시 깨운다: 슬롯 리사이즈(분할/사이드바)·창 리사이즈·라이브
  //     드래그(코어 신호)·포인터 드래그(분할 divider·사이드바 리사이저 = 슬롯 "이동"인데
  //     크기는 안 바뀔 수 있어 ResizeObserver 가 못 잡는 경우).
  //   - 드래그(liveRef) 중엔 syncBounds 가 네이티브 재배치를 ~30Hz 로 스로틀, 끝에 1회 정확 스냅.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;

    let rafId = 0;
    let stable = 0;
    const tick = () => {
      rafId = 0;
      const s = syncBounds();
      stable = s === "same" ? stable + 1 : 0;
      // 드래그 중이거나 아직 안정 전이면 계속 추종, 아니면 멈춘다(idle 0).
      if (liveRef.current || stable < STABLE_STOP_FRAMES) {
        rafId = requestAnimationFrame(tick);
      }
    };
    const arm = () => {
      stable = 0;
      if (!rafId) rafId = requestAnimationFrame(tick);
    };

    const ro = new ResizeObserver(arm);
    ro.observe(el);
    const onWinResize = () => arm();
    window.addEventListener("resize", onWinResize);
    // 포인터 드래그(분할 divider·사이드바 리사이저)는 슬롯을 이동시키지만 크기는 안 바꿀 수
    // 있다(ResizeObserver 미발화) → 드래그 동안만 추종을 깨운다. 버튼 눌림(e.buttons)일 때만.
    const onPointerDown = () => arm();
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons) arm();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);

    // 라이브 리사이즈 게이트(코어 네이티브 신호 — app.focus 와 동형 채널). 시작=추종 깨움
    // (스로틀 적용), 끝=정확한 최종 rect 로 1회 강제 스냅 후 잔여 레이아웃 정착 보정.
    const offLive = app.events.on("window.live-resize", (p) => {
      const active = !!(p as { active?: boolean }).active;
      liveRef.current = active;
      if (!active) syncBounds(true);
      arm();
    });

    // 디바이더 드래그(freeze-frame) — layout.resize-gesture(창-로컬). CEF 는 DOM 위 합성이라:
    //   시작: 슬롯 캡처(비동기) → 도착 시 스탠드인 마운트 → 그 다음 surface 숨김(순서가 본질 —
    //         숨김이 먼저면 캡처 도착까지 공백). 도착 전엔 stale surface 가 그대로 보인다(공백 0).
    //   끝:   최종 rect 1회 스냅 → surface 복원(ack) → rAF 후 스탠드인 제거(복원 전 제거 = 1프레임 공백).
    //   캡처 실패/조기 종료 = 스탠드인 없이 기존 동작(폴백 — surface 는 숨긴 적 없음).
    const offGesture = app.events.on("layout.resize-gesture", (p) => {
      const active = !!(p as { active?: boolean }).active;
      resizeGestureActive = active;
      // 가시(활성 탭) 뷰만 대상 — parked(비활성) 뷰의 surface 는 원래 숨김이므로
      // 여기서 건드리면 드래그 끝에 비활성 표면이 복원돼 화면에 노출된다.
      if (!lastVisibleRef.current) return;
      const dtLabel = label ? `${label}#dt` : null;
      if (active) {
        const area = areaRef.current;
        if (area && webview && label && openedRef.current) {
          const r = area.getBoundingClientRect();
          const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
          if (rect.w >= 1 && rect.h >= 1) {
            void webview
              .captureRegion(rect)
              .then(async (url) => {
                if (!resizeGestureActive) return; // 늦은 캡처는 버린다
                setFreeze({ url, w: rect.w, h: rect.h });
                await webview.visible(label, false).catch(() => {});
                if (dtLabel) await webview.visible(dtLabel, false).catch(() => {});
              })
              .catch(() => {});
          }
        }
      } else {
        syncBounds(true);
        if (webview && label) {
          void (async () => {
            await webview.visible(label, true).catch(() => {});
            if (dtLabel) await webview.visible(dtLabel, true).catch(() => {});
            requestAnimationFrame(() =>
              requestAnimationFrame(() => setFreeze(null)),
            );
          })();
        } else {
          setFreeze(null);
        }
        arm(); // 잔여 레이아웃 정착 보정.
      }
    });

    arm(); // 초기 정착 1회.

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      offLive.dispose();
      offGesture.dispose();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [syncBounds, app, webview, label]);

  // 도킹 방향 전환(상↔하·좌↔우) = 두 홀의 크기는 그대로고 "위치만" 스왑된다 → ResizeObserver 가
  // 안 울려 child 가 옛 자리에 남는다(실측: 정착 후에도 페이지/DevTools 위치 불변 + 유령 밴드).
  // 전환 시 강제 스냅(즉시 + 레이아웃 정착 보정 1회). 키는 side 만 — ratio(드래그)는 RO 가 잡고,
  // 여기 매프레임 강제 스냅을 태우면 드래그 스로틀이 무력화된다.
  const inlineSide = inlineDt?.side ?? null;
  useEffect(() => {
    if (!inlineSide) return;
    lastRectRef.current = "";
    syncBounds(true);
    const t = setTimeout(() => {
      lastRectRef.current = "";
      syncBounds(true);
    }, 120);
    return () => clearTimeout(t);
  }, [inlineSide, syncBounds]);

  // 탭 전환 가시성 — 코어는 비활성 콘텐츠 슬롯을 화면 밖으로 "파킹"한다(위치 이동, 크기 무변 →
  // ResizeObserver 미발화). IntersectionObserver 로 슬롯이 뷰포트에 들고 남(파킹/언파킹)을 즉시
  // 잡아 엔진 child 를 hidden 토글하고, 보일 때 현재 rect 로 bounds 를 강제 스냅한다 → 탭 전환 빠릿.
  // (offsetParent 체크는 파킹=off-screen 을 "보임"으로 오판해 못 쓴다.)
  useEffect(() => {
    const el = areaRef.current;
    if (!el || !webview || !label) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        const visible = e.isIntersecting && e.intersectionRatio > 0;
        if (visible === lastVisibleRef.current) return;
        lastVisibleRef.current = visible;
        void webview.visible(label, visible);
        if (visible) {
          lastRectRef.current = ""; // 파킹 중 이동했을 수 있음 → 캐시 무효화 후 강제 스냅
          syncBounds(true);
        }
      },
      { threshold: [0, 0.01] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [webview, label, syncBounds]);

  // webview nav 이벤트 → localUrl 동기화 + ctx.setTitle
  useEffect(() => {
    if (!label || !webview) return;
    const d1 = webview.on(label, "nav", (p) => {
      const url = p.url as string;
      setLocalUrl(url);
      // 복원용 URL 영속(R-OWN) — 이 뷰의 마지막 URL. about:blank 는 저장하지 않는다.
      if (ctx.viewId && app.data && url && url !== "about:blank")
        void app.data.kv.set(`vurl:${ctx.viewId}`, url).catch(() => {});
    });
    const d2 = webview.on(label, "title", (p) => {
      const title = p.title as string;
      if (title) ctx.setTitle(title);
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [label, webview, ctx]);

  // 새 링크를 browserNewWindow 설정대로 연다.
  //   "tab"(기본): 대기 URL 설정 후 새 브라우저 콘텐츠 뷰를 연다(mount 가 그 URL 소비).
  //   "window": 독립 OS 창. app.webview.openWindow(url) 이 코어 browser_open_window 으로
  //             새 OS 브라우저 창을 직접 띄운다(범용 webview 호스트 표면).
  const openExternal = useCallback(
    async (url: string): Promise<void> => {
      const mode =
        (app.settings.get("browserNewWindow") as string | undefined) ?? "tab";
      if (mode === "window" && webview?.openWindow) {
        await webview.openWindow(url).catch(() => {});
        return;
      }
      if (!app.commands) return;
      setPendingUrl(url);
      const out = await app.commands
        .execute("view.open", { program: "browser-chromium" })
        .catch(() => null);
      if (!out || !out.ok) {
        // 실패 시 대기 URL 을 드레인(null 로)해 다음 mount 가 잘못 소비하지 않게 하고,
        // 현재 뷰에서 직접 이동(URL 소실 방지).
        takePendingUrl();
        if (label && webview) void webview.navigate(label, url).catch(() => {});
      }
    },
    [app.commands, app.settings, label, webview],
  );

  // 새 링크(target=_blank / window.open) → openExternal 라우팅. 코어 webview 가 마커
  // 네비게이션을 가로채 "open-external"({url})을 emit 한다(browser.rs NEW_WINDOW_NAV).
  // App.tsx 레거시 핸들러를 대체 — 이제 브라우저 플러그인이 소유한다.
  useEffect(() => {
    if (!label || !webview) return;
    const d = webview.on(label, "open-external", (p) => {
      const url = typeof p.url === "string" ? p.url : "";
      if (url) void openExternal(url);
    });
    return () => d.dispose();
  }, [label, webview, openExternal]);

  const navigate = useCallback((raw: string) => {
    const u = normalizeUrl(raw);
    setLocalUrl(u);
    if (label && webview) {
      void webview.navigate(label, u).catch(() => {});
    }
  }, [label, webview]);

  const isBookmarked = bookmarks.some((b) => b.url === localUrl);

  const toggleBookmark = useCallback(async () => {
    if (!app.data) return;
    const key = `bm:${localUrl}`;
    if (isBookmarked) {
      await app.data.kv.delete(key);
    } else {
      let title = localUrl;
      try {
        title = new URL(localUrl).host || localUrl;
      } catch { /* noop */ }
      await app.data.kv.set(key, { url: localUrl, title });
    }
  }, [app.data, localUrl, isBookmarked]);

  if (!label || !webview) {
    return <div className="browser-view" />;
  }

  // DevTools 뷰 — 인스펙터 자체가 완결된 UI 라 soksak 툴바(주소창/뒤로/앞으로/즐겨찾기)를 얹지 않는다.
  // 네이티브 DevTools child 가 이 영역을 채운다(레이어 원칙: DOM 아래 네이티브). 분할·이동·닫기는
  // 코어 view 시스템이 일반 뷰와 완전히 동일하게 처리한다(위 훅들은 그대로 돌아 bounds 추종/가시성 유지).
  if (devtoolsTarget) {
    return (
      <div className="browser-view">
        <div className="bv-area" ref={areaRef}>
          {freeze && (
          <div className="bv-freeze" data-node="freeze">
            <img src={freeze.url} width={freeze.w} height={freeze.h} alt="" draggable={false} />
          </div>
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-view">
      <div className="bv-bar">
        <button
          type="button"
          className="bv-btn"
          title={t("back", lang)}
          data-node="back"
          onClick={() => void webview.history(label, -1)}
        >
          <IconBack />
        </button>
        <button
          type="button"
          className="bv-btn"
          title={t("forward", lang)}
          data-node="forward"
          onClick={() => void webview.history(label, 1)}
        >
          <IconForward />
        </button>
        <button
          type="button"
          className="bv-btn"
          title={t("reload", lang)}
          data-node="reload"
          onClick={() => void webview.navigate(label, localUrl)}
        >
          <IconReload />
        </button>
        <input
          className="bv-url"
          value={input}
          spellCheck={false}
          placeholder={t("urlPlaceholder", lang)}
          data-node="urlbar"
          onFocus={() => { inputFocusRef.current = true; }}
          onBlur={() => {
            inputFocusRef.current = false;
            setInput(localUrl);
          }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingEnter(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              navigate(input);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          // 열림 표시: inline 이든 독립 탭이든 이 브라우저의 DevTools 가 살아있으면 선택 상태.
          className={`bv-btn${inlineDt != null || dtTabOpen ? " on" : ""}`}
          title={t("inspect", lang)}
          data-node="devtools"
          onClick={() => {
            // devtoolsOpenMode 설정을 따른다: tab(기본) = 독립 탭(분할·이동·닫기 = 일반 탭과 동일),
            // inline = 이 뷰 내부 분할 토글. 명령 devtools-tab / devtools-inline 은 설정 무관 강제.
            if (app.settings?.get("devtoolsOpenMode") === "inline") toggleInline();
            else void openDevtoolsTab(app, label);
          }}
        >
          <IconTerminal />
        </button>
        {inlineDt != null &&
          (["bottom", "top", "left", "right"] as const).map((sd) => (
            <button
              key={sd}
              type="button"
              className={`bv-btn${inlineDt.side === sd ? " on" : ""}`}
              title={t(`dock${sd[0].toUpperCase()}${sd.slice(1)}`, lang)}
              data-node={`dock-${sd}/${ctx.viewId ?? "solo"}`}
              onClick={() => {
                if (inlineDt.side !== sd) toggleInline(undefined, sd);
              }}
            >
              <IconDock side={sd} />
            </button>
          ))}
        <button
          type="button"
          className={`bv-btn${isBookmarked ? " on" : ""}`}
          title={t("bookmark", lang)}
          onClick={() => void toggleBookmark()}
        >
          {isBookmarked ? <IconStarFilled /> : <IconStar />}
        </button>
        <button
          type="button"
          className={`bv-btn${bmOpen ? " on" : ""}`}
          title={t("bookmarks", lang)}
          onClick={() => setBmOpen((o) => !o)}
        >
          <IconMenu />
        </button>
      </div>
      {bmOpen && (
        <div className="bv-bm-list">
          {bookmarks.length === 0 && (
            <div className="bv-bm-empty">{t("noBookmarks", lang)}</div>
          )}
          {bookmarks.map((b) => (
            <div
              key={b.url}
              className="bv-bm-item"
              title={b.url}
              onClick={() => {
                navigate(b.url);
                setBmOpen(false);
              }}
            >
              <span className="bv-bm-title">{b.title}</span>
              <span className="bv-bm-url">{b.url}</span>
            </div>
          ))}
        </div>
      )}
      {/* child webview 가 이 영역 위에 정렬된다(레이어 원칙: DOM 아래 네이티브). inline DevTools 는
          도킹 방향(side)에 따라 페이지 앞/뒤에 배치 — key 로 요소 정체성을 고정해 방향 전환 시
          홀 div 재생성(child 재앵커 깜빡임)을 막는다. */}
      {(() => {
        const side = inlineDt?.side;
        const horizontal = side === "left" || side === "right";
        const pageFirst = side === "bottom" || side === "right";
        const pageEl = (
          <div
            key="page"
            className="bv-area"
            ref={areaRef}
            style={inlineDt ? { flex: `${inlineDt.ratio} 1 0px`, minWidth: 0 } : undefined}
          >
            {freeze && (
              <div className="bv-freeze" data-node="freeze">
                <img src={freeze.url} width={freeze.w} height={freeze.h} alt="" draggable={false} />
              </div>
            )}
          </div>
        );
        if (!inlineDt) {
          return (
            <div className="bv-split" style={{ flexDirection: "column" }}>
              {pageEl}
            </div>
          );
        }
        const dividerEl = (
          <div
            key="divider"
            className="bv-dt-divider"
            // 인스턴스(viewId) 포함 — 같은 contrib 뷰가 여러 탭이면 노드 주소가 충돌해
            // ui.measure/click 이 항상 첫 요소만 잡는다(실측: E2E 가 남의 divider 측정).
            data-node={`dt-divider/${ctx.viewId ?? "solo"}`}
            data-native-drag=""
            // 크기·커서는 inline 이 정본(스타일시트 전달 실패에도 6px 히트영역 보장 — 실측:
            // 시트만으로는 h=0 이 관측됨). hover 강조만 시트(.bv-dt-divider:hover)에 남긴다.
            style={{
              flex: "0 0 6px",
              cursor: horizontal ? "col-resize" : "row-resize",
              background: "var(--bd-soft, #2a2a2a)",
            }}
            onMouseDown={onDtDividerDown}
          />
        );
        const dtEl = (
          <InlineDevtools
            key="dt"
            app={app}
            webview={webview}
            hostLabel={label}
            grow={1 - inlineDt.ratio}
            side={inlineDt.side}
            screencast={inlineScRef.current}
          />
        );
        // 자식 순서는 항상 [page, divider, dt] 고정 — 방향 전환은 flexDirection(reverse 포함)만
        // 바꾼다. 순서 재배열(DOM 이동)은 같은 축 전환(상↔하·좌↔우)에서 중간 단계가 보이는
        // 원인이었다(실측) — reverse 방향이면 전환이 늘 순수 스타일 1단계다.
        const dir = horizontal
          ? pageFirst
            ? "row"
            : "row-reverse"
          : pageFirst
            ? "column"
            : "column-reverse";
        return (
          <div className="bv-split" style={{ flexDirection: dir as React.CSSProperties["flexDirection"] }}>
            {[pageEl, dividerEl, dtEl]}
          </div>
        );
      })()}
    </div>
  );
}

// ── InlineDevtools — 같은 탭 내부 분할의 DevTools 홀 ─────────────────────────────
// 호스트 뷰 안의 두 번째 홀(.bv-dt-area)에 DevTools child(label "#dt")를 정렬한다. 호스트의
// bounds 추종과 동일 패턴(자가종료 rAF + ResizeObserver + IntersectionObserver)의 축약본.
// 언마운트(토글 오프/뷰 닫힘/이동) 시 close — 어댑터 판정이 호스트 뷰 존재를 보고 파킹/파괴를
// 가른다(토글 오프 = 파킹 → 재토글 시 입양으로 DevTools 상태 보존).
function InlineDevtools({
  app,
  webview,
  hostLabel,
  grow,
  side,
  screencast,
}: {
  app: PluginApi;
  webview: WebviewApi;
  hostLabel: string;
  grow: number;
  side: InlineSide;
  screencast?: boolean;
}) {
  const dtLabel = `${hostLabel}#dt`;
  const ref = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const lastRectRef = useRef("");
  const visibleRef = useRef(true);

  const sync = useCallback(
    (force = false): "sent" | "same" => {
      // 디바이더 드래그 중엔 DevTools surface bounds 도 유예(성능 헌법 5·5a — 본체와 동일 게이트).
      if (resizeGestureActive && !force) return "same";
      const el = ref.current;
      if (!el || !openedRef.current || !visibleRef.current) return "same";
      const r = el.getBoundingClientRect();
      const x = Math.ceil(r.left);
      const y = Math.ceil(r.top);
      const w = Math.max(1, Math.floor(r.right) - x);
      const h = Math.max(1, Math.floor(r.bottom) - y);
      const key = `${x},${y},${w},${h}`;
      if (!force && key === lastRectRef.current) return "same";
      lastRectRef.current = key;
      void webview.bounds(dtLabel, x, y, w, h);
      return "sent";
    },
    [webview, dtLabel],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let closed = false;
    const r = el.getBoundingClientRect();
    webview
      .open(dtLabel, {
        url: "",
        x: r.left,
        y: r.top,
        w: Math.max(1, r.width),
        h: Math.max(1, r.height),
        devtoolsOf: hostLabel,
        devtoolsScreencast: screencast,
      })
      .then(() => {
        if (closed) {
          void webview.close(dtLabel).catch(() => {});
          return;
        }
        openedRef.current = true;
        void webview.visible(dtLabel, true).catch(() => {});
        sync(true);
      })
      .catch((e: unknown) => console.error("inline devtools open:", e));
    return () => {
      closed = true;
      openedRef.current = false;
      void webview.close(dtLabel).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dtLabel]);

  // 도킹 방향 전환 = 위치만 스왑(RO 미발화) — 강제 스냅(호스트와 동일 근거).
  useEffect(() => {
    lastRectRef.current = "";
    sync(true);
    const t = setTimeout(() => {
      lastRectRef.current = "";
      sync(true);
    }, 120);
    return () => clearTimeout(t);
  }, [side, sync]);

  // bounds 추종(자가종료 rAF) + 가시성(탭 파킹) — 호스트 패턴의 축약본.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let rafId = 0;
    let stable = 0;
    const tick = () => {
      rafId = 0;
      stable = sync() === "same" ? stable + 1 : 0;
      if (stable < 4) rafId = requestAnimationFrame(tick);
    };
    const arm = () => {
      stable = 0;
      if (!rafId) rafId = requestAnimationFrame(tick);
    };
    const ro = new ResizeObserver(arm);
    ro.observe(el);
    const onWinResize = () => arm();
    window.addEventListener("resize", onWinResize);
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons) arm();
    };
    document.addEventListener("pointermove", onPointerMove, true);
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        const visible = e.isIntersecting && e.intersectionRatio > 0;
        if (visible === visibleRef.current) return;
        visibleRef.current = visible;
        void webview.visible(dtLabel, visible);
        if (visible) {
          lastRectRef.current = "";
          sync(true);
        }
      },
      { threshold: [0, 0.01] },
    );
    io.observe(el);
    arm();
    return () => {
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("pointermove", onPointerMove, true);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [sync, webview, dtLabel, app]);

  return (
    <div className="bv-dt-area" ref={ref} style={{ flex: `${grow} 1 0px`, minWidth: 0 }} />
  );
}

export const BrowserView = memo(BrowserViewImpl);
