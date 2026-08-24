import { beforeEach, describe, expect, it } from "vitest";
import { dispatchSlash, slashCommandName } from "../../src/renderer/src/commands.js";
import { useChat } from "../../src/renderer/src/store.js";

describe("slashCommandName", () => {
  it("命令形：/名字 或 /名字 参数", () => {
    expect(slashCommandName("/compact")).toBe("/compact");
    expect(slashCommandName("/rename 修 bug 那次")).toBe("/rename");
  });
  it("绝对路径不是命令：首个 token 里有第二个 /", () => {
    expect(slashCommandName("/Users/stanyan/Downloads/Image 7.webp 图片地址你去放一下")).toBeNull();
    expect(slashCommandName("/usr/local/bin/node")).toBeNull();
  });
  it("裸 / 和空串不是命令", () => {
    expect(slashCommandName("/")).toBeNull();
    expect(slashCommandName("")).toBeNull();
  });
});

describe("dispatchSlash", () => {
  beforeEach(() => useChat.setState({ error: null }));

  it("路径开头的普通消息放行（返回 false，不报未知指令）", () => {
    expect(dispatchSlash("/Users/stanyan/Downloads/Image 7.webp 图片地址你去放一下")).toBe(false);
    expect(useChat.getState().error).toBeNull();
  });
  it("未知命令形指令仍就地报错", () => {
    expect(dispatchSlash("/nosuchcmd")).toBe(true);
    expect(useChat.getState().error).toContain("/nosuchcmd");
  });
});
