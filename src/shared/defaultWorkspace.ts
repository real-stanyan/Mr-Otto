// 任务会话与内置 Default 的关系（#851，spec §4）——纯函数，主进程与渲染层共用一份。
//
// 为什么判据是「父目录 = Default 根」而不是「等于 Default 根」：#851 之后每个任务
// 会话拿自己的子文件夹 <Default>/<sessionId>/，而旧日志里的会话 workspace 直接就是
// Default 根——两种形状都得算任务会话，不然升级后旧任务全部跳到「项目」栏。
// 为什么不用 path 模块：src/shared 不 import node:*（架构测试），且渲染层也要用。

/** 末尾分隔符先剥，再取父目录；没有父目录（根 / 空串）回 null */
export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

/** 这个 workspace 是不是任务会话的工作区：等于 Default 根（旧形状）或父目录是它（新形状） */
export function isDefaultWorkspace(workspace: string | null, builtin: string | null): boolean {
  if (!workspace || !builtin) return false;
  if (workspace === builtin) return true;
  return parentDir(workspace) === builtin;
}

/** 分隔符跟 builtin 走：路径来自 Electron 的 app.getPath，Windows 上是反斜杠 */
export function sessionWorkspaceUnder(builtin: string, sessionId: string): string {
  const sep = builtin.includes("\\") && !builtin.includes("/") ? "\\" : "/";
  return `${builtin.replace(/[\\/]+$/, "")}${sep}${sessionId}`;
}

/** sessionId 的形状（src/main/agent.ts newSessionId）：清理空文件夹只认这个 */
export const SESSION_FOLDER_RE = /^s-\d{14}-[0-9a-f]{8}$/;

export function isSessionFolderName(name: string): boolean {
  return SESSION_FOLDER_RE.test(name);
}
