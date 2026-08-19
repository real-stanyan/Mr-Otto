import { describe, it, expect } from "vitest";
import { rememberActiveTerminal, recallActiveTerminal } from "../../src/renderer/src/lib/terminalRegistry.js";

// 只测 rememberActiveTerminal/recallActiveTerminal 这两个纯 Map 操作——
// 展开/收起面板(App.tsx panelWide)会卸载重挂 TerminalView,组件自己的
// useState 活不过这一下,记忆必须挂在组件外面才扛得住(finding: 展开/收起
// 按钮把用户弹回第 1 个标签)。这里不碰 terminalRegistry 本体(它 get() 会
// new Terminal() 需要 DOM),纯 Map 逻辑跟 xterm 无关,可以直接测
describe("terminalRegistry 的活跃标签记忆", () => {
  it("记完能原样取回", () => {
    rememberActiveTerminal("s1", "t1");
    expect(recallActiveTerminal("s1")).toBe("t1");
  });

  it("没记过的会话取回 null，不是 undefined 也不是抛错", () => {
    expect(recallActiveTerminal("从没见过的会话")).toBeNull();
  });

  it("同一个会话记第二次会覆盖第一次（用户切标签）", () => {
    rememberActiveTerminal("s2", "a");
    rememberActiveTerminal("s2", "b");
    expect(recallActiveTerminal("s2")).toBe("b");
  });

  it("id 传 null 清掉记忆——不是留一个必然失效的旧值占位", () => {
    rememberActiveTerminal("s3", "a");
    rememberActiveTerminal("s3", null);
    expect(recallActiveTerminal("s3")).toBeNull();
  });

  it("不同会话各记各的，互不干扰", () => {
    rememberActiveTerminal("s4", "x");
    rememberActiveTerminal("s5", "y");
    expect(recallActiveTerminal("s4")).toBe("x");
    expect(recallActiveTerminal("s5")).toBe("y");
  });
});
