// 0065_admin_lanes.sql 的可执行版（#1605）。它与 0064_admin_dm_roster.sql 都「先删后建」同一个约束：0065 必须两支都带，
// 否则谁后跑谁抹掉对方那一支（真机 2026-10-05 撞过）。顺手钉 tasks 的 id 改成 text（任务 id 是 t_xxxxxxxx）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0065_admin_lanes.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0065 管理员车道", () => {
  it("约束同时带 0064 的 dm 一支与 admins 一支，0053 的五支原样", () => {
    expect(code).toContain("drop constraint if exists ws_sessions_chat_shape");
    expect(code).toContain("chat_kind = 'dm' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and 6");
    expect(code).toContain("chat_kind = 'admins' and agent_ids = array['admin']::text[] and peer_uid is not null");
    for (const branch of [
      "chat_kind is null and cardinality(agent_ids) = 0",
      "chat_kind = 'dm' and cardinality(agent_ids) = 1",
      "chat_kind = 'group' and cardinality(agent_ids) between 0 and 6",
      "chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null",
      "chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null",
    ]) expect(code).toContain(branch);
  });
  it("一家对一位朋友一条；tasks 的 id / parent_id 改成 text（外键拆了再建）", () => {
    expect(code).toContain("ws_sessions_one_admins_per_peer");
    expect(code).toContain("alter column id type text");
    expect(code).toContain("alter column parent_id type text");
    expect(code).toContain("add constraint tasks_parent_id_fkey foreign key (parent_id) references public.tasks(id)");
  });
});
