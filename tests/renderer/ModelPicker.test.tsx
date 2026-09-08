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

    // 订阅那一组不画组头（#1058）
    expect(groupHeadings()).toEqual([]);
    // 一行的文字是「厂商字形的 alt + 目录里那个标签」拼起来的，所以这一条同时钉住
    // 三件事：顺序照抄网关那份（从便宜到贵，跨三家交替出现，按厂商归并就会毁掉它）、
    // 标签取的是目录那一份不是裸 id、每一行都画了厂商字形。
    // **末尾不再有「视觉」记号**（#1058）—— 它在 `GLM-5.3 Flash（视觉）` 那一行是
    // 同一件事说两遍，而这一列的整齐比多一个信号值钱
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "DeepSeekDeepSeek V4 Flash",
      "ZhipuGLM-5.3 Flash（视觉）",
      "QwenQwen3.8 Flash",
      "DeepSeekDeepSeek V4 Pro",
      "ZhipuGLM-5.3",
      "QwenQwen3.8 Max",
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
    // 一个组头都没有：订阅那组不画（#1058），厂商那几组一个都不在（#1051）
    expect(groupHeadings()).toEqual([]);
    expect(screen.getAllByRole("option").length).toBe(6);
  });

  it("没订阅的人一个字都没变：厂商组照旧、「添加更多模型…」照旧", async () => {
    useChat.setState({
      keyStatus: { DEEPSEEK_API_KEY: "sk-x" }, ollamaModels: [], billing: null,
    });
    render(<ModelPicker value="deepseek-v4-flash" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(groupHeadings()).toContain("DeepSeek");
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
  it("allowAuto 时长出 Auto，且与下面几款**同一个排版**（#1058 撤掉了 ADR-0244 那第二行）", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" allowAuto onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));

    const auto = screen.getAllByRole("option")[0]!;
    // 整行只有「Auto」四个字，没有第二行正文 —— 一行两层会把这一列的基线打断
    expect(auto.textContent).toBe("Auto");
    // 那句话没丢，降级成 title
    expect(auto.getAttribute("title")).toContain("判一手难度");
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
    expect(options[0]).toBe("Auto");
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

describe("ModelPicker：「文字 / 图像」那枚开关（#1086）", () => {
  const IMAGES = ["seedream-5-0-lite", "gemini-3.1-flash-image", "gemini-3-pro-image"];

  /** 打开浮层并切到「图像」那一格 */
  async function openImageTab(): Promise<void> {
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("tab", { name: "图像" }));
  }

  /** 此刻哪一行带着勾。**不能靠「行里有没有 svg」**：每一行左边都有厂商标那枚 svg，
      那样认会把所有行都认成选中（加 logo 那天真的这样了） */
  const picked = (): string[] =>
    screen.getAllByRole("option").filter((o) => o.getAttribute("data-picked") === "true")
      .map((o) => o.textContent ?? "");

  it("清单空 = 整枚开关不画，下面一切照旧 —— 没订阅 / 还没查到 / 网关不供出图同一个答案", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBe(6);
  });

  it("给了清单但没给回调 = 也不画 —— 一颗点了什么都不会发生的开关就是撒谎的勾", async () => {
    seedSubscribedNoKeys();
    render(<ModelPicker value="glm-5.3" onChange={() => {}} imageModels={IMAGES} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("切到「图像」：Auto 在最上，每一款带人话名字与厂商标，文字那几款一个都不剩", async () => {
    seedSubscribedNoKeys();
    render(
      <ModelPicker value="glm-5.3" onChange={() => {}} imageModels={IMAGES} onImageChange={() => {}} />
    );
    // 浮层开着的时候有两个 combobox（cmdk 那个 sr-only 输入锚点也是），所以先抓
    const trigger = screen.getByRole("combobox");
    await openImageTab();
    // 行的文字 = 厂商字形的可访问名 + 人话标签，同文字那一格的形状
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Auto",
      "ByteDanceSeedream 5.0 Lite",
      "GeminiNano Banana 2",
      "GeminiNano Banana Pro",
    ]);
    // 触发器上那行字**照旧是文字模型** —— 它回答的是「这一轮跟谁说话」，
    // 不该因为你翻到了图像那一格就变
    expect(trigger.textContent).toContain("GLM-5.3");
  });

  it("不到两款不画 Auto —— 那时它和唯一那款是同一件事（同文字那格的 AUTO_MIN_MODELS）", async () => {
    seedSubscribedNoKeys();
    render(
      <ModelPicker value="glm-5.3" onChange={() => {}} imageModels={["seedream-4.5"]} onImageChange={() => {}} />
    );
    await openImageTab();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["ByteDanceSeedream 4.5"]);
  });

  it("没选过 = Auto 那一档，勾在 Auto 上而不是某一款上", async () => {
    // 「没选过」与「显式选了 Auto」行为逐字相同，分成两格的话，一个从没碰过这一格的人
    // 会看到「一行都没勾」而他其实正在 Auto 里
    seedSubscribedNoKeys();
    render(
      <ModelPicker value="glm-5.3" onChange={() => {}} imageModels={IMAGES} onImageChange={() => {}} />
    );
    await openImageTab();
    expect(picked()).toEqual(["Auto"]);
  });

  it("选了某一款：勾落在那一款上 —— 这一格因此分得出「我选的」和「默认就是它」", async () => {
    seedSubscribedNoKeys();
    render(
      <ModelPicker
        value="glm-5.3" onChange={() => {}}
        imageModels={IMAGES} imageModel="gemini-3-pro-image" onImageChange={() => {}}
      />
    );
    await openImageTab();
    expect(picked()).toEqual(["GeminiNano Banana Pro"]);
  });

  it("选中的那款网关下架了：勾落回真会跑的那款 —— 与主进程解路共用 pickImageModel", async () => {
    seedSubscribedNoKeys();
    render(
      <ModelPicker
        value="glm-5.3" onChange={() => {}}
        imageModels={IMAGES} imageModel="gone-image" onImageChange={() => {}}
      />
    );
    await openImageTab();
    expect(picked()).toEqual(["ByteDanceSeedream 5.0 Lite"]);
  });

  it("点一行只回调出图型号，**触发器上那行字一个字不变** —— 那颗按钮说的是文字模型", async () => {
    seedSubscribedNoKeys();
    const onImageChange = vi.fn();
    const onChange = vi.fn();
    render(
      <ModelPicker value="glm-5.3" onChange={onChange} imageModels={IMAGES} onImageChange={onImageChange} />
    );
    const trigger = screen.getByRole("combobox");
    const before = trigger.textContent;
    await openImageTab();
    await userEvent.click(screen.getByText("Nano Banana Pro"));
    expect(onImageChange).toHaveBeenCalledWith("gemini-3-pro-image");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.textContent).toBe(before);
  });

  it("点 Auto 回的是那个口令 —— 路由那侧它不在清单里，于是天然回落最便宜那款", async () => {
    seedSubscribedNoKeys();
    const onImageChange = vi.fn();
    render(
      <ModelPicker
        value="glm-5.3" onChange={() => {}}
        imageModels={IMAGES} imageModel="gemini-3-pro-image" onImageChange={onImageChange}
      />
    );
    await openImageTab();
    await userEvent.click(screen.getByText("Auto"));
    expect(onImageChange).toHaveBeenCalledWith(AUTO_MODEL);
  });

  it("重新打开时回到「文字」那一格 —— 触发器写的是文字模型，开出来停在别处就是按钮说假话", async () => {
    seedSubscribedNoKeys();
    render(
      <ModelPicker value="glm-5.3" onChange={() => {}} imageModels={IMAGES} onImageChange={() => {}} />
    );
    await openImageTab();
    expect(screen.getByRole("tab", { name: "图像" })).toHaveAttribute("data-state", "active");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("tab", { name: "文字" })).toHaveAttribute("data-state", "active");
  });
});
