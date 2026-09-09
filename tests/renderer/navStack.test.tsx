// @vitest-environment jsdom
//
// 推入式导航壳的行为（#1120）。弹簧那层的物理钉在 tests/renderer/spring.test.ts，
// 这里管的是**壳自己的规矩**：谁在屏幕上、返回按钮写什么、连点两下会不会叠两层、
// reduced-motion 下是不是真的不动。
//
// 两组用例各看一条路：reduced-motion 那条是**同步**的（不起 rAF、不等动画），断言
// 不必等帧；动画那条（#1125 的回归）自己驱动 rAF + 一只假表，并把 `clientWidth`
// 钉成 420——jsdom 没有布局（`clientWidth` 恒为 0），不钉的话断言只会钉住一个
// 假的 0；不推表的话 `tick` 的 dt 几乎不动，弹簧原地踏步，用例会对着一个假的
// 「没动」全绿。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NavStack, useNav, type NavScreen } from "../../src/renderer/src/components/ui/nav-stack.js";

/** reduced-motion 开关：同步那组全程 true，动画那组在 beforeEach 里翻成 false */
let reducedMotion = true;

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

const detail: NavScreen = {
  key: "detail",
  title: "智能体",
  backLabel: "团队",
  largeTitle: { title: "智能体" },
  render: () => <p>三只水獭</p>,
};

function PushButton({ screen = detail }: { screen?: NavScreen }) {
  const nav = useNav();
  return <button onClick={() => nav.push(screen)}>进去</button>;
}

const root: NavScreen = {
  key: "root",
  title: "mandy's bubble tea",
  largeTitle: { title: "mandy's bubble tea", subtitle: "3 人" },
  leading: <button>关闭</button>,
  render: () => <PushButton />,
};

describe("NavStack", () => {
  it("根页画大标题与副标题，且没有返回按钮——根页没有上一页可回", () => {
    render(<NavStack root={root} />);
    expect(screen.getByRole("heading", { name: "mandy's bubble tea" })).toBeInTheDocument();
    expect(screen.getByText("3 人")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /返回|团队/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("推一页：新页的内容在屏幕上，返回按钮写的是**上一页叫什么**", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    expect(screen.getByText("三只水獭")).toBeInTheDocument();
    // 「返回」两个字对每一页都成立，等于没说；backLabel 是这一格的全部价值
    expect(screen.getByRole("button", { name: "团队" })).toBeInTheDocument();
  });

  it("根页留在树上（返回时它还带着原来的滚动位置），但不再接指针事件", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    const rootPage = screen.getByRole("heading", { name: "mandy's bubble tea" }).closest("section")!;
    expect(rootPage).toBeInTheDocument();
    expect(rootPage.style.pointerEvents).toBe("none");
  });

  it("返回：那一页从树上摘掉（reduced-motion 下是同步的，不留退场残影）", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    fireEvent.click(screen.getByRole("button", { name: "团队" }));
    expect(screen.queryByText("三只水獭")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进去" })).toBeInTheDocument();
  });

  it("同一个键推两次 = 同一页：连点两下不叠两层", () => {
    render(<NavStack root={root} />);
    const go = screen.getByRole("button", { name: "进去" });
    fireEvent.click(go);
    // 第二次点在被压住的那一页上（真机上点不到），直接再调一次 push 模拟竞态
    fireEvent.click(screen.getByRole("button", { name: "团队" }));
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    expect(screen.getAllByText("三只水獭")).toHaveLength(1);
  });

  it("没有大标题的页面，导航条那行标题**常驻**——否则那一页从头到尾没有名字", () => {
    const bare: NavScreen = { key: "bare", title: "编辑「运营」", render: () => <p>表单</p> };
    render(<NavStack root={bare} />);
    const title = screen.getByText("编辑「运营」");
    expect(title.style.opacity).toBe("1");
  });

  it("有大标题的页面，导航条那行一开始是透明的（滚上去才接手）", () => {
    render(<NavStack root={root} />);
    // 大标题与导航条那行同名，取导航条那个（带 truncate 的那层）
    const navTitle = document.querySelector<HTMLElement>(".pointer-events-none.absolute.left-1\\/2")!;
    expect(navTitle.style.opacity).toBe("0");
  });
});

// 动画路径（reduced-motion 关）。#1125 的回归：rAF 循环曾闭包抓着推入前那一版栈，
// 整段动画里新页一次都没被布局——真机上「点第二行才把第一页放出来」。
// rAF 自己驱动（攒回调、手动放帧），时间是一只假表（tick 的 dt 取 performance.now()，
// 同步循环里它几乎不动，不推表弹簧原地踏步、用例会对着假的「没动」全绿）；
// clientWidth 钉成 420（jsdom 恒 0，不钉的话 transform 全是假的 0）。
describe("动画路径", () => {
  let now = 0;
  let rafQueue: FrameRequestCallback[] = [];

  /** 放一帧：表往前推 16.7ms，跑掉攒下的全部 rAF 回调 */
  const frame = (): void => {
    now += 16.7;
    const cbs = rafQueue;
    rafQueue = [];
    act(() => { for (const cb of cbs) cb(now); });
  };

  /** 一直放到动画静止（弹簧收工后 tick 不再续帧）。封顶只是防死循环 */
  const settleFrames = (cap = 300): void => {
    for (let i = 0; i < cap && rafQueue.length > 0; i++) frame();
    expect(rafQueue).toHaveLength(0);
  };

  beforeEach(() => {
    reducedMotion = false;
    now = 0;
    rafQueue = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let nextId = 1;
    const pending = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      pending.set(id, cb);
      rafQueue.push(cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      const cb = pending.get(id);
      pending.delete(id);
      if (cb) rafQueue = rafQueue.filter((c) => c !== cb);
    });
    // jsdom 没有布局：给这层壳一个宽度，translate3d 的像素数才不是恒 0
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 420; } });
  });

  afterEach(() => {
    // 趁桩还在位先卸载：组件的卸载清理会调 cancelAnimationFrame，
    // 撤桩之后那次调用会打到 jsdom 真身上（没开 pretendToBeVisual 时它不存在）
    cleanup();
    reducedMotion = true;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // 交还 jsdom 原来的 clientWidth（定义在 Element.prototype 上，删了我们这层就露出来）
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("推入动画把新页从画外送到正位：rAF 循环读的是此刻的栈（#1125）", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    const detailPage = screen.getByText("三只水獭").closest("section")!;
    const rootPage = screen.getByRole("heading", { name: "mandy's bubble tea" }).closest("section")!;
    // 推入那一帧：新页先落在画外（进度 0），不能先闪一帧在正位上
    expect(detailPage.style.transform).toBe("translate3d(420px,0,0)");
    frame();
    // 动画真的在推它——旧实现的循环此刻还在用推入前那版栈，这一帧什么都不动
    expect(detailPage.style.transform).not.toBe("translate3d(420px,0,0)");
    settleFrames();
    expect(detailPage.style.transform).toBe("translate3d(0px,0,0)");
    expect(detailPage.style.pointerEvents).toBe("auto");
    expect(rootPage.style.pointerEvents).toBe("none");
  });

  it("返回动画：退场页跑完动画才从树上摘掉，期间根页还不接指针", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    settleFrames();
    fireEvent.click(screen.getByRole("button", { name: "团队" }));
    // 动画期间那一页还得在树上（退场残影），跑完才卸载；收完之前根页不接指针
    const rootPage = screen.getByRole("heading", { name: "mandy's bubble tea" }).closest("section")!;
    expect(screen.getByText("三只水獭")).toBeInTheDocument();
    expect(rootPage.style.pointerEvents).toBe("none");
    settleFrames();
    expect(screen.queryByText("三只水獭")).not.toBeInTheDocument();
    expect(rootPage.style.pointerEvents).toBe("auto");
  });
});
