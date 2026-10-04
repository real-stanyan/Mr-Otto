// 聊天页收口（#1566）+ 智能体侧页（#1574）在手机端的接线。判据在 shared（wechatInbox.test 的 splitInbox / isHidden / agentFolderSummary、
// agentActivityRows.test 的 workspaceAgentWhere / agentStatusText）真跑，这里读源码钉住：
// ① 主页只画 split.main、搜索时不分家；智能体在从左缘滑出来的侧页里（左上角钮 / 边缘右划），不再有顶上那一格与路由；
// ② 每一行（主页 / 智能体页 / 别人的智能体抽屉）都裹着 SwipeRow，删 = hideChat（只藏这台手机上的一行）；
// ③ 左滑删掉的那份进 inboxRows 的 hidden、读出来之前不藏；
// ④ 智能体页每行带状态（workspaceAgentWhere + agentStatusText），别人的智能体默认收着。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("聊天页主页", () => {
  const src = read("mobile/src/tabs/ChatsScreen.tsx");
  it("只画人与群；搜索时整份过滤（搜到的智能体行不被文件夹藏住）", () => {
    expect(src).toMatch(/const split = useMemo\(\(\) => splitInbox\(inbox\.rows\), \[inbox\.rows\]\);/);
    expect(src).toMatch(/searching \? filterInbox\(inbox\.rows, q\) : split\.main/);
  });
  it("侧页（#1574）：左上角钮 + 左缘右划打开；点侧页里的一行先收再推；顶上那一格与 AgentChats 路由都没了", () => {
    expect(src).toMatch(/<SidePanel visible=\{panel\} title="智能体" onClose=\{\(\) => setPanel\(false\)\} onExited=\{onPanelExited\}>/);
    expect(src).toMatch(/<AgentPanel onPick=\{\(route\) => \{ panelPick\.current = route; setPanel\(false\); \}\} \/>/);
    expect(src).toMatch(/\.hitSlop\(\{ left: 0, width: SIDE_PANEL_EDGE \}\)\s*\.activeOffsetX\(12\)\s*\.failOffsetY\(\[-10, 10\]\)/);
    expect(src).toMatch(/agentFolderSummary\(split\.agents, split\.others\)/); // 钮上的角标
    expect(src).not.toMatch(/AgentFolderRow|navigate\("AgentChats"\)/);
    expect(read("mobile/src/nav/types.ts")).not.toMatch(/AgentChats/);
    expect(read("mobile/src/nav/RootNavigator.tsx")).not.toMatch(/AgentChats/);
  });
  it("每一行裹着 SwipeRow，删 = hideChat(key, ts)", () => {
    expect(src).toMatch(/<SwipeRow onDelete=\{\(\) => hideChat\(item\.key, item\.ts\)\}>\s*<ChatListRow/);
  });
});

describe("智能体侧页的内容", () => {
  const src = read("mobile/src/inbox/AgentPanel.tsx");
  it("不自己推页：点一行交给 onPick（Modal 盖着时推的页看不见）", () => {
    expect(src).toMatch(/export function AgentPanel\(\{ onPick \}/);
    expect(src).not.toMatch(/navigation\.navigate/);
  });
  it("SidePanel：往左拽过四分之一或一甩才关；关的手势只认横向", () => {
    const panel = read("mobile/src/wx/SidePanel.tsx");
    expect(panel).toMatch(/\.activeOffsetX\(\[-12, 999\]\)\s*\.failOffsetY\(\[-10, 10\]\)/);
    expect(panel).toMatch(/e\.velocityX < -DISMISS_VELOCITY \|\| landing > panelW \* DISMISS_DISTANCE/);
  });
  it("每一只一行、带状态：跨会话取最要紧那条（workspaceAgentWhere）+ agentStatusText（群名从主页那几行查）", () => {
    expect(src).toMatch(/const where = workspaceAgentWhere\(activity\.rows, ws\.id, a\.agentId, now\);/);
    expect(src).toMatch(/const status = agentStatusText\(where, groupTitle\);/);
    expect(src).toMatch(/r\.target\.kind !== "friend" && r\.target\.kind !== "agent"\) m\.set\(r\.target\.sessionId, r\.title\)/);
  });
  it("聊过的行与别人的智能体都能左滑删；别人的智能体是一格默认收着的抽屉", () => {
    expect(src.match(/<SwipeRow onDelete=\{\(\) => hideChat\(/g)?.length).toBe(2);
    expect(src).toMatch(/<Fold id="agents-others" label="别人的智能体" count=\{split\.others\.length\} defaultClosed>/);
  });
});

describe("左滑删掉的那份", () => {
  it("useInbox：读出来之前不藏；读出来了交给 inboxRows 的 hidden", () => {
    const src = read("mobile/src/inbox/useInbox.ts");
    expect(src).toMatch(/\.\.\.\(hidden === null \? \{\} : \{ hidden \}\)/);
  });
  it("hiddenStore：按账号分键、记的是删那一刻最近一句的时刻（没话的记此刻）", () => {
    const src = read("mobile/src/inbox/hiddenStore.ts");
    expect(src).toMatch(/`otto\.wx\.hidden\.\$\{uid\}`/);
    expect(src).toMatch(/next\.set\(key, ts > 0 \? ts : Date\.now\(\)\);/);
  });
  it("SwipeRow：划到头不自动删（overshootRight=false），点钮才删", () => {
    const src = read("mobile/src/wx/SwipeRow.tsx");
    expect(src).toMatch(/overshootRight=\{false\}/);
    expect(src).toMatch(/ref\.current\?\.close\(\);\s*onDelete\(\);/);
  });
});
