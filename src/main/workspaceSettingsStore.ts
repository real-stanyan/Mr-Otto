// 默认工作文件夹的落点:userData/workspace.json(同 islandSettingsStore.ts 的落法——
// app 级、跨会话的东西)。现读不缓存:设置页改了不用重启。
//
// defaultWorkspace: null = 用内置 Default(文档区 Mr Otto/Default,惰性创建——
// 只在真被用作会话工作区那一刻 mkdir,老手永远不会在文档区看到它);
// 字符串 = 用户在设置页选的文件夹。会话兜底语义见 #559:没选工作区就用这个,
// 会话永远有工作区,新手零决策也能开聊。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorkspaceSettings {
  defaultWorkspace: string | null;
}

/** 把任意输入整形成合法 WorkspaceSettings。文件和 IPC 传来的都是外部输入,不赌形状 */
export function normaliseWorkspaceSettings(input: unknown): WorkspaceSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const raw = obj["defaultWorkspace"];
  const defaultWorkspace = typeof raw === "string" && raw.trim() !== "" ? raw : null;
  return { defaultWorkspace };
}

export function loadWorkspaceSettings(path: string): WorkspaceSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseWorkspaceSettings(parsed);
  } catch {
    return { defaultWorkspace: null }; // 没有文件 / 坏 JSON = 用内置 Default
  }
}

export function saveWorkspaceSettings(path: string, settings: WorkspaceSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normaliseWorkspaceSettings(settings), null, 2), "utf8");
}

/** 内置 Default 工作区:文档区下的 Mr Otto/Default。documentsDir 由调用方传
    (app.getPath("documents")),macOS(~/Documents)/Windows(C:\Users\…\Documents)
    的差异 Electron 已经抹平——新手在 Finder/资源管理器里都找得到自己的产出 */
export function builtinDefaultWorkspace(documentsDir: string): string {
  return join(documentsDir, "Mr Otto", "Default");
}

/** 会话兜底用的默认工作区:设置过就用设置的,没设置用内置 Default */
export function resolveDefaultWorkspace(documentsDir: string, settings: WorkspaceSettings): string {
  return settings.defaultWorkspace ?? builtinDefaultWorkspace(documentsDir);
}
