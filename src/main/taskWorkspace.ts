// src/main/taskWorkspace.ts
// 任务会话的工作区分配（#851）：内置 Default 下按会话分格。
// 只在「渲染层递来的正是当前兜底路径」时动手——别替任意路径 mkdir（#559 的旧规矩不变）。
// sessionId 在这里先铸出来再递给 createAgent（presetSessionId）：子目录名要用它，
// 而 createAgent 原本是在里面才铸 id 的。
import { sessionWorkspaceUnder } from "../shared/defaultWorkspace.js";

export interface WorkspaceInfoLike {
  defaultWorkspace: string;
  builtin: boolean;
  builtinWorkspace: string;
}

export interface AllocatedWorkspace {
  workspace: string;
  /** 分格了才有：子目录名 = 这个 id，建会话时必须用同一个 */
  sessionId: string | null;
}

export function allocateSessionWorkspace(
  requested: string,
  info: WorkspaceInfoLike,
  deps: { mint: () => string; mkdir: (abs: string) => void },
): AllocatedWorkspace {
  if (requested !== info.defaultWorkspace) return { workspace: requested, sessionId: null };
  if (!info.builtin) {
    // 用户自己的文件夹：往里塞哈希子目录是越界（spec §4）
    deps.mkdir(requested);
    return { workspace: requested, sessionId: null };
  }
  const sessionId = deps.mint();
  const workspace = sessionWorkspaceUnder(info.builtinWorkspace, sessionId);
  deps.mkdir(workspace);
  return { workspace, sessionId };
}
