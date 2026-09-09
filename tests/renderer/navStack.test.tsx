// @vitest-environment jsdom
//
// 推入式导航壳的行为（#1120）。弹簧那层的物理钉在 tests/renderer/spring.test.ts，
// 这里管的是**壳自己的规矩**：谁在屏幕上、返回按钮写什么、连点两下会不会叠两层、
// reduced-motion 下是不是真的不动。
//
// 全程把 `prefers-reduced-motion` 打成 reduce：这条路是**同步**的（不起 rAF、
// 不等动画），所以断言不必去等帧；顺带它本身就是一条要守的行为——退化成瞬切，
// 不是「快一点」。动画那条路的正确性由 spring.test.ts 与真机承担，jsdom 没有布局
// （`clientWidth` 恒为 0），在这儿断言 transform 只会钉住一个假的 0。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NavStack, useNav, type NavScreen } from "../../src/renderer/src/components/ui/nav-stack.js";

/** 默认全程 reduce（同步路径）；动画那一组自己翻成 false */
let reducedMotion = true;

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

afterEach(() => { cleanup(); reducedMotion = true; });

const detail: NavScreen = {
  key: "detail",
  title: "智能体",
  backLabel: "工作区",
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
    expect(screen.queryByRole("button", { name: /返回|工作区/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("推一页：新页的内容在屏幕上，返回按钮写的是**上一页叫什么**", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    expect(screen.getByText("三只水獭")).toBeInTheDocument();
    // 「返回」两个字对每一页都成立，等于没说；backLabel 是这一格的全部价值
    expect(screen.getByRole("button", { name: "工作区" })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.queryByText("三只水獭")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进去" })).toBeInTheDocument();
  });

  it("同一个键推两次 = 同一页：连点两下不叠两层", () => {
    render(<NavStack root={root} />);
    const go = screen.getByRole("button", { name: "进去" });
    fireEvent.click(go);
    // 第二次点在被压住的那一页上（真机上点不到），直接再调一次 push 模拟竞态
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
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

// ── 动画那条路 ──
//
// 上面那一组全程 reduce，走的是同步分支；真机上跑的是这一条，而它在 #1120 合进来时
// 一条断言都没有——于是 rAF 循环持有的是**推入之前**那一版 `applyLayout`（闭包捕获
// 了当时的 `rendered`），刚推上来的那一页在整段动画里一次都没被布局过，停在画外，
// 表现成「第一次点没反应，点第二行才把第一页放出来」。
//
// jsdom 没有布局，所以这里把 `clientWidth` 钉成 420（抽屉的真实宽度）+ 自己驱动
// rAF：判据因此是**这一页此刻被摆在哪**，不是「调了哪个函数」。
describe("NavStack 动画路径", () => {
  let frames: FrameRequestCallback[] = [];
  let widthSpy: PropertyDescriptor | undefined;
  let clock = 0;

  beforeEach(() => {
    reducedMotion = false;
    frames = [];
    clock = 1000;
    // `tick` 的 dt 取自 `performance.now()`：真跑时它每帧走 16ms，而同步循环里它
    // 几乎不动（差值是个极小的非零数，`|| 1/60` 那条兜底轮不到），弹簧于是原地踏步。
    // 自己推这只表，一帧就是一帧
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 420 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (widthSpy) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthSpy);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  /** 把攒着的帧跑完（弹簧 response 0.42s，60fps 下 ~26 帧收敛，留足余量） */
  const runFrames = (max = 200): void => {
    act(() => {
      for (let i = 0; i < max && frames.length > 0; i++) {
        clock += 16;
        frames.shift()!(clock);
      }
    });
  };

  const detailPage = (): HTMLElement => screen.getByText("三只水獭").closest("section")!;
  // 根页有两处同名文字（大标题 + 导航条那行），取 heading 那个
  const rootPage = (): HTMLElement =>
    screen.getByRole("heading", { name: "mandy's bubble tea" }).closest("section")!;

  it("推一页：动画跑完后新页落在正位——rAF 里布局的必须是**此刻**的栈", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    runFrames();
    expect(detailPage().style.transform).toBe("translate3d(0px,0,0)");
  });

  it("动画期间根页不再接指针事件——每帧都被设回 auto 的话，人还在对着一张看不见的页点", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    runFrames(3);
    expect(rootPage().style.pointerEvents).toBe("none");
  });

  it("返回：退场跑完后那一页从树上摘掉", () => {
    render(<NavStack root={root} />);
    fireEvent.click(screen.getByRole("button", { name: "进去" }));
    runFrames();
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    runFrames();
    expect(screen.queryByText("三只水獭")).not.toBeInTheDocument();
    expect(rootPage().style.pointerEvents).toBe("auto");
  });
});
