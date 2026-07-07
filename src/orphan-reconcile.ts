// 엔진 child 잔존 대조(순수) — 이 창이 만든 child 장부(ledger)와 현재 매핑(mapped)·엔진 생존(live)을
// 대조해 회수/정리 대상을 판정한다. 창-스코프 안전: ledger 에 없는 엔진 id(다른 창 소유)는 절대
// 건드리지 않는다. 실측 RED: 뷰 close 직후 plugin.reload 가 close 디바운스를 지우면 child 가 유령으로
// 잔존해 옛 크기 surface 가 화면을 덮었다 — 매핑을 잃은 child 는 매핑 기반 sweep 이 못 잡으므로
// 장부가 매핑과 독립적으로 생존해야 한다.
export function reconcileOrphans(i: {
  /** 엔진에 지금 살아있는 child id 목록(engineStats). */
  live: number[];
  /** 현재 label→id 매핑이 참조하는 id 목록(재사용 인계 완료·유효 뷰). */
  mapped: number[];
  /** 이 창이 생성했던 child id 장부(sessionStorage 영속). */
  ledger: number[];
}): { close: number[]; forget: number[] } {
  const live = new Set(i.live);
  const mapped = new Set(i.mapped);
  const close: number[] = [];
  const forget: number[] = [];
  for (const id of i.ledger) {
    if (!live.has(id)) forget.push(id); // 이미 죽음 — 장부에서 제거(자가치유)
    else if (!mapped.has(id)) close.push(id); // 살아있는데 주인 없음 — 미회수 잔존, 회수
  }
  return { close, forget };
}
