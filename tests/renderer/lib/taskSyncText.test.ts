import { describe, expect, it } from "vitest";
import { taskSyncStatusText } from "../../../src/renderer/src/lib/taskSyncText.js";

describe("taskSyncStatusText\uFF08#1223\uFF09", () => {
  it("四态各一句\uFF1Boff 带原因时说原因\uFF0C不把\u300C没建表\u300D说成\u300C没登录\u300D", () => {
    expect(taskSyncStatusText({ kind: "off", reason: null })).toBe("任务会话只在这台电脑上\uFF08登录后会跟账号同步\uFF09");
    expect(taskSyncStatusText({ kind: "off", reason: "云端还没有任务会话表\uFF08migration 0036 未执行\uFF09" })).toBe(
      "任务会话云同步关着\uFF1A云端还没有任务会话表\uFF08migration 0036 未执行\uFF09"
    );
    expect(taskSyncStatusText({ kind: "idle", lastSyncedAt: 1 })).toBe("任务会话已与账号同步");
    expect(taskSyncStatusText({ kind: "syncing" })).toBe("任务会话同步中\u2026");
    expect(taskSyncStatusText({ kind: "error", message: "x", lastSyncedAt: null })).toBe(
      "任务会话同步失败\uFF0C会自动重试"
    );
  });
  it("frozen 自成一句\uFF1A几条停了 + 其余照常 + 原因\uFF0C且**不许**出现\u300C重试\u300D\uFF08终审 I2\uFF09", () => {
    // freeze 不 scheduleRetry\uFF1B并进 error 那句就是对着一个永远不会自己好的状态说\u300C会自动重试\u300D
    const line = taskSyncStatusText({
      kind: "frozen", count: 2, message: "会话 s-1 的云端副本已停止同步\uFF1Abad_request: event too large", lastSyncedAt: 1,
    });
    expect(line).toBe(
      "任务会话有 2 条已停止同步\uFF08其余照常同步\uFF09\uFF1A会话 s-1 的云端副本已停止同步\uFF1Abad_request: event too large"
    );
    expect(line).not.toContain("重试");
  });
});
