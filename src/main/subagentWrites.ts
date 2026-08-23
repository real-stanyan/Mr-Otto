// 子智能体的两个写盘动作（保存 / 新建）——从 index.ts 的 IPC handler 里抽出来的纯函数。
//
// 抽出来的理由是可测（issue #146）：这两条是**会往用户磁盘写文件**的路径，出错的
// 代价是用户的文件而不是一次报错，而它们原来长在 `createWindow` 的闭包里，任何测试
// 都拿不到——`trustedWorkspaceForWrite` / `subagentSlotTaken` 各自有单测，三个调用点
// 却是零覆盖。依赖全部注入（同 trustedWorkspace 抽出来时的做法），测试里给假的就行。
//
// 不变量都在这儿，别搬回 handler 里：
// ① 落地地址只认信任侧现扫的清单，不认渲染层传来的 def.path / def.readOnly；
// ② 作用域一起参与查找 —— 同名可以工作区和用户级各一份，不带作用域查会写穿；
// ③ 行内前置词有上限，理由同工作区文档那条（它原样进 subagent_briefed 的快照，
//    而那条快照投影出来的 user 消息永不被压缩）。

import { CONTEXT_DOC_LIMIT } from "./subagentPrompt.js";
import type { SubagentRoot } from "./subagents.js";
import { DEFAULT_SUBAGENT_TOOLS, subagentNameError, type SubagentDef } from "../shared/subagent.js";

export interface SubagentWriteDeps {
  /** 信任侧的清单：现扫磁盘 + 内置，合并后的那一份 */
  listSubagents: (workspace: string | null) => SubagentDef[];
  /** 写路径的工作区校验：认不出就抛（降级 = 把文件静默写到用户级去） */
  trustedForWrite: (workspace: unknown) => string | null;
  /** 该作用域下可写的根，第 0 个是落点 */
  roots: (workspace: string | null) => SubagentRoot[];
  slotTaken: (root: SubagentRoot, name: string) => boolean;
  write: (def: SubagentDef) => void;
  /** 新建时的路径拼接（注入是为了让测试不依赖 node:path 的平台差异） */
  join: (dir: string, file: string) => string;
}

/** 保存一份已有的定义。返回保存后的清单（渲染层直接拿去换掉手上那份） */
export function saveSubagentDef(
  deps: SubagentWriteDeps,
  def: SubagentDef,
  workspace: unknown
): SubagentDef[] {
  const ws = deps.trustedForWrite(workspace);
  if (def.preamble.mode === "custom" && def.preamble.text.length > CONTEXT_DOC_LIMIT) {
    throw new Error(`前置词太长了（上限 ${Math.floor(CONTEXT_DOC_LIMIT / 1024)} KB）`);
  }
  const found = deps.listSubagents(ws).find((d) => d.name === def.name);
  if (!found) throw new Error(`没有名叫「${def.name}」的子智能体`);
  if (found.readOnly) throw new Error(`${found.name} 是只读的（来自 ${found.source}），不能保存`);
  deps.write({
    ...def,
    path: found.path,
    source: found.source,
    readOnly: found.readOnly,
    scope: found.scope,
  });
  return deps.listSubagents(ws);
}

/** 新建一份空定义。返回新建后的清单 */
export function createSubagentDef(
  deps: SubagentWriteDeps,
  name: string,
  workspace: unknown
): SubagentDef[] {
  const ws = deps.trustedForWrite(workspace);
  const clean = name.trim();
  const nameError = subagentNameError(clean);
  if (nameError) throw new Error(nameError);
  // 建在选中作用域**可写**的那条根里：工作区级 = <工作区>/.mr-otto/agents，
  // 用户级 = ~/.mr-otto/agents。.claude/agents 是只读的，永远不是落点
  const root = deps.roots(ws)[0];
  if (!root) throw new Error("没有可写的子智能体目录");
  // 查重只问"落点这一层占了没"，不问"这个名字在合并清单里露过面没"。
  // 后者会把覆盖规则整个锁死：用户级有个 reviewer、想在工作区建一份同名的盖住它，
  // 正是覆盖这个特性的用法，不是重名事故（详见 subagentSlotTaken 的注释）
  if (deps.slotTaken(root, clean)) {
    throw new Error(`已经有一个叫「${clean}」的子智能体了，换个名字`);
  }
  deps.write({
    name: clean,
    description: "",
    instructions: "",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    unknownTools: [],
    approval: "deny",
    preamble: { mode: "default" },
    context: [],
    scope: root.scope,
    path: deps.join(root.root, `${clean}.md`),
    source: root.root,
    readOnly: false,
  });
  return deps.listSubagents(ws);
}
