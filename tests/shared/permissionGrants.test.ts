import { describe, it, expect } from "vitest";
import { sessionGrants, grantLabel } from "../../src/shared/permissionGrants.js";
import { grantKeysFor } from "../../src/shared/grantKey.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const ev = (e: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent =>
  ({ seq: seq++, sessionId: "s1", ts: 1000 + seq, ...e }) as SessionEvent;

const WS = "/tmp/proj";
const created = (): SessionEvent => ev({ type: "session_created", workspace: WS });
const called = (id: string, name: string, args: unknown): SessionEvent =>
  ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id, name, args }] });

// 期望值统一从 grantKeysFor 现算：sessionGrants 的契约就是「重建出与授权时刻
// 逐字节一致的 key」（issue #342），两边共用同一个纯函数，测试只锁这层对齐
const keys = (name: string, args: unknown) => [...grantKeysFor({ name, args }, WS)];

describe("sessionGrants", () => {
  it("空日志 = 什么都没授过", () => {
    expect(sessionGrants([])).toEqual(new Set());
  });

  it("批准 + grant 才算授权;只批这一次不算", () => {
    const events = [
      created(),
      called("c1", "write_file", { path: "/tmp/proj/a.txt", content: "x" }),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("批准 + grant:session → 该调用的规范化 key 进名单（issue #342：粒度是 key 不是工具）", () => {
    const events = [
      created(),
      called("c1", "write_file", { path: "/tmp/proj/a.txt", content: "x" }),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(
      new Set(keys("write_file", { path: "/tmp/proj/a.txt", content: "x" }))
    );
  });

  it("bash 授的是那一条命令(规范化后),不是整个工具", () => {
    const events = [
      created(),
      called("c1", "bash", { cmd: "git status" }),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "always" }),
    ];
    const granted = sessionGrants(events);
    // 语义相同的写法命中同一 key
    expect(granted.has(keys("bash", { cmd: "git  status" })[0]!)).toBe(true);
    // 别的命令不命中
    expect(granted.has(keys("bash", { cmd: "git push --force" })[0]!)).toBe(false);
    // 裸工具名不出现 —— 旧的宽语义不会被新授权凭空造出来
    expect(granted.has("bash")).toBe(false);
  });

  it("revisedArgs 优先：用户改过参数,授权范围是实际执行的那份", () => {
    const events = [
      created(),
      called("c1", "write_file", { path: "/tmp/proj/模型想写的.txt", content: "x" }),
      ev({
        type: "approval_decision",
        toolCallId: "c1",
        decision: "approved",
        grant: "session",
        revisedArgs: { path: "/tmp/proj/用户保留的.txt", content: "y" },
      }),
    ];
    expect(sessionGrants(events)).toEqual(
      new Set(keys("write_file", { path: "/tmp/proj/用户保留的.txt", content: "y" }))
    );
  });

  it("拒绝就算带着 grant 也不算数 —— 日志是外部输入,不赌形状", () => {
    const events = [
      created(),
      called("c1", "write_file", { path: "/tmp/proj/a.txt", content: "x" }),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", grant: "always" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("对不上号的决定不算授权 —— 不知道是哪次调用就不能放行", () => {
    const events = [
      created(),
      ev({ type: "approval_decision", toolCallId: "不存在", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("多次授权各记各的 key", () => {
    const events = [
      created(),
      called("c1", "write_file", { path: "/tmp/proj/a.txt", content: "x" }),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "session" }),
      called("c2", "bash", { cmd: "ls" }),
      ev({ type: "approval_decision", toolCallId: "c2", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(
      new Set([
        ...keys("write_file", { path: "/tmp/proj/a.txt", content: "x" }),
        ...keys("bash", { cmd: "ls" }),
      ])
    );
  });
});

describe("grantLabel", () => {
  it("档位有中文名 —— 日志 reason 里那句话得自解释", () => {
    expect(grantLabel("session")).toBe("本次会话");
    expect(grantLabel("always")).toBe("永久");
  });
});
