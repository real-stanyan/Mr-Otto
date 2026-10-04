// 0058_agent_shares.sql 的可执行版（#1545）：一张两边都读得到的小表；只有接受方写、只能以自己为 with_uid、且两人是已接受的好友；
// 接受方能删自己那一行。不加函数。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0058_agent_shares.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0058 共有的智能体", () => {
  it("表：分享方 + 原 id + 接受方 + 新 id + 名字快照，主键三元组；RLS 开着", () => {
    expect(code).toContain("create table if not exists public.agent_shares");
    expect(code).toMatch(/primary key \(owner_uid, agent_id, with_uid\)/);
    expect(code).toContain("copy_agent_id text not null");
    expect(code).toContain("alter table public.agent_shares enable row level security;");
  });
  it("读：两边都读得到；写：只有接受方、以自己为 with_uid、不是自己分享给自己、且是已接受的好友；删：接受方", () => {
    expect(code).toMatch(/for select to authenticated\s+using \(auth\.uid\(\) = owner_uid or auth\.uid\(\) = with_uid\)/);
    expect(code).toMatch(/for insert to authenticated\s+with check \(\s+auth\.uid\(\) = with_uid\s+and auth\.uid\(\) <> owner_uid\s+and exists/);
    expect(code).toContain("f.status = 'accepted'");
    expect(code).toMatch(/for delete to authenticated\s+using \(auth\.uid\(\) = with_uid\)/);
    expect(code).not.toMatch(/for update/);
    expect(code).not.toMatch(/create (or replace )?function/i);
  });
});
