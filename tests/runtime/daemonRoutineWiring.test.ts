// daemon.ts 进不了 vitest；定时任务在它身上的接线漏了是**安静的**失败（永远不响），所以判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：定时任务的接线（#1283）", () => {
  it("每条会话房都接了同一个 routines（Supabase store，只建一次），团队会话 / 外联传 null 由 sessionService 自己按 approveAll + chatKind 判", () => {
    expect(src.match(/createSupabaseRoutineStore\(supabase\b/g)).toHaveLength(1);
    // 第二格接日志：坏行被隔离时要留一句话（C1）
    expect(src).toMatch(/const routineStore = createSupabaseRoutineStore\(supabase, \{ log: /);
    expect(src).toMatch(/routines: routineStore,/);
    expect(src).not.toMatch(/routines: null/);
  });
  it("调度器在启动末尾起一次、quota 走 hostedProbe 且不抛、run / note 走 routineRun 那两个函数", () => {
    expect(src).toMatch(/createRoutineScheduler\(\{[\s\S]*store: routineStore,[\s\S]*hostedProbe\.me\(/);
    expect(src).toMatch(/quota: async \(ownerUid\) => \{\s*try \{[\s\S]*hostedProbe\.me\(ownerUid\)[\s\S]*\} catch \{\s*return null;/);
    expect(src).toMatch(/run: \(r, firedAt\) => runRoutineInRoom\(routineRooms, r, firedAt\)/);
    expect(src).toMatch(/note: \(r, reason, plannedAt\) => noteRoutineInRoom\(routineRooms, r, reason, plannedAt\)/);
    expect(src.match(/routineScheduler\.start\(\)/g)).toHaveLength(1);
  });
  it("到点先验主人（现查 workspaceFacts，不是主场回 null）、找私聊走 findDmSession、开房走 openOriginRoom（开着就用、归档回 null）", () => {
    expect(src).toMatch(/const routineRooms = \{[\s\S]*homeOwnerOf: async \(w: string\) => \{\s*const f = await workspaceFacts\(w\);\s*return f\.kind === "home" \? f\.ownerUid : null;\s*\},[\s\S]*findDm: \(w: string, a: string\) => findDmSession\(w, \[a\]\),[\s\S]*openOriginRoom<CloudSession>\(/);
  });
  it("openOriginRoom 的 row 回调只有一份（sessionRowOf），外联与定时任务共用", () => {
    expect(src.match(/async function sessionRowOf\(/g)).toHaveLength(1);
    expect(src.match(/row: sessionRowOf,/g)).toHaveLength(2);
    expect(src.match(/select\("workspace_id,publisher_uid,archived"\)/g)).toHaveLength(1);
  });
});
