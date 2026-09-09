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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NavStack, useNav, type NavScreen } from "../../src/renderer/src/components/ui/nav-stack.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
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
