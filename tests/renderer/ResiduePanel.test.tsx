// @vitest-environment jsdom
//
// 残留清单弹窗（issue #759）：owned 默认勾选、suspected 默认不勾、
// 「仅展示」的 suspected 端口没有 checkbox；一键清逐项走 residueClean，
// 失败带 note（"已消失"）视为完成，真失败留在原地给红字。
//
// review finding 2：open 与 items 解耦——items 的真相在挂载方(store)手里，
// 这个组件只负责"open 为 true 且 items 非空时画出来"，onDone 不再等价于
// "清单空了"。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ResiduePanel } from "../../src/renderer/src/components/ResiduePanel.js";
import type { ResidueItem } from "../../src/shared/residue.js";

function seed(otter: Record<string, unknown>) {
  vi.stubGlobal("window", Object.assign(window, { otter }));
}

const items: ResidueItem[] = [
  {
    detector: "process_groups",
    id: "111",
    label: "npm run dev",
    confidence: "owned",
    cleanupHint: "kill 进程组 111",
  },
  {
    detector: "simulators",
    id: "udid-1",
    label: "iPhone 15 (iOS 18)",
    confidence: "suspected",
    cleanupHint: "simctl shutdown udid-1",
  },
  {
    detector: "ports",
    id: "port:9999",
    label: "python3:9999",
    confidence: "suspected",
    cleanupHint: "仅展示，不提供清理",
  },
];

afterEach(cleanup);

describe("ResiduePanel（残留清单弹窗，issue #759）", () => {
  it("空 items 不渲染", () => {
    seed({});
    const { container } = render(
      <ResiduePanel sessionId="s1" items={[]} open onDone={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("open=false 不渲染（即使 items 非空，review finding 2：解耦弹窗可见性与清单真相）", () => {
    seed({});
    const { container } = render(
      <ResiduePanel sessionId="s1" items={items} open={false} onDone={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("owned 默认勾选、suspected 默认不勾、仅展示行没有 checkbox", () => {
    seed({});
    render(<ResiduePanel sessionId="s1" items={items} open onDone={() => {}} />);

    expect(screen.getByLabelText("npm run dev")).toBeChecked();
    expect(screen.getByLabelText("iPhone 15 (iOS 18)")).not.toBeChecked();
    // 仅展示的端口行没有 checkbox 可查
    expect(screen.queryByLabelText("python3:9999")).not.toBeInTheDocument();
    // 但行本身、cleanupHint 灰字、badge 都还在
    expect(screen.getByText("python3:9999")).toBeInTheDocument();
    expect(screen.getByText("仅展示，不提供清理")).toBeInTheDocument();
    expect(screen.getAllByText("可能是你自己开的")).toHaveLength(2); // 模拟器 + 端口两条 suspected
  });

  it("按 detector 分组显示（进程组 / 模拟器 / 端口）", () => {
    seed({});
    render(<ResiduePanel sessionId="s1" items={items} open onDone={() => {}} />);
    expect(screen.getByText("进程组")).toBeInTheDocument();
    expect(screen.getByText("模拟器")).toBeInTheDocument();
    expect(screen.getByText("端口")).toBeInTheDocument();
  });

  it("清理选中：全部 ok/带 note → 划掉行 + 调用 onDone", async () => {
    const residueClean = vi.fn(async () => [
      { id: "111", ok: true },
    ]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(
      <ResiduePanel
        sessionId="s1"
        items={[items[0]!]}
        open
        onDone={onDone}
      />
    );

    await userEvent.click(screen.getByText("清理选中 (1)"));
    await waitFor(() => expect(residueClean).toHaveBeenCalledWith("s1", ["111"]));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("kind:failed（信号发了、进程还活着）：留在原地，红字提示，不调用 onDone", async () => {
    const residueClean = vi.fn(async () => [
      { id: "111", ok: false, kind: "failed" as const, note: "已发送终止信号，进程组仍存活" },
    ]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(
      <ResiduePanel
        sessionId="s1"
        items={[items[0]!]}
        open
        onDone={onDone}
      />
    );

    await userEvent.click(screen.getByText("清理选中 (1)"));
    await waitFor(() => expect(residueClean).toHaveBeenCalled());
    // 红字优先显示实现给的那句人话，没有 note 才回落成「清理失败」
    expect(await screen.findByText("已发送终止信号，进程组仍存活")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    // 行还在、没被划掉——checkbox 还看得见
    expect(screen.getByLabelText("npm run dev")).toBeInTheDocument();
  });

  it("kind:gone（本来就不在了）：视为完成，调用 onDone", async () => {
    const residueClean = vi.fn(async () => [
      { id: "111", ok: false, kind: "gone" as const, note: "已消失" },
    ]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(
      <ResiduePanel
        sessionId="s1"
        items={[items[0]!]}
        open
        onDone={onDone}
      />
    );

    await userEvent.click(screen.getByText("清理选中 (1)"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  // 向后兼容那条分支（residueSettled 的 `kind === undefined` 早退）。现有实现
  // 的每条 return 都带 kind（residueLocal.cleanup），所以这个形状只可能来自
  // 旧日志重放——重放老日志不该突然多出一批清不掉的僵尸条目，按已清对待。
  // 钉住它是因为它是唯一一处「ok:false 却算了结」的入口，改错了不会有别的测试红
  it("无 kind（旧日志形状）：按已清对待，调用 onDone", async () => {
    const residueClean = vi.fn(async () => [{ id: "111", ok: false }]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(<ResiduePanel sessionId="s1" items={[items[0]!]} open onDone={onDone} />);

    await userEvent.click(screen.getByText("清理选中 (1)"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByText("清理失败")).not.toBeInTheDocument();
  });

  it("「以后再说」直接调用 onDone，不发 residueClean，且不清 items（组件自己没有清单真相）", async () => {
    const residueClean = vi.fn();
    seed({ residueClean });
    const onDone = vi.fn();
    const { rerender } = render(
      <ResiduePanel sessionId="s1" items={items} open onDone={onDone} />
    );

    await userEvent.click(screen.getByText("以后再说"));
    expect(onDone).toHaveBeenCalled();
    expect(residueClean).not.toHaveBeenCalled();

    // onDone 只是"该关弹窗了"的信号——挂载方决定要不要真的把 open 翻成 false；
    // items 数组本身在这个组件眼里完全没变，重渲成 open=false 才会真的收起来
    rerender(<ResiduePanel sessionId="s1" items={items} open={false} onDone={onDone} />);
    expect(screen.queryByText("npm run dev")).not.toBeInTheDocument();
  });

  it("父组件把清理掉的一项从 items 里摘掉后，未处理的另一项仍然显示（review finding 2：部分清理不吞未处理项）", () => {
    seed({});
    const { rerender } = render(
      <ResiduePanel sessionId="s1" items={items} open onDone={() => {}} />
    );
    expect(screen.getByLabelText("npm run dev")).toBeInTheDocument();
    expect(screen.getByLabelText("iPhone 15 (iOS 18)")).toBeInTheDocument();

    // 模拟 store 收到 111 的 residue_cleaned 后重新传入的 items（真实数据流：
    // applyResidueEvent 按 detector:id 精确摘除，见 store.test 那份单测）
    rerender(
      <ResiduePanel sessionId="s1" items={items.slice(1)} open onDone={() => {}} />
    );
    expect(screen.queryByLabelText("npm run dev")).not.toBeInTheDocument();
    // 没被清理的模拟器那条、纯展示的端口那条都还在——不是"关一次弹窗就全没了"
    expect(screen.getByLabelText("iPhone 15 (iOS 18)")).toBeInTheDocument();
    expect(screen.getByText("python3:9999")).toBeInTheDocument();
  });

  it("kind:'skipped'（仅展示那档）也算了结，不留红字", async () => {
    const residueClean = vi.fn(async () => [
      { id: "111", ok: false, kind: "skipped" as const, note: "仅展示，不提供清理" },
    ]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(<ResiduePanel sessionId="s1" items={[items[0]!]} open onDone={onDone} />);
    await userEvent.click(screen.getByText("清理选中 (1)"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("一成功一失败：只要有一条 failed 就不调 onDone（弹窗留着给用户看红字）", async () => {
    const residueClean = vi.fn(async () => [
      { id: "111", ok: true, kind: "cleaned" as const },
      { id: "udid-1", ok: false, kind: "failed" as const, note: "关不掉" },
    ]);
    seed({ residueClean });
    const onDone = vi.fn();
    render(<ResiduePanel sessionId="s1" items={items} open onDone={onDone} />);
    // suspected 的模拟器默认不勾，手动勾上凑成两条一起清
    await userEvent.click(screen.getByLabelText("iPhone 15 (iOS 18)"));
    await userEvent.click(screen.getByText("清理选中 (2)"));
    await waitFor(() => expect(residueClean).toHaveBeenCalled());
    expect(await screen.findByText("关不掉")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});

// issue #759 review I2：live 路径上挂载方是**先挂组件后来数据**的，
// "owned 默认勾选"那份 useState 惰性初值算的是空集，之后再也不重算——
// 于是用户看到一屏空 checkbox 和一个禁用的清理按钮。挂载方改成条件挂载
// （App.tsx `{liveResidue.length > 0 && ...}`），组件内再加一条 effect
// 兜住"分两批到达"。这一组钉的是后者。
describe("owned 默认勾选：items 后到 / 分批到时也要成立（review I2）", () => {
  const owned = (id: string): ResidueItem => ({
    detector: "process_groups", id, label: id, confidence: "owned", cleanupHint: `kill 进程组 ${id}`,
  });

  it("挂载时 items 为空、之后才灌进来——新到的 owned 条目自动勾上", async () => {
    seed({});
    const { rerender } = render(<ResiduePanel sessionId="s1" items={[]} open onDone={() => {}} />);
    rerender(<ResiduePanel sessionId="s1" items={[owned("111")]} open onDone={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("111")).toBeChecked());
    expect(screen.getByText("清理选中 (1)")).toBeEnabled();
  });

  it("分两批到达：第二批的 owned 也并进 checked，第一批的不受影响", async () => {
    seed({});
    const { rerender } = render(
      <ResiduePanel sessionId="s1" items={[owned("111")]} open onDone={() => {}} />
    );
    rerender(
      <ResiduePanel sessionId="s1" items={[owned("111"), owned("222")]} open onDone={() => {}} />
    );
    await waitFor(() => expect(screen.getByLabelText("222")).toBeChecked());
    expect(screen.getByLabelText("111")).toBeChecked();
    expect(screen.getByText("清理选中 (2)")).toBeInTheDocument();
  });

  it("用户手动取消掉的那条，不会被后续重渲勾回去（seeded 记住已经判过的 id）", async () => {
    seed({});
    const { rerender } = render(
      <ResiduePanel sessionId="s1" items={[owned("111")]} open onDone={() => {}} />
    );
    await userEvent.click(screen.getByLabelText("111")); // 取消勾选
    expect(screen.getByLabelText("111")).not.toBeChecked();
    // 新一批到达（111 还在里面）——它已经在 seeded 里，不该被重新勾上
    rerender(
      <ResiduePanel sessionId="s1" items={[owned("111"), owned("222")]} open onDone={() => {}} />
    );
    await waitFor(() => expect(screen.getByLabelText("222")).toBeChecked());
    expect(screen.getByLabelText("111")).not.toBeChecked();
  });

  it("后到的 suspected 不会被自动勾上（默认不动用户自己留着的东西）", async () => {
    seed({});
    const { rerender } = render(<ResiduePanel sessionId="s1" items={[]} open onDone={() => {}} />);
    rerender(<ResiduePanel sessionId="s1" items={items} open onDone={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("npm run dev")).toBeChecked());
    expect(screen.getByLabelText("iPhone 15 (iOS 18)")).not.toBeChecked();
  });
});
