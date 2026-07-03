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
import { makeChromium, devtoolsMarkOf } from "./chromium-adapter";
import { registerLabel, unregisterLabel, setPendingUrl, takePendingUrl, openDevtoolsTab } from "./commands";

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
// 슬롯 rect 가 이 프레임 수만큼 연속 무변화면(=드래그 아님) 추종 루프를 멈춘다(idle 폴링 0).
const STABLE_STOP_FRAMES = 4;

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
}: {
  app: PluginApi;
  ctx: PluginViewContext;
  initialUrl: string;
  // 설정 시 이 뷰는 URL 브라우저가 아니라 devtoolsOf(inspected label) 브라우저의 DevTools 임베드 탭이다.
  devtoolsOf?: string | null;
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
  const openedRef = useRef(false);
  const lastRectRef = useRef("");
  // 라이브 리사이즈(가장자리 드래그) 진행 여부 — 코어 app.events("window.live-resize") 게이트.
  const liveRef = useRef(false);
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

    arm(); // 초기 정착 1회.

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      offLive.dispose();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [syncBounds, app]);

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
        <div className="bv-area" ref={areaRef} />
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
          className="bv-btn"
          title={t("inspect", lang)}
          data-node="devtools"
          onClick={() => {
            // DevTools 를 탭으로(이 브라우저를 검사 대상으로) — 이미 열려 있으면 그 탭 활성화(중복 방지).
            // 분할·이동·닫기는 일반 탭과 동일(코어 view 커맨드 = 드래그와 같은 경로).
            void openDevtoolsTab(app, label);
          }}
        >
          <IconTerminal />
        </button>
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
      {/* child webview 가 이 영역 위에 정렬된다(레이어 원칙: DOM 아래 네이티브). */}
      <div className="bv-area" ref={areaRef} />
    </div>
  );
}

export const BrowserView = memo(BrowserViewImpl);
