// 0064_admin_dm_roster.sql 的可执行版（#1606）。migration 在生产手动执行、门禁跑不到它；
// 这几条钉的是形状：dm 多一支「admin 打头、1~6 只」，0053 的五支原样保留（删了再建，漏一支就是那一种聊天再也写不进）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_GROUP_MAX } from "../../src/shared/chatRoster.js";

const sql = readFileSync(new URL("../../supabase/migrations/0064_admin_dm_roster.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0064 管理员私聊的名单", () => {
  it("dm 多一支：admin 打头、1~CHAT_GROUP_MAX 只", () => {
    expect(code).toContain(`chat_kind = 'dm' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and ${CHAT_GROUP_MAX}`);
  });
  it("沿用同一个约束名，0053 的五支逐字保留", () => {
    expect(code).toContain("drop constraint if exists ws_sessions_chat_shape");
    expect(code).toContain("chat_kind is null and cardinality(agent_ids) = 0");
    expect(code).toContain("chat_kind = 'dm' and cardinality(agent_ids) = 1");
    expect(code).toContain("chat_kind = 'group' and cardinality(agent_ids) between 0 and 6");
    expect(code).toContain("chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null");
    expect(code).toContain("chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null");
  });
});
