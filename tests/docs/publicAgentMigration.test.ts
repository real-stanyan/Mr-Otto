// 0057_public_agent.sql 的可执行版（#1533）：一列 + 一个只给好友读的 security definer RPC；不给任何写策略。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0057_public_agent.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0057 公开智能体", () => {
  it("profiles 加 public_agent_id（幂等）", () => {
    expect(code).toContain("alter table public.profiles add column if not exists public_agent_id text;");
  });
  it("public_agent_of：security definer、按主场 join、只给已接受且两边都不是仅聊天的好友、只回五列、只授 authenticated", () => {
    expect(code).toMatch(/create or replace function public\.public_agent_of\(p_uid uuid\)\s+returns table \(workspace_id uuid, agent_id text, name text, description text, avatar_slot smallint\)/);
    expect(code).toMatch(/security definer set search_path = public/);
    expect(code).toContain("join workspaces w on w.kind = 'home' and w.owner_uid = p.id");
    expect(code).toContain("a.agent_id = p.public_agent_id");
    expect(code).toContain("f.status = 'accepted'");
    expect(code).toContain("f.requester_tier <> 'chat' and f.addressee_tier <> 'chat'");
    expect(code).not.toMatch(/instructions|models|tools/);
    expect(code).toMatch(/revoke all on function public\.public_agent_of\(uuid\) from public/);
    expect(code).toMatch(/revoke all on function public\.public_agent_of\(uuid\) from anon/);
    expect(code).toMatch(/grant execute on function public\.public_agent_of\(uuid\) to authenticated/);
  });
  it("不加策略：设定走 profiles_update_self，读走 RPC", () => {
    expect(code).not.toMatch(/create policy/i);
  });
});
