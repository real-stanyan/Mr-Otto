// 0053_pair_chats.sql 的可执行版（#1461 P1）。migration 在生产手动执行、门禁跑不到它；
// 这几条钉的是形状：原来四支原样保留、只多 pair 一支；同一对一条；在场提示只回一个数、只给配对的朋友、不加写策略。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0053_pair_chats.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0053 私密车道", () => {
  it("CHECK 多一支 pair：0~6 只、peer_uid 与 facing 非空", () => {
    expect(code).toMatch(/chat_kind = 'pair' and cardinality\(agent_ids\) between 0 and 6 and peer_uid is not null and facing is not null/);
  });
  it("沿用同一个约束名，0048 的四支逐字保留（删了再建，漏一支就是那一种聊天再也建不出来）", () => {
    expect(code).toContain("drop constraint if exists ws_sessions_chat_shape");
    expect(code).toContain("chat_kind is null and cardinality(agent_ids) = 0");
    expect(code).toContain("chat_kind = 'dm' and cardinality(agent_ids) = 1");
    expect(code).toContain("chat_kind = 'group' and cardinality(agent_ids) between 0 and 6");
    expect(code).toContain("chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null");
  });
  it("facing 只收 self / both，可空（别的会话没有这一格）", () => {
    expect(code).toMatch(/check \(facing is null or facing in \('self', 'both'\)\)/);
  });
  it("同一对一条：唯一索引按（主场，朋友，朝向）", () => {
    expect(code).toMatch(/create unique index if not exists \w+\s+on public\.workspace_sessions \(workspace_id, peer_uid, facing\)\s+where chat_kind = 'pair'/);
  });
  it("在场提示：security definer、只回计数、只给配对的那位朋友、仍是好友才回、只授 authenticated", () => {
    expect(code).toMatch(/create or replace function public\.pair_presence\(p_owner uuid\)\s+returns integer/);
    expect(code).toMatch(/security definer set search_path = public/);
    expect(code).toContain("s.peer_uid = auth.uid()");
    expect(code).toContain("s.facing = 'self'");
    expect(code).toContain("f.status = 'accepted'");
    expect(code).toMatch(/revoke all on function public\.pair_presence\(uuid\) from public/);
    expect(code).toMatch(/revoke all on function public\.pair_presence\(uuid\) from anon/);
    expect(code).toMatch(/grant execute on function public\.pair_presence\(uuid\) to authenticated/);
  });
  it("不给 authenticated 加任何策略：朋友对车道那一行没有读路径，这正是私密的定义", () => expect(code).not.toMatch(/create policy/i));
});
