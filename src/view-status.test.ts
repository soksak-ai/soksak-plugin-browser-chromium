import { describe, expect, it } from "vitest";
import { browserViewStatus, isBlockingCode, BLOCKING_CODES } from "./view-status";

// 뷰 status 축 계약 — 이 브라우저 콘텐츠 뷰가 자기 진짜 상태만 보고한다.
// 코어 계약: setStatus({code,message}|null). 닫기 가드 blocking 코드 = {dirty,busy,running}.
describe("browserViewStatus", () => {
  it("엔진(사이드카) child 여는 중 = connecting 코드", () => {
    expect(browserViewStatus({ kind: "connecting" })).toEqual({
      code: "connecting",
      messageKey: "statusConnecting",
    });
  });

  it("엔진 미연결(사이드카 로드/open 실패) = error 코드", () => {
    expect(browserViewStatus({ kind: "engine-error" })).toEqual({
      code: "error",
      messageKey: "statusEngineOffline",
    });
  });

  it("페이지 내비게이션 진행 중 = loading 코드", () => {
    expect(browserViewStatus({ kind: "loading" })).toEqual({
      code: "loading",
      messageKey: "statusLoading",
    });
  });

  it("유휴(페이지 로드 완료)는 보고하지 않는다 — null (억지 상태 금지)", () => {
    expect(browserViewStatus({ kind: "ready" })).toBeNull();
  });

  it("이 뷰가 내는 어떤 코드도 close-guard blocking 이 아니다 — 브라우저 탭은 로딩/오류 중 닫아도 잃을 작업이 없다", () => {
    for (const kind of ["connecting", "engine-error", "loading"] as const) {
      const r = browserViewStatus({ kind });
      expect(r).not.toBeNull();
      expect(isBlockingCode(r!.code)).toBe(false);
    }
  });

  it("blocking 집합은 코어 계약과 동형(dirty/busy/running)", () => {
    expect([...BLOCKING_CODES]).toEqual(["dirty", "busy", "running"]);
    expect(isBlockingCode("busy")).toBe(true);
    expect(isBlockingCode("loading")).toBe(false);
  });
});
