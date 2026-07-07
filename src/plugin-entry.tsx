// soksak browser 플러그인 엔트리 — loader 가 blob-URL 로 import 하는 단일 ESM(esbuild 번들).
// 콘텐츠 뷰 "content" 를 등록 → BrowserView 를 마운트.
import { createRoot, type Root } from "react-dom/client";
import { BrowserView } from "./browser-view";
import { cancelInstanceTimers, scheduleOrphanSweep } from "./chromium-adapter";
import { injectStyles } from "./styles";
import { registerCommands, takePendingUrl, takePendingDevtools } from "./commands";
import type { PluginContext, PluginViewContext } from "./host";

const roots = new WeakMap<HTMLElement, Root>();

function mountInto(container: HTMLElement, node: React.ReactElement): void {
  injectStyles();
  unmountContainer(container);
  container.style.position = "relative";
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.inset = "0";
  host.style.overflow = "hidden";
  container.appendChild(host);
  const root = createRoot(host);
  root.render(node);
  roots.set(container, root);
}

function unmountContainer(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
  container.replaceChildren();
}

export default {
  activate(ctx: PluginContext) {
    const app = ctx.app;
    injectStyles();
    // 잔존 child 회수는 activate 가 예약한다 — 첫 뷰 mount 에서만 예약하면, 이전 인스턴스의
    // child 가 뷰 없이 남은 경우(콘텐츠 닫힘 후 reload) 아무도 sweep 을 돌리지 않아 유령이
    // 영구 잔존한다(실측 — 옛 크기 surface 가 화면을 덮음).
    scheduleOrphanSweep(app);

    if (app.ui?.registerView) {
      ctx.subscriptions.push(
        app.ui.registerView("content", {
          mount(container: HTMLElement, vctx: PluginViewContext) {
            // DevTools 탭이면 이 값이 inspected label(=검사 대상 브라우저의 label)이다 → URL 대신
            // 그 브라우저의 DevTools 를 임베드한다. 둘 다 1회 소비(다음 mount 오이어받기 방지).
            const devtools = takePendingDevtools();
            // 시작 URL 우선순위: 대기 URL(open 명령 / open-external 새 탭이 set) → homeUrl 설정 → blank.
            const pending = takePendingUrl();
            const fallback =
              pending ??
              (app.settings.get("homeUrl") as string | undefined) ??
              "about:blank";
            const doMount = (url: string) => {
              if (!container.isConnected) return; // kv 대기 중 unmount 가드
              mountInto(
                container,
                <BrowserView
                  app={app}
                  ctx={vctx}
                  initialUrl={url}
                  devtoolsOf={devtools?.label ?? null}
                  devtoolsScreencast={devtools?.screencast}
                />,
              );
            };
            // 복원 mount(대기 URL·DevTools 아님): 마지막 URL 로 되돌린다(R-OWN — native 와 동형).
            if (!pending && !devtools && vctx.viewId && app.data) {
              void app.data.kv
                .get(`vurl:${vctx.viewId}`)
                .then((v) => doMount(typeof v === "string" && v ? v : fallback))
                .catch(() => doMount(fallback));
              return;
            }
            doMount(fallback);
          },
          unmount(container: HTMLElement) {
            unmountContainer(container);
          },
        }),
      );
    }

    registerCommands(ctx);
  },
  deactivate() {
    // 이 인스턴스가 예약한 타이머(close 디바운스 파괴·sweep)를 소거 — 남겨두면 reload 뒤 stale
    // 클로저가 발화해 sessionStorage(다음 인스턴스의 매핑/장부)를 덮어쓴다(재사용 인계 실패의 근원).
    // child 와 매핑은 남긴다: 다음 인스턴스가 재사용(페이지 보존)하거나 reconcile 이 회수한다.
    cancelInstanceTimers();
    const s = document.getElementById("sk-browser-style");
    if (s) s.remove();
  },
};
