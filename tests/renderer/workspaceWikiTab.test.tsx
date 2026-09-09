// @vitest-environment jsdom
// tests/renderer/workspaceWikiTab.test.tsx —— 设置页「记忆」tab 是 wiki 视图（#1140）。
// 三态纪律同 workspaceSessionsTab.test.tsx：读不到 ≠ 一页都没有；absent（容器还没建）单独一句。
//
// 点击 InsetRow 行（记忆 tab 入口 / 索引里的「Acme」/「新建页」）走
// `getByRole("button", { name })` 不走 `getByText`：InsetRow 的可点击区域是
// 一枚绝对定位铺满整行的透明 `<button>`，与可见文字所在的 `<span>` 是**兄弟
// 节点不是祖先**（README 里那句「div 加一层铺满的透明按钮」）——真机上靠
// CSS 层叠（z-index:0 的定位元素盖在同层叠上下文里的普通流内容之上）吃下
// 整行点击，但 jsdom 不算布局/层叠，`userEvent.click` 只按实际 DOM 祖先链
// 冒泡，点在文字那个 span 上永远够不着按钮的 onClick（已用最小复现验证：
// 同样的 InsetRow 单独渲染，`getByText` 点击落空、`getByRole("button")`
// 点击命中）。断言意图不变——原文要点的是「这一行」，`getByRole` 只是换了
// 一种够得到同一个按钮的方式。纯文字断言（不点击的那些 findByText/getByText）
// 不受影响，原样保留。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { WorkspacePage } from "../../src/renderer/src/components/WorkspacePage.js";
import { useChat } from "../../src/renderer/src/store.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { CsWorkNode } from "../../src/shared/remote/cloudSession.js";
import type { FriendsResult } from "../../src/shared/friends.js";

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: ConfirmProvider });

// 推入式导航在 reduced-motion 下是同步的（不起 rAF、不等动画），断言不必去等帧——
// 同 workspaceSessionsTab.test.tsx 那条 beforeAll。没有它时 pop() 之后弹簧还没
// 落定，popped 那页仍占着 rendered 数组的最后一格，`pointer-events:auto` 因此
// 停在它身上而不是新的栈顶页，"编辑"/"Acme" 那几次 pop-了-再点 的用例会因为
// `pointer-events: none` 而点不动（真实复现过：user-event 直接抛错拒绝点击）
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
const WS: WorkspaceSnapshot = { id: "ws-1", name: "奶茶店", ownerUid: "u1", members: [{ uid: "u1", role: "owner", label: "小红", avatarUrl: "" }], connectors: [], sessions: [], agents: [], sandboxApproval: "ask" };
const INDEX = "# 索引\n\n## 常驻\n- [[team]] 团队口径 — 所有人都看得到\n\n## customers\n- [[customers/acme]] Acme — 华东最大客户\n";
const PAGE = "---\ntitle: Acme\nsummary: 华东最大客户\npinned: false\nupdated_by: 运营\nupdated_at: 2026-09-09T00:00:00Z\nsources: [s-1#12, /work/合同.pdf]\n---\n月结 60 天\n";
const file = (text: string): CsWorkNode => ({ kind: "file", text, truncated: false, size: text.length });

function stubStore(files: Record<string, CsWorkNode | { error: string }>, write: () => Promise<FriendsResult<null>> = async () => ({ ok: true, value: null })) {
  const writes: unknown[] = [];
  useChat.setState({
    workspaceFiles: async (_w: string, path: string) => {
      const n = files[path];
      if (!n) return { ok: false, message: "这一刻读不到工作文件夹。稍后再试。" };
      if ("error" in n) return { ok: false, message: n.error };
      return { ok: true, value: n };
    },
    workspaceWikiWrite: async (_w: string, req: unknown) => { writes.push(req); return write(); },
  } as never);
  return writes;
}
async function openTab() {
  render(<WorkspacePage ws={WS} selfUid="u1" onBack={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "记忆" }));
}
afterEach(() => cleanup());

describe("WorkspaceWikiTab", () => {
  it("有索引：按分组画行，标题 + 摘要；点一行推入页面渲染正文", async () => {
    stubStore({ "wiki/index.md": file(INDEX), "wiki/log.md": file(""), "wiki/customers/acme.md": file(PAGE) });
    await openTab();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("华东最大客户")).toBeInTheDocument();
    expect(screen.getByText("常驻")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Acme" }));
    expect(await screen.findByText("月结 60 天")).toBeInTheDocument();
  });
  it("读不到 → 说读不到并给重试；absent → 说容器还没建；空索引 → 说还没有页", async () => {
    stubStore({ "wiki/index.md": { error: "这一刻读不到工作文件夹。稍后再试。" } });
    await openTab();
    expect(await screen.findByText("这一刻读不到 wiki")).toBeInTheDocument();
    expect(screen.getByText("再试一次")).toBeInTheDocument();
    cleanup();
    stubStore({ "wiki/index.md": { kind: "absent" }, "wiki/log.md": { kind: "absent" } });
    await openTab();
    expect(await screen.findByText(/还没建起来/)).toBeInTheDocument();
    cleanup();
    stubStore({ "wiki/index.md": { kind: "missing" }, "wiki/log.md": { kind: "missing" } });
    await openTab();
    expect(await screen.findByText(/还没有页/)).toBeInTheDocument();
  });
  it("nudge 从 log.md 算出来画在顶部", async () => {
    const log = Array.from({ length: 20 }, (_, i) => `## [2026-09-09 13:${String(i).padStart(2, "0")}] write | p${i}.md | x | `).join("\n");
    stubStore({ "wiki/index.md": file(INDEX), "wiki/log.md": file(log) });
    await openTab();
    expect(await screen.findByText(/20 次/)).toBeInTheDocument();
  });
  it("编辑：表单预填页头与正文，保存发 wiki_write{op:write}；失败文案原样显示", async () => {
    let fail = false;
    const writes = stubStore({ "wiki/index.md": file(INDEX), "wiki/log.md": file(""), "wiki/customers/acme.md": file(PAGE) }, async () => (fail ? { ok: false as const, message: "常驻页合计 2300 字，超过预算 2200" } : { ok: true as const, value: null }));
    await openTab();
    await userEvent.click(await screen.findByRole("button", { name: "Acme" }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const body = await screen.findByLabelText("正文");
    expect(body).toHaveValue("月结 60 天\n");
    await userEvent.clear(body);
    await userEvent.type(body, "月结 30 天");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    // 整页替换：界面上没有编辑 sources 的地方，那就把页头原来那份原样带回去（#1140 终审 Important 4）
    expect(writes[0]).toEqual({ op: "write", path: "customers/acme.md", title: "Acme", summary: "华东最大客户", pinned: false, body: "月结 30 天", sources: ["s-1#12", "/work/合同.pdf"] });
    fail = true;
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/超过预算 2200/)).toBeInTheDocument();
  });
  it("新建页：路径不合法当场拦；合法发 write。删除走确认框后发 remove", async () => {
    const writes = stubStore({ "wiki/index.md": file(INDEX), "wiki/log.md": file(""), "wiki/customers/acme.md": file(PAGE) });
    await openTab();
    await userEvent.click(await screen.findByRole("button", { name: "新建页" }));
    await userEvent.type(await screen.findByLabelText("路径"), "Bad Path");
    await userEvent.type(screen.getByLabelText("标题"), "X");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/路径不合法/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    await userEvent.clear(screen.getByLabelText("路径"));
    await userEvent.type(screen.getByLabelText("路径"), "suppliers/tea.md");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ op: "write", path: "suppliers/tea.md", title: "X", summary: "", pinned: false, body: "" }); // 新建页没有「原来那份」，这一格不带
    await userEvent.click(await screen.findByRole("button", { name: "Acme" }));
    await userEvent.click(await screen.findByRole("button", { name: "删除" }));
    await userEvent.click(await screen.findByRole("button", { name: "删除这一页" })); // confirm 对话框的确认钮文案
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ op: "remove", path: "customers/acme.md" });
  });
});
