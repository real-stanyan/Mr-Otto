// tests/docs/taskSessionsMigration.test.ts
// RPC 里那份「免笔类型」白名单是从 PEN_VERDICTS 抄进 SQL 的（#1223）——两份名单对表，
// 同 tests/docs/migrationNumbers.test.ts 的路子：读文件、正则、比集合，不起 Postgres。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUMAN_EVENT_TYPES, PEN_BUSY_EXEMPT, PEN_TTL_S, TASK_EVENT_MAX_BYTES, TASK_SQLSTATE, TASK_TEXT_MAX_BYTES } from "../../src/shared/taskSync.js";

const mig = (name: string): string => readFileSync(join(__dirname, "..", "..", "supabase", "migrations", name), "utf8");
const sql = mig("0036_task_sessions.sql");
// `_task_append` 现在由 0039 重定义（#1258 / ADR-0310）——**白名单那几条对表要认最新那一份**，
// 不然改了 0039 而 0036 原样躺着，这几条断言照样全绿
const appendSql = mig("0039_task_append_pen_busy.sql");

describe("0036_task_sessions.sql 与 src/shared/taskSync.ts 对表", () => {
  it("免笔类型白名单逐字一致", () => {
    const m = /v_type not in \(([^)]*)\)/.exec(appendSql);
    expect(m, "SQL 里找不到 `v_type not in (...)`——白名单的写法变了，这条对表也得跟着改").not.toBeNull();
    const listed = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
    expect(listed).toEqual([...HUMAN_EVENT_TYPES].sort());
  });
  it("三个数字与常量一致：单条上限 / 人话上限 / 建行时发笔的 ttl", () => {
    expect(appendSql).toContain(`> ${TASK_EVENT_MAX_BYTES} then`);
    expect(appendSql).toContain(`> ${TASK_TEXT_MAX_BYTES} then`);
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
  it("SQLSTATE 与 TASK_SQLSTATE 逐字一致（客户端 supabaseTaskSessionsApi.ts 按码不按文案分支）", () => {
    const both = `${sql}\n${appendSql}`;
    for (const code of Object.values(TASK_SQLSTATE)) {
      expect(both, `SQL 里找不到 errcode = '${code}'`).toContain(`errcode = '${code}'`);
    }
  });

  // #1258 / ADR-0310：笔活着时这条会话只有一个写者。SQL 那一支与 fakeCloud 那一支
  // （tests/main/taskSessionSync.test.ts）是同一条规矩的两份实现，这里对的是 SQL 那份
  it("0039：人的动作撞上别人的活笔回 pen_busy，且只放过 session_created", () => {
    const m = /elsif v_type <> '([a-z_]+)'[\s\S]*?raise exception 'pen_busy'/.exec(appendSql);
    expect(m, "0039 里找不到那条 pen_busy 分支——写法变了的话这条对表也得跟着改").not.toBeNull();
    expect([m![1]!]).toEqual([...PEN_BUSY_EXEMPT]);
    // 判据三件缺一不可：笔有主、主不是我、没过期。少一件就是「谁都拦」或「谁都不拦」
    expect(appendSql).toContain("v_row.pen_holder is not null and v_row.pen_holder is distinct from p_holder");
    expect(appendSql).toContain("v_row.pen_until is not null and v_row.pen_until > now()");
  });
});
