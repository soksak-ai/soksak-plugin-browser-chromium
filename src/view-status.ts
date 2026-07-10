// 브라우저 콘텐츠 뷰의 상태 축(뷰 status 계약) 순수 판정.
// 코어 계약: setStatus({code,message}|null). 닫기 가드는 blocking 코드에서만 닫기를 막는다.
// 이 브라우저 뷰가 내는 진짜 상태만 매핑한다:
//   - connecting  : 엔진(Chromium 사이드카) child 를 여는 중.
//   - engine-error: 엔진 미연결 — 사이드카 로드/open 실패(어댑터 부재 포함).
//   - loading     : 페이지 내비게이션 진행 중.
//   - ready       : 유휴(페이지 로드 완료) → 보고 없음(null).
// 위 코드 중 어느 것도 blocking 집합에 들지 않는다: 브라우저 탭은 로딩/오류 중에도 닫을 때
// 잃을 작업이 없다 — close-guard 를 억지로 세우지 않는다.

export type BrowserPhase =
  | { kind: "connecting" }
  | { kind: "engine-error" }
  | { kind: "loading" }
  | { kind: "ready" };

// messageKey = i18n 사전 키. 사람 표면 문자열은 뷰에서만 호스트 언어로 해소한다(여기선 코드만).
export interface StatusReport {
  code: string;
  messageKey: string;
}

// 닫기 가드가 "닫지 마" 로 해석하는 코드(코어 뷰 status 계약). 참조·불변 단언용.
export const BLOCKING_CODES = ["dirty", "busy", "running"] as const;

export function isBlockingCode(code: string): boolean {
  return (BLOCKING_CODES as readonly string[]).includes(code);
}

export function browserViewStatus(phase: BrowserPhase): StatusReport | null {
  switch (phase.kind) {
    case "connecting":
      return { code: "connecting", messageKey: "statusConnecting" };
    case "engine-error":
      return { code: "error", messageKey: "statusEngineOffline" };
    case "loading":
      return { code: "loading", messageKey: "statusLoading" };
    case "ready":
      return null;
  }
}
