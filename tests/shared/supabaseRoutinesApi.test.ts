// 行映射：客户端与 runtime 共用（#1283）。
import { describe, expect, it } from "vitest";
import { routineRowOf } from "../../src/shared/supabaseRoutinesApi.js";

describe("routineRowOf", () => {
  it("列名翻字段名，时间戳翻毫秒，schedule 过校验", () => {
    const row = routineRowOf({
      id: "r1", workspace_id: "w", agent_id: "ops", owner_uid: "owner", title: "早报", instruction: "看报表",
      schedule: { kind: "weekly", days: [3, 1], time: "09:00" }, tz: "Asia/Shanghai", enabled: true,
      next_run_at: "2026-10-05T01:00:00+00:00", last_run_at: null, last_status: null, created_by: "user",
      created_at: "2026-10-04T00:00:00+00:00", updated_at: "2026-10-04T00:00:00+00:00",
    });
    expect(row).toMatchObject({ id: "r1", workspaceId: "w", agentId: "ops", schedule: { kind: "weekly", days: [1, 3], time: "09:00" }, nextRunAt: Date.UTC(2026, 9, 5, 1), lastRunAt: null, createdBy: "user" });
  });
});
