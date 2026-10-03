// 0048_outreach_sessions.sql 的可执行版（#1441）。migration 在生产手动执行、门禁跑不到它；
// 这几条钉的是约束形状：外联会话恰好一只智能体 + 好友、原来三支原样保留、每对一条、不加任何写策略。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0048_outreach_sessions.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0048 外联会话", () => {
  it("CHECK 多一支 outreach：恰好一只智能体、peer_uid 非空", () => {
    expect(code).toMatch(/chat_kind = 'outreach' and cardinality\(agent_ids\) = 1 and peer_uid is not null/);
  });
  it("沿用 0037 的约束名，原来三支原样保留", () => {
    expect(code).toContain("ws_sessions_chat_shape");
    expect(code).toContain("chat_kind is null and cardinality(agent_ids) = 0");
    expect(code).toContain("chat_kind = 'dm' and cardinality(agent_ids) = 1");
    expect(code).toContain("chat_kind = 'group' and cardinality(agent_ids) between 0 and 6");
  });
  it("每对一条：唯一索引按（主场，智能体，好友）", () => {
    expect(code).toMatch(/create unique index if not exists \w+\s+on public\.workspace_sessions \(workspace_id, \(agent_ids\[1\]\), peer_uid\)\s+where chat_kind = 'outreach'/);
  });
  it("不给 authenticated 加任何写策略", () => expect(code).not.toMatch(/create policy/i));
});
