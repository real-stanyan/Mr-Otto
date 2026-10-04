// 0056_pair_shared.sql 的可执行版（#1523，#1461 P2）。migration 在生产手动执行、门禁跑不到它；
// 钉的是形状：唯一索引从（主场，朋友，朝向）收成（主场，朋友）——先建新的再删旧的；不加策略、不加 RPC（朋友读车道走 0043 现成的）；
// 0053 自己那份一个字不改（它的测试仍钉着旧索引的形状）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0056_pair_shared.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0056 共享车道", () => {
  it("新唯一索引按（主场，朋友），只对 pair；先建再删旧的（中间任何一刻都至少有一条索引在）", () => {
    expect(code).toMatch(/create unique index if not exists ws_sessions_one_pair_per_peer_v2\s+on public\.workspace_sessions \(workspace_id, peer_uid\)\s+where chat_kind = 'pair'/);
    expect(code).toContain("drop index if exists public.ws_sessions_one_pair_per_peer;");
    expect(code.indexOf("create unique index")).toBeLessThan(code.indexOf("drop index"));
  });
  it("不加策略、不加函数、不改 CHECK：朋友读公开车道走 0043 的客人那一套", () => {
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/create (or replace )?function/i);
    expect(code).not.toMatch(/ws_sessions_chat_shape/);
  });
  it("不动会话行：撞上「一对两条」时停下交给人，不自动删", () => {
    expect(code).not.toMatch(/delete from/i);
    expect(code).not.toMatch(/update public\.workspace_sessions/i);
  });
});
