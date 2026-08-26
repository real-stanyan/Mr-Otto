// 正文里点一条「文件:行号」之后 store 该发生什么。
// 三条都容易漏:①面板得开(不开的话点了像没反应)②路径要削成工作区相对
// ③工作区外的路径不能静默吞掉——面板照开,但要带着原样路径去说"打不开"。

import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

function reset(workspace: string) {
  useChat.setState({ workspace, fileJump: null, filesPanelOpen: false, terminalPanelOpen: false });
}

describe("openFileAt", () => {
  beforeEach(() => reset("/Users/x/repo"));

  it("开 Files 面板并记下目标行", () => {
    useChat.getState().openFileAt("src/a.ts", 12);
    expect(useChat.getState().filesPanelOpen).toBe(true);
    expect(useChat.getState().fileJump).toMatchObject({ rel: "src/a.ts", line: 12 });
  });

  it("工作区内的绝对路径削成相对", () => {
    useChat.getState().openFileAt("/Users/x/repo/src/a.ts", 3);
    expect(useChat.getState().fileJump?.rel).toBe("src/a.ts");
  });

  it("工作区外的路径:rel 为 null,原样路径留着给面板报信", () => {
    useChat.getState().openFileAt("/etc/hosts", null);
    expect(useChat.getState().fileJump).toMatchObject({ rel: null, raw: "/etc/hosts" });
    expect(useChat.getState().filesPanelOpen).toBe(true);
  });

  it("没给行号就只开文件", () => {
    useChat.getState().openFileAt("src/a.ts");
    expect(useChat.getState().fileJump?.line).toBeNull();
  });

  it("连点同一条也换一个 seq(否则第二次点毫无反应)", () => {
    useChat.getState().openFileAt("src/a.ts", 5);
    const first = useChat.getState().fileJump?.seq;
    useChat.getState().openFileAt("src/a.ts", 5);
    expect(useChat.getState().fileJump?.seq).not.toBe(first);
  });

  it("开 Files 跳转会关掉同槽位的终端面板", () => {
    useChat.getState().openTerminalPanel();
    useChat.getState().openFileAt("src/a.ts", 1);
    expect(useChat.getState().terminalPanelOpen).toBe(false);
  });
});
