import { describe, expect, it } from "vitest";
import { boundsCommitDecision, followShouldContinue } from "./bounds-follow";

// 분할 divider 드래그 실시간 리사이즈 계약 — freeze-frame(드래그 중 커밋 유예+정지 사진) 회귀 방지.
// 실측 RED: 드랍 전 캡처에서 양 브라우저 폭이 드래그 시작 값에 박제되고, 옛 크기 스탠드인이
// 빈 슬롯(검은 밴드)을 노출했다. GREEN: 드래그 중에도 매 프레임 커밋 → DOM=네이티브 실시간 일치.

describe("followShouldContinue", () => {
  it("디바이더 드래그(gesture) 중에는 rect 가 안정돼도 추종을 멈추지 않는다", () => {
    expect(
      followShouldContinue({ live: false, gesture: true, stableFrames: 100, stopAfter: 4 }),
    ).toBe(true);
  });
  it("창 라이브 리사이즈(live) 중에도 계속 추종한다", () => {
    expect(
      followShouldContinue({ live: true, gesture: false, stableFrames: 100, stopAfter: 4 }),
    ).toBe(true);
  });
  it("드래그가 없고 rect 가 안정되면 자가종료한다(idle 폴링 0)", () => {
    expect(
      followShouldContinue({ live: false, gesture: false, stableFrames: 4, stopAfter: 4 }),
    ).toBe(false);
    expect(
      followShouldContinue({ live: false, gesture: false, stableFrames: 2, stopAfter: 4 }),
    ).toBe(true);
  });
});

describe("boundsCommitDecision", () => {
  it("디바이더 드래그(gesture)는 커밋을 유예하지 않는다 — rect 가 바뀌면 즉시 전송", () => {
    expect(
      boundsCommitDecision({
        force: false, live: false, gesture: true, sameRect: false, msSinceLast: 0, throttleMs: 33,
      }),
    ).toBe("send");
  });
  it("변화 없는 프레임은 스킵한다(IPC 0)", () => {
    expect(
      boundsCommitDecision({
        force: false, live: false, gesture: true, sameRect: true, msSinceLast: 999, throttleMs: 33,
      }),
    ).toBe("skip");
  });
  it("창 라이브 리사이즈(live)만 스로틀된다 — 간격 전이면 보류, force 는 항상 전송", () => {
    expect(
      boundsCommitDecision({
        force: false, live: true, gesture: false, sameRect: false, msSinceLast: 10, throttleMs: 33,
      }),
    ).toBe("pending");
    expect(
      boundsCommitDecision({
        force: true, live: true, gesture: false, sameRect: false, msSinceLast: 10, throttleMs: 33,
      }),
    ).toBe("send");
  });
});
