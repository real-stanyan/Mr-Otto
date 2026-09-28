// 0044_agent_activity.sql 的可执行版（#1282，spec §3.1）。migration 是在生产手动执行的，门禁跑不到它；
// 这几条钉的是「写方只有 runtime」「客户端只读在籍的」「两张表进了实时推送」在 SQL 上的样子。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0044_agent_activity.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0044_agent_activity", () => {
  it("一行 = 一条会话里的一只；会话删了跟着删", () => {
    expect(code).toMatch(/create table if not exists public\.agent_activity/);
    expect(code).toMatch(/session_id\s+uuid not null references public\.workspace_sessions\(id\) on delete cascade/);
    expect(code).toMatch(/primary key \(session_id, agent_id\)/);
  });
  it("RLS 开着；只有一条 select 策略（在籍成员或这条群的客人）；不给 authenticated 任何写策略", () => {
    expect(code).toMatch(/alter table public\.agent_activity enable row level security/);
    expect(code).toMatch(/create policy aa_select on public\.agent_activity for select to authenticated/);
    expect(code).toMatch(/is_ws_member\(workspace_id, auth\.uid\(\)\)/);
    expect(code).toMatch(/is_session_guest\(session_id::text, auth\.uid\(\)\)/);
    expect(code).not.toMatch(/on public\.agent_activity for (insert|update|delete|all)/);
  });
  it("state 不加 CHECK：旧手机把认不出的值当「不知道」，以后多一档状态库不用跟着改", () => {
    expect(code).not.toMatch(/check\s*\(/i);
  });
  it("两张表都进 supabase_realtime（幂等：已在里面时吞掉 duplicate_object）", () => {
    expect(code).toMatch(/alter publication supabase_realtime add table public\.agent_activity;/);
    expect(code).toMatch(/alter publication supabase_realtime add table public\.workspace_sessions;/);
    expect(code.match(/exception when duplicate_object then null/g)).toHaveLength(2);
  });
});
