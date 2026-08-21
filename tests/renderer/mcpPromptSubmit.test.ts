import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

// F2 / issue #158：展开 MCP prompt 是「往输入框里加一段」，不是「清空重写」。
// 用户在敲 `/xxx` 之前完全可能已经打了半句话——slash 菜单的 removeOnExecute
// 只挪走 `/token` 本身。这条语义从前零自动化覆盖：把 injectComposer 的第二个
// 参数从 true 改回 false，CI 抓不到。
//
// 这一组同时把「回来晚了怎么办」那两条（review finding 1/2）也钉住——
// 它们和 append 一样只活在 store 里，没有测试就没有第二个读者。

type Arg = { name: string; description?: string; required?: boolean };

/** 默认带一个**选填**参数：openMcpPromptForm 对零参数的 prompt 会顺手自己
    发起一次展开（"没有可填的东西"），那会让下面每条用例都多出一次调用 */
const PROMPT = (args: readonly Arg[] = [{ name: "topic" }]) => ({
  server: "gh",
  name: "summarize",
  arguments: args,
});

let expandMcpPrompt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  expandMcpPrompt = vi.fn(async () => "展开后的正文");
  vi.stubGlobal("window", { otter: { expandMcpPrompt } });
  useChat.setState({ mcpPromptForm: null, mcpPromptToken: 0, composerInject: null, sessionId: "s1" });
});

describe("submitMcpPromptForm", () => {
  it("展开成功 → 注入输入框，且是**追加**（append: true）", async () => {
    useChat.getState().openMcpPromptForm(PROMPT());
    useChat.getState().setMcpPromptFormValue("topic", "本周进展");
    await useChat.getState().submitMcpPromptForm();

    expect(expandMcpPrompt).toHaveBeenCalledWith("gh", "summarize", { topic: "本周进展" });
    expect(useChat.getState().composerInject).toEqual({ text: "展开后的正文", append: true });
    expect(useChat.getState().mcpPromptForm).toBeNull();
  });

  it("零参数的 prompt 开卡即展开，同样是追加", async () => {
    useChat.getState().openMcpPromptForm(PROMPT([]));
    await vi.waitFor(() =>
      expect(useChat.getState().composerInject).toEqual({ text: "展开后的正文", append: true })
    );
  });

  it("必填项没填 → 不发 IPC，表单上留一句人话", async () => {
    useChat.getState().openMcpPromptForm(PROMPT([{ name: "topic", required: true }]));
    await useChat.getState().submitMcpPromptForm();

    expect(expandMcpPrompt).not.toHaveBeenCalled();
    expect(useChat.getState().mcpPromptForm?.error).toContain("topic");
    expect(useChat.getState().composerInject).toBeNull();
  });

  it("展开失败 → 报错留在表单上等重试，输入框不动", async () => {
    expandMcpPrompt.mockRejectedValue(new Error("server 掉线了"));
    useChat.getState().openMcpPromptForm(PROMPT());
    await useChat.getState().submitMcpPromptForm();

    expect(useChat.getState().mcpPromptForm?.error).toContain("server 掉线了");
    expect(useChat.getState().mcpPromptForm?.submitting).toBe(false);
    expect(useChat.getState().composerInject).toBeNull();
  });

  it("回来之前这张卡被取消了 → 结果原地丢掉（review finding 1）", async () => {
    let release!: (v: string) => void;
    expandMcpPrompt.mockReturnValue(new Promise<string>((r) => { release = r; }));
    useChat.getState().openMcpPromptForm(PROMPT());
    const pending = useChat.getState().submitMcpPromptForm();

    useChat.getState().cancelMcpPromptForm();
    release("迟到的正文");
    await pending;

    expect(useChat.getState().composerInject).toBeNull();
  });

  it("回来之前用户切了会话 → 结果原地丢掉（review finding 2）", async () => {
    let release!: (v: string) => void;
    expandMcpPrompt.mockReturnValue(new Promise<string>((r) => { release = r; }));
    useChat.getState().openMcpPromptForm(PROMPT());
    const pending = useChat.getState().submitMcpPromptForm();

    useChat.setState({ sessionId: "s2" });
    release("迟到的正文");
    await pending;

    expect(useChat.getState().composerInject).toBeNull();
  });
});
