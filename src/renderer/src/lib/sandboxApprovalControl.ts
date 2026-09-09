// 「免审批」那颗开关在云会话输入框那一行长什么样（#1029，ADR-0243）。
//
// 判断留在纯函数里、组件只画：这颗开关一次说错话的代价是**人以为每条命令都会
// 弹卡给他看，而实际一条都不弹**，所以「此刻能不能翻」「显示的是不是真的」这两问
// 必须钉得住，而不是散在 JSX 的三元里。
//
// 它与本地会话那颗（BypassSwitch 的 BypassToggle）**位置一样、东西不一样**，四点差别：
//   ① 作用域：本地那颗管这一条会话，这颗管**整个团队**（所有会话、所有成员）——
//      隔离面是容器，而同一个团队的所有会话共用一个容器一个卷（ADR-0232），
//      做成按会话就跟 ADR-0231 否掉的「按 agent 配免审」一样挡不住任何东西。
//   ② 覆盖面：本地那颗管每一把 `requiresApproval` 的刀（含全部 MCP 工具），
//      这颗只管容器里的 `bash` / `write_file`；连接器与 `create_agent` 照旧要批。
//   ③ 谁能改：本地是自己，这颗只有 owner（RLS `ws_update_owner`）。
//   ④ 持久化：本地是内存态、新会话默认 ask；这颗落库、翻了就一直是那样。
// 标签原来因此钉死「沙箱内免审」、刻意与本地那颗不同名（ADR-0243）；2026-09-08
// 维护者对着真机拍板改回「免审批」——同名被接受，四点差别改由 title 与下文那几句
// 文案承担。同日维护者还定了一条：免审开着时输入框上方**不再常驻警示行**（ADR-0243
// 当初把它列为这笔账的缓解措施，见 `sandboxApprovalBanner`）。
//
// 三态而不是两态：`ws.sandboxApproval === null` 是「这一格读不到」（那一列走单独一条
// 容错查询，见 supabaseWorkspacesApi.fetchSandboxApproval）。兜底画成「关着」是最坏的
// 一种错——runtime 用 service key 走的是另一条查询、照旧按真值免批，于是界面说
// 「每条都会问你」而实际一条都不问，且没有任何提示。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** 药丸上那几个字。与本地那颗同名是**维护者 2026-09-08 拍板的**（ADR-0243 原先
    刻意不同名）；两颗管的东西不一样，差别在各自的 title 里说 */
export const SANDBOX_APPROVAL_LABEL = "免审批";

export type SandboxApprovalControl =
  /** owner：翻得动 */
  | { kind: "toggle"; on: boolean; title: string }
  /** 成员：看得到、改不了。危险状态对全群可见是故意的——它花的是 owner 的额度、
      动的是大家共用的那个卷，藏起来只会让「刚才为什么没弹卡」永远问不出答案 */
  | { kind: "readonly"; on: boolean; title: string; note: string }
  /** 这一格读不到：不画开关、也不假装它是关着的。owner 仍然给一条**只往严的一边**
      的出路（`canForceAsk`）——不知道现在是什么，也照样按得下「改成逐条批」；
      反方向按不得（不知道现状就打开免审，等于蒙着眼睛放行） */
  | { kind: "unknown"; title: string; canForceAsk: boolean };

const SCOPE = "整个团队都跟着变：这个团队里所有会话、所有成员。";
const COVERS = "只管智能体在自己容器里跑命令、写文件；连接器与新建智能体照旧要批。";
// 「关掉立刻生效」是 sessionService 那头的承诺：解析成 auto 的那一轮每次撞门现查一次，
// 所以踩刹车不用等下一轮。反方向要等——解析成 ask 之后这一轮就按 ask 走到底（ADR-0243）
const TIMING = "关掉立刻生效；打开要下一轮才一定生效。";

export function sandboxApprovalControl(ws: WorkspaceSnapshot, selfUid: string): SandboxApprovalControl {
  if (ws.sandboxApproval === null) {
    return {
      kind: "unknown",
      canForceAsk: ws.ownerUid === selfUid,
      title: `这个团队的「${SANDBOX_APPROVAL_LABEL}」此刻读不到，所以这里不画开关——画一个看起来关着的开关，而智能体那头照旧按真值走，是比读不到更糟的一件事。${COVERS}`,
    };
  }
  const on = ws.sandboxApproval === "auto";
  if (ws.ownerUid !== selfUid) {
    return {
      kind: "readonly",
      on,
      note: "所有者可改",
      title: `${SCOPE}${COVERS}只有团队所有者能改。`,
    };
  }
  return { kind: "toggle", on, title: `${SCOPE}${COVERS}${TIMING}` };
}

/** 输入框上方的那一行。**免审开着时不再出声**——ADR-0231 曾把那句话记成这笔账的
    缓解措施，2026-09-08 维护者对着真机撤了它（开着就是开着，药丸整枚染警示色
    已经说了）。唯一还会占这一行的是**读不到**：那一格恰恰可能正开着免审，闷着
    就是把一个「可能正危险」的状态藏进一枚灰药丸的 title 里（ADR-0243 决策 4
    否掉的那条路，这一条没被撤）。 */
export function sandboxApprovalBanner(c: SandboxApprovalControl): string | null {
  if (c.kind === "unknown") {
    return `读不到这个团队的「${SANDBOX_APPROVAL_LABEL}」：此刻说不准智能体跑命令、写文件会不会先问你。`;
  }
  return null;
}
