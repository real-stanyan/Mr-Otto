// tests/docs/taskSessionsMigration.test.ts
// RPC 里那份「免笔类型」白名单是从 PEN_VERDICTS 抄进 SQL 的（#1223）——两份名单对表，
// 同 tests/docs/migrationNumbers.test.ts 的路子：读文件、正则、比集合，不起 Postgres。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUMAN_EVENT_TYPES, PEN_TTL_S, TASK_EVENT_MAX_BYTES, TASK_TEXT_MAX_BYTES } from "../../src/shared/taskSync.js";

const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0036_task_sessions.sql"), "utf8");

describe("0036_task_sessions.sql 与 src/shared/taskSync.ts 对表", () => {
  it("免笔类型白名单逐字一致", () => {
    const m = /v_type not in \(([^)]*)\)/.exec(sql);
    expect(m, "SQL 里找不到 `v_type not in (...)`——白名单的写法变了，这条对表也得跟着改").not.toBeNull();
    const listed = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
    expect(listed).toEqual([...HUMAN_EVENT_TYPES].sort());
  });
  it("三个数字与常量一致：单条上限 / 人话上限 / 建行时发笔的 ttl", () => {
    expect(sql).toContain(`> ${TASK_EVENT_MAX_BYTES} then`);
    expect(sql).toContain(`> ${TASK_TEXT_MAX_BYTES} then`);
    expect(sql).toContain(`make_interval(secs => ${PEN_TTL_S})`);
  });
  it("客户端表上没有 insert/update 策略（写只走 RPC）；事件表连 delete 都没有", () => {
    expect(sql).not.toMatch(/create policy\s+"?\w+"?\s+on\s+public\.task_sessions\s+for\s+(insert|update|all)/i);
    expect(sql).not.toMatch(/create policy\s+"?\w+"?\s+on\s+public\.task_session_events\s+for\s+(insert|update|delete|all)/i);
  });
  it("内部实现函数对 authenticated 收回执行权，_as 只给 service_role", () => {
    for (const name of ["task_append", "task_pen_acquire", "task_pen_release"] as const) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\._${name}\\([^)]*\\) from public, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}_as\\([^)]*\\) to service_role`));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}_as\\([^)]*\\) to authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated`));
    }
  });
});
