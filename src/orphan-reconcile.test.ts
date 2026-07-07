import { describe, expect, it } from "vitest";
import { reconcileOrphans } from "./orphan-reconcile";

// 엔진 child 잔존 회수 계약 — 실측 RED: 뷰 close 직후 plugin.reload 로 close 디바운스가 증발하면
// child 가 유령으로 잔존해(매핑까지 소실) 옛 크기 surface 가 화면을 덮었다. 장부(ledger)는 매핑과
// 독립적으로 이 창이 만든 id 를 기억하고, reconcile 이 "살아있는데 주인 없는" id 를 회수한다.

describe("reconcileOrphans", () => {
  it("매핑을 잃은 생존 child(유령 잔존)는 회수 대상이다 — RED 시나리오(매핑 클로버·디바운스 증발)", () => {
    expect(
      reconcileOrphans({ live: [3, 4], mapped: [], ledger: [3, 4] }),
    ).toEqual({ close: [3, 4], forget: [] });
  });
  it("재사용 인계된(매핑 있는) child 는 건드리지 않는다 — 페이지 보존", () => {
    expect(
      reconcileOrphans({ live: [3, 4], mapped: [3, 4], ledger: [3, 4] }),
    ).toEqual({ close: [], forget: [] });
  });
  it("이미 죽은 장부 항목은 잊는다(자가치유) — 다음 인스턴스로 누적되지 않는다", () => {
    expect(
      reconcileOrphans({ live: [4], mapped: [4], ledger: [3, 4] }),
    ).toEqual({ close: [], forget: [3] });
  });
  it("다른 창의 child(장부 밖 live id)는 절대 건드리지 않는다 — 멀티창 안전", () => {
    expect(
      reconcileOrphans({ live: [7, 8, 9], mapped: [9], ledger: [9] }),
    ).toEqual({ close: [], forget: [] });
  });
});
