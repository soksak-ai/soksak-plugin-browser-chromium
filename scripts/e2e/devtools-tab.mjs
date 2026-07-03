// DevTools-as-tab E2E — DevTools 가 "정식 탭"(탭바의 일급 뷰)으로 열리고, 드래그와 동일 경로(view.move)
// 로 분할·이동되며, 닫기가 엔진 child 를 "실제로 파괴"하는지 검증한다. RED→GREEN 가드.
//
// [사용자 뷰 불가침] 이 테스트는 라이브 워크스페이스에서 돈다 — 자기가 만든 뷰/child 만 추적·정리하고
// 남의 탭은 절대 닫지 않는다(실측 사고: 전 패널 일괄 정리가 사용자의 브라우저 탭을 닫았음). child
// 검증도 개수 비교가 아니라 "테스트가 만든 id 의 생멸"(stats 집합 차)로 한다 — 사용자 활동과 독립.
//
// 왜 stats 인가: 뷰(탭) 수만 세면 유령을 놓친다 — close 가 조용히 실패하면 탭은 사라지는데 네이티브
// child 가 화면에 잔존한다(실측: do_close=1 후 NSView 미제거 → 유령. 지금은 do_close 가 파괴 완결).
//
// 실행: SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/devtools-tab.mjs
// 종료코드: 0=GREEN, 1=RED.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const SOCKET = process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const PLUGIN = "soksak-plugin-browser-chromium";
const cmd = (c) => `plugin.${PLUGIN}.${c}`;
const CYCLES = Number(process.env.DEVTOOLS_CYCLES || 3);
const SHOT_DIR = process.env.SHOT_DIR || "/tmp";

let sock, seq = 0, rbuf = "";
const pending = new Map();
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      rbuf += d.toString("utf8");
      let i;
      while ((i = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      }
    });
  });
}
function rpc(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`TIMEOUT ${method}`)); } }, 12000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } return c; };

async function alive() {
  try { const r = await rpc(cmd("ping")); return !!(r && r.ok); } catch { return false; }
}
async function views() {
  const r = await rpc("view.list", {});
  return { list: (r && r.views) || [], active: r && r.activeViewId, groupId: r && r.groupId };
}
// 전 그룹 합산 뷰 목록 — devtools 는 검사 대상 "옆 분할"(새 그룹)로 열리므로, 활성 그룹만 세면
// 열기 전후 비교가 어긋난다. 카운트/탐색은 전 그룹 합산이 정본.
async function allViews() {
  const pl = await rpc("panel.list", {});
  const out = [];
  for (const g of ((pl && pl.panels) || []).map((p) => p.id)) {
    const r = await rpc("view.list", { group: g }).catch(() => null);
    for (const v of (r && r.views) || []) out.push({ ...v, group: g });
  }
  return out;
}
// 엔진 child id 집합 — child 생멸의 단일 진실.
async function stats() {
  const r = await rpc(cmd("stats")).catch(() => null);
  return r && Array.isArray(r.ids) ? r.ids : [];
}
const diff = (a, b) => a.filter((x) => !b.includes(x));
async function snap(name) {
  const p = path.join(SHOT_DIR, name);
  try { await rpc("window.snapshot", { path: p }); } catch { /* 행이면 alive 가 잡음 */ }
  return fs.existsSync(p);
}
// 테스트가 만든 뷰만 정리(사용자 뷰 불가침).
const myViews = new Set();
async function cleanup() {
  for (const v of myViews) await rpc("view.close", { view: v }).catch(() => {});
  myViews.clear();
  await sleep(1800); // close 디바운스(600ms)+엔진 파괴 여유
}

async function main() {
  await connect();
  console.log("DevTools-as-tab E2E (사용자 뷰 불가침)\n소켓:", SOCKET);
  ok(await alive(), "chromium 플러그인 로드(ping)");

  const s0 = await stats();
  const v0 = await views();

  // 1) 브라우저 탭 — 이 테스트 소유로 추적.
  ok((await rpc(cmd("open"), { url: "https://example.com" })).ok, "browser open");
  await sleep(2200);
  const v1 = await views();
  const browserViewId = v1.active;
  myViews.add(browserViewId);
  const s1 = await stats();
  const browserChild = diff(s1, s0);
  ok(v1.list.length === v0.list.length + 1, `브라우저 뷰 +1 (${v0.list.length}→${v1.list.length})`);
  ok(browserChild.length === 1, `엔진 child 신규 1(브라우저: ${browserChild.join(",")})`);
  ok(await snap("dt-1-browser.png"), "snapshot(브라우저)");

  // 2) DevTools 탭(정식 탭 — 검사 대상 "옆 분할" 새 그룹으로 열림: 대상이 보여야 렌더되므로)
  const all1 = await allViews();
  ok((await rpc(cmd("devtools"), {})).ok, "devtools 열기 명령");
  await sleep(2600);
  const v2 = await views();
  const dtViewId = v2.active;
  myViews.add(dtViewId);
  const s2 = await stats();
  const dtChild = diff(s2, s1);
  const all2 = await allViews();
  ok(all2.length === all1.length + 1, `DevTools 뷰 +1 (전그룹 ${all1.length}→${all2.length})`);
  const dtEntry = all2.find((v) => v.id === dtViewId);
  const bEntry = all2.find((v) => v.id === browserViewId);
  ok(
    !!(dtEntry && bEntry && dtEntry.group !== bEntry.group),
    `devtools 는 검사 대상 옆 분할(새 그룹)로 열림 (browser=${bEntry?.group}, devtools=${dtEntry?.group})`,
  );
  ok(dtChild.length === 1, `엔진 child 신규 1(devtools: ${dtChild.join(",")})`);
  ok(await snap("dt-2-devtools.png"), "snapshot(devtools 탭)");
  ok(await alive(), "★ devtools 열기 후 생존");

  // 2.5) devtools 열린 상태에서 주소 이동 — 브라우저의 본업이 devtools 와 공존해야 한다(실측 회귀:
  //      이동 불능이 devtools 작업 중 발견됨). 이동 성공은 탭 제목(title 이벤트→ctx.setTitle)으로 단언.
  ok(
    (await rpc(cmd("navigate"), { viewId: browserViewId, url: "https://ko.wikipedia.org" })).ok,
    "navigate 명령(devtools 열린 상태)",
  );
  await sleep(3200);
  // 브라우저 뷰는 devtools 분할로 비활성 그룹에 있다 — 전그룹 탐색으로 제목 조회.
  const bTitle = ((await allViews()).find((v) => v.id === browserViewId) || {}).title || "";
  ok(
    /위키|wikipedia/i.test(bTitle),
    `주소 이동 반영(탭 제목="${bTitle}")`,
  );
  ok((await stats()).includes(dtChild[0]), "이동 중 devtools child 생존");

  // 3) 핵심: 닫기 = 탭 제거 + 그 child "실제 파괴"(유령 0)
  await rpc("view.close", { view: dtViewId });
  myViews.delete(dtViewId);
  await sleep(2000);
  ok(await alive(), "★★ devtools 닫기 후 생존");
  ok((await allViews()).length === all1.length, "닫힌 뒤 뷰수 복귀(전그룹)");
  ok(!(await stats()).includes(dtChild[0]), "★★ 그 엔진 child 실제 파괴(유령 0)");

  // 4) 열고/닫기 반복 — 생존 + 각 child 소멸
  let survived = true;
  let leaked = [];
  for (let i = 1; i <= CYCLES; i++) {
    const before = await stats();
    await rpc(cmd("devtools"), {});
    await sleep(2200);
    const v = await views();
    const created = diff(await stats(), before);
    await rpc("view.close", { view: v.active });
    await sleep(2000);
    const after = await stats();
    const remained = created.filter((id) => after.includes(id));
    leaked.push(...remained);
    const a = await alive();
    console.log(`   cycle ${i}: 생존=${a}, 잔존 child=${remained.length ? remained.join(",") : "0"}`);
    if (!a) { survived = false; break; }
  }
  ok(survived, `★★★ devtools 열기/닫기 ${CYCLES}회 반복 생존`);
  ok(leaked.length === 0, `★★★ ${CYCLES}회 반복 child 누수 0`);

  // 5) 드래그 이동 — view.move 는 탭 드래그-드롭과 동일 store 경로(moveViewToGroup). devtools 는
  //    이미 자기 그룹(옆 분할)으로 열리므로, 검사 대상 그룹으로 "병합"(zone=center = 탭 드롭)한다.
  //    이동은 unmount→remount 이므로 devtools 정체성(영속 마커)의 재마운트 복원까지 검증된다.
  const s4 = await stats();
  await rpc(cmd("devtools"), { viewId: browserViewId });
  await sleep(2400);
  const v5 = await views();
  const dtId2 = v5.active;
  myViews.add(dtId2);
  const dtChild2 = diff(await stats(), s4);
  const bGroup = ((await allViews()).find((v) => v.id === browserViewId) || {}).group;
  const moved = await rpc("view.move", { view: dtId2, dst: bGroup, zone: "center" });
  ok(
    !!(moved && moved.ok !== false && moved.groupId),
    `드래그 이동(view.move → 대상 그룹 병합) → ${JSON.stringify({ ok: moved?.ok, groupId: moved?.groupId })}`,
  );
  await sleep(1800);
  ok(await alive(), "★ 드래그 이동 후 생존");
  const inNew = await rpc("view.list", { group: moved.groupId }).catch(() => null);
  ok(
    !!(inNew && (inNew.views || []).some((v) => v.id === dtId2)),
    "이동 후 devtools 뷰가 대상 그룹에 존재(재마운트 완료)",
  );
  ok(
    dtChild2.length === 1 && (await stats()).includes(dtChild2[0]),
    "이동은 child 를 보존(재생성/유령 0)",
  );
  ok(await snap("dt-4-moved.png"), "snapshot(분할 이동 후 — devtools 렌더 유지 눈검증용)");

  // 6) 중복 방지 — 같은 브라우저의 devtools 재요청 = 기존 탭 활성화(새 탭/새 child 0)
  const s6 = await stats();
  const dedup = await rpc(cmd("devtools"), { viewId: browserViewId });
  await sleep(600);
  ok(
    !!(dedup && dedup.ok && dedup.focused === true) && diff(await stats(), s6).length === 0,
    `재요청 = 기존 devtools 탭 활성화(중복 0) → ${JSON.stringify({ ok: dedup?.ok, focused: dedup?.focused })}`,
  );

  // 7) 검사 대상 닫힘 → DevTools 동반 닫힘(Chrome 동형). 대상 없는 DevTools 는 ws 가 끊긴
  //    "Debugging connection was closed" 잔해가 되므로, 대상 파괴 확정 시 함께 닫는다.
  await rpc("view.close", { view: browserViewId });
  myViews.delete(browserViewId);
  await sleep(2500); // 디바운스(600)+동반 닫힘 전파+그 devtools 자체 디바운스 여유
  // 내 소유 devtools 뷰(dtId2)가 사라졌는지만 본다 — 화면에 남은 남의 DevTools 탭은 검사 밖.
  const after7 = await allViews();
  ok(
    !after7.some((v) => v.id === dtId2),
    "검사 대상 닫힘 → 그 DevTools 탭 동반 닫힘(잔해 0)",
  );
  myViews.delete(dtId2); // 동반 닫힘됨 — cleanup 중복 close 방지

  // 8) 자가정리(테스트 소유 뷰만) + 테스트 child 전멸 확인
  const mine = [browserChild[0], dtChild2[0]].filter((x) => x != null);
  await cleanup();
  const fin = await stats();
  ok(mine.every((id) => !fin.includes(id)), "정리 후 테스트 child 전부 파괴(누수 0)");
  await snap("dt-3-final.png");

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(async (e) => {
  console.error("E2E 실패:", e.message);
  try { await cleanup(); } catch { /* 최선 정리 */ }
  process.exit(1);
});
