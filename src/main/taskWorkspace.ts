// src/main/taskWorkspace.ts
// 任务会话的工作区分配（#851）：内置 Default 下按会话分格。
// 只在「渲染层递来的正是当前兜底路径」时动手——别替任意路径 mkdir（#559 的旧规矩不变）。
// sessionId 在这里先铸出来再递给 createAgent（presetSessionId）：子目录名要用它，
// 而 createAgent 原本是在里面才铸 id 的。
import { sessionWorkspaceUnder } from "../shared/defaultWorkspace.js";
import type { SessionCreatedEvent } from "../session/events.js";

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

/** resume 时这条会话的工作区落在哪（#1223，spec §3.6「Default 路径每台机器自己算」）。
    default 种：日志里那个目录本机存在就用它；不存在（另一台 Mac 建的）或压根没记（云端建的）
    就按 sessionId 派生 <内置 Default>/<sessionId> 并建目录——文件夹名就是 sessionId（ADR-0206），
    任何一台 Mac 都算得出同一处。项目会话一切照旧：有路径用路径，没路径 null（调用方拒绝恢复） */
export function resolveResumeWorkspace(
  first: SessionCreatedEvent,
  sessionId: string,
  deps: { builtin: string; exists: (abs: string) => boolean; mkdir: (abs: string) => void },
): string | null {
  if (first.workspaceKind !== "default") return first.workspace ?? null;
  if (first.workspace && deps.exists(first.workspace)) return first.workspace;
  const derived = sessionWorkspaceUnder(deps.builtin, sessionId);
  deps.mkdir(derived);
  return derived;
}
