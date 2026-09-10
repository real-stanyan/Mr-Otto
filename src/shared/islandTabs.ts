// 灵动岛展开态顶栏那三档：任务 / 项目 / 团队（#1229）。
//
// 与侧栏那枚切换器同一套分法（ADR-0259）—— 同一批会话在两块屏幕上不该是两种
// 组织方式。但**「此刻在看哪一档」不上线**：那是 helper 进程的内存态，和
// `selectedSessionId` / `collapsedWorkspaces` 同一族（ADR-0063 已经为后两者
// 定过这个位置）。线上带的是「每一行归哪一档」，切档不用往返主进程。
//
// 这一层是纯函数：主进程 `flattenAgent` 每行调一次，Swift 侧照旧只做连续切段。
import { isDefaultWorkspace } from "./defaultWorkspace.js";

export type IslandTab = "task" | "project" | "team";

/** 云会话那条虚拟行的 workspace 前缀（`main/cloudSessionClient.ts` 的
    `cloudSessionFleetRow` 合成它）。**两处共用这一个常量**：一边合成、一边
    识别，各写一份字面量的话，改了合成那半而没改识别那半不会报错——只会让
    所有云会话安静地掉回「项目」档，还顶着一个 UUID 当组名。 */
export const CLOUD_WORKSPACE_PREFIX = "/__otto-cloud-session__/";

export interface IslandRowClass {
  kind: IslandTab;
  /** 组头写什么。`null` = 这一档不分组（任务档就是平铺：那些会话各自住在
      `<Default>/<sessionId>/` 里，按目录分组等于每行一个组头） */
  groupLabel: string | null;
}

export interface ClassifyInput {
  workspace: string | null;
  /** `workspaceLens` 解出的项目根（worktree 已折回主仓，ADR-0157） */
  projectRoot: string | null;
  /** 内置 Default 工作区的根；拿不到 = 没有任务档可言 */
  builtinDefault: string | null;
  /** 这条云会话所属团队的显示名；查不到 = 缺席。显式写出 `undefined` 是因为
      `exactOptionalPropertyTypes` 开着，而调用方拿到的就是一个可能是 undefined
      的查询结果——逼它先判一次不会让任何人更安全，只会多一处 `...(x ? {} : {})` */
  teamName?: string | null | undefined;
}

/** 路径末段。`shared/` 不 import `node:path`（架构断言），且渲染层也要用 */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * 一行归哪一档、组头写什么。
 *
 * 判断顺序是要紧的：**云会话先判**。它的 `workspace` 是一串合成路径，
 * `workspaceLens` 顺着它向上找不到 `.git`、会回落成「就地当根」，于是
 * `projectRoot` 等于那串字符串本身——放到后面判就成了一个组名是 UUID 的
 * 「项目」。
 *
 * 团队名查不到时**不回落成那串 UUID**，写「团队」：一个人读不懂的 32 位十六进制
 * 当组头，比一个笼统但读得懂的词更糟（同 ADR-0254「认不出的型号不画厂商标」的
 * 方向——宁可少说，不要说一个看起来像答案的噪声）。
 */
export function classifyIslandRow(input: ClassifyInput): IslandRowClass {
  const { workspace, projectRoot, builtinDefault, teamName } = input;

  if (workspace !== null && workspace.startsWith(CLOUD_WORKSPACE_PREFIX)) {
    return { kind: "team", groupLabel: teamName?.trim() || "团队" };
  }

  // 任务会话：等于 Default 根（旧形状）或父目录是它（ADR-0206 之后的子目录形状）
  if (isDefaultWorkspace(workspace, builtinDefault)) {
    return { kind: "task", groupLabel: null };
  }

  const root = projectRoot ?? workspace;
  return { kind: "project", groupLabel: root === null ? null : basename(root) };
}
