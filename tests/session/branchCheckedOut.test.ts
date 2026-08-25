// branch_checked_out（issue #411 / ADR-0093）——分支切换事件的三条钉子。
//
// 为什么这个事件必须落盘：会话时间线上「切到分支 xxx」那一行是日志投影，而硬规则
// 说任何投影都得能从日志推导。渲染层自己记一份的话，刷新即失忆，且日志和屏幕会有
// 两份说法。
//
// 为什么它对模型不可见：分支名不是对话内容。工作区里此刻是哪份代码，模型读文件时
// 当场就知道；把分支名喂回去只是多一句它无法核对的断言。

import { describe, expect, it } from "vitest";
import { shouldPersist } from "../../src/session/persistencePolicy.js";
import { assertReplayable, type BranchCheckedOutEvent, type SessionEvent } from "../../src/session/events.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const checkout: BranchCheckedOutEvent = {
  seq: 2,
  sessionId: "s1",
  ts: 1002,
  type: "branch_checked_out",
  ignorable: true,
  repoDir: "/repo",
  branch: "feature/x",
  from: "main",
};

describe("branch_checked_out", () => {
  it("落盘：时间线上那一行没有别的事实来源", () => {
    expect(shouldPersist("branch_checked_out")).toBe(true);
  });

  it("是本版本认识的类型 —— 重放不该被拒", () => {
    expect(() => assertReplayable([checkout])).not.toThrow();
  });

  it("对模型投影隐形：同一段日志加不加它，deriveMessages 逐条一致", () => {
    const base: SessionEvent[] = [
      { seq: 0, sessionId: "s1", ts: 1000, type: "session_created" },
      { seq: 1, sessionId: "s1", ts: 1001, type: "user_message", content: "你好" },
      { seq: 3, sessionId: "s1", ts: 1003, type: "user_message", content: "再看一眼" },
    ];
    const withCheckout = [...base.slice(0, 2), checkout, ...base.slice(2)];
    expect(deriveMessages(withCheckout)).toEqual(deriveMessages(base));
  });
});
