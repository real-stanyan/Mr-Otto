// @vitest-environment jsdom
//
// 输入框那枚模型选择器**真渲染一遍**（#1042）。列哪几款的判据在
// tests/renderer/lib/modelMenu.test.ts 里逐条钉着；这里补的是那份纯逻辑够不到的
// 三件事：订阅那一组画不画得出来、Auto 那一行的说明文案在不在、以及选中 Auto 时
// 触发器上写的是「Auto」而不是那个口令字面量（`__auto__` 漏出来就是界面坏了）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ModelPicker } from "../../src/renderer/src/components/ModelPicker.js";
import { useChat } from "../../src/renderer/src/store.js";
import { AUTO_MODEL } from "../../src/shared/autoModel.js";

// jsdom 没有布局，cmdk（选单浮层的底座）开箱就要这两样。补最小实现，不模拟布局——
// 这份测试问的是「列出了谁」，不是「排得对不对」
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as never;
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** 真库 model_route 此刻供的那六款（从便宜到贵） */
const HOSTED = [
  "deepseek-v4-flash", "glm-5.3-flash", "qwen3.8-flash",
  "deepseek-v4-pro", "glm-5.3", "qwen3.8-max",
];

/** 「付了钱、一把 key 都没配」—— 改动前这个人打开选择器一组都看不到 */
function seedSubscribedNoKeys(): void {
  useChat.setState({
    keyStatus: {},
    ollamaModels: [],
    billing: {
      me: {
        plan: "max", status: "active", plans: [], models: HOSTED,
        modelPlatforms: {}, windows: {}, addon: { remainingMicro: 0 }, periodEnd: null,
      },
      fetchedAt: 1,
      exhausted: null,
    } as never,
  });
}

/** 选单里那几个组头。**不能用 getByText**：「DeepSeek」既是组头也是每一行厂商
    字形的 alt 文本，撞名。cmdk 给组头挂的是 `[cmdk-group-heading]` */
const groupHeadings = (): string[] =>
  [...document.querySelectorAll("[cmdk-group-heading]")].map((el) => el.textContent ?? "");

afterEach(() => {
  cleanup();
  useChat.setState({ keyStatus: {}, ollamaModels: [], billing: null });
});

describe("ModelPicker：订阅那一组", () => {
  it("付了钱、没配 key 的人打开它，六款一个不少 —— 改动前这里是空的", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByText("订阅")).toBeInTheDocument();
    // 一行的文字是「厂商字形的 alt + 目录里那个标签 + 有没有『视觉』记号」拼起来的，
    // 所以这一条同时钉住四件事：顺序照抄网关那份（从便宜到贵，跨三家交替出现，
    // 按厂商归并就会毁掉它）、标签取的是目录那一份不是裸 id、每一行都画了厂商字形、
    // 「视觉」记号跟对了行
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "DeepSeekDeepSeek V4 Flash",
      "ZhipuGLM-5.3 Flash（视觉）视觉",
      "QwenQwen3.8 Flash",
      "DeepSeekDeepSeek V4 Pro",
      "ZhipuGLM-5.3",
      "QwenQwen3.8 Max视觉",
    ]);
    // 「添加更多模型…」也没了（#1051）：它通往「模型配置」，而那一页对订阅用户
    // 已经收起来了 —— 留着就是一条点了跳去一个不存在的页面的路
    expect(screen.queryByText("添加更多模型…")).not.toBeInTheDocument();
  });

  it("订阅用户一个厂商组都没有 —— 配着 key 的、和免 key 的本机 Ollama 都没有（#1051）", async () => {
    seedSubscribedNoKeys();
    useChat.setState({
      keyStatus: { DEEPSEEK_API_KEY: "sk-x", GLM_API_KEY: "sk-y" },
      ollamaModels: [
        { id: "ollama/a", tag: "a", contextLength: 8192, tools: true, vision: false, thinking: false },
      ],
    });
    render(<ModelPicker value="glm-5.3" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(groupHeadings()).toEqual(["订阅"]);
  });

  it("没订阅的人一个字都没变：厂商组照旧、「添加更多模型…」照旧", async () => {
    useChat.setState({
      keyStatus: { DEEPSEEK_API_KEY: "sk-x" }, ollamaModels: [], billing: null,
    });
    render(<ModelPicker value="deepseek-v4-flash" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(groupHeadings()).toContain("DeepSeek");
    expect(groupHeadings()).not.toContain("订阅");
    expect(screen.getByText("添加更多模型…")).toBeInTheDocument();
  });

  it("没订阅（billing 为 null）时整组不出现，只剩「添加更多模型…」那条路", async () => {
    useChat.setState({ keyStatus: {}, ollamaModels: [], billing: null });
    render(<ModelPicker value="glm-5.3" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.queryByText("订阅")).not.toBeInTheDocument();
    expect(screen.getByText("添加更多模型…")).toBeInTheDocument();
  });
});

describe("ModelPicker：Auto", () => {
  it("allowAuto 时长出 Auto，且带着那行说明 —— 只写一个词的话点它的人只能靠猜", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" allowAuto onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(screen.getByText("每轮起跑前判一手难度，再挑贵的还是便宜的")).toBeInTheDocument();
  });

  it("不给 allowAuto 就不长（代读员 / 小模型 / 子智能体那几处）", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByText("Auto")).not.toBeInTheDocument();
  });

  it("Auto 是 DOM 顺序里的第一项 —— 它排在选中的那一款之上（#1049 的另一半在滚动位置上）", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" allowAuto onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toBe("Auto每轮起跑前判一手难度，再挑贵的还是便宜的");
    // 「订阅」那个组头也在它上面 —— 真机上这两样是一起被滚出视野的，见 #1049
    expect(screen.getByText("订阅")).toBeInTheDocument();
  });

  it("点 Auto 回的是那个口令，不是某一款型号 id", async () => {
    seedSubscribedNoKeys();
    const onChange = vi.fn();
    render(<ModelPicker value="glm-5.3" allowAuto onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByText("Auto"));
    expect(onChange).toHaveBeenCalledWith(AUTO_MODEL, "auto");
  });

  it("auto 开着时触发器上写「Auto」—— `__auto__` 漏到界面上就是坏了", () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" auto allowAuto onChange={() => {}} />);
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Auto");
    expect(trigger).not.toHaveTextContent(AUTO_MODEL);
  });

  it("auto 关着时触发器照旧写当前那一款", () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" allowAuto onChange={() => {}} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("GLM-5.3");
  });
});
