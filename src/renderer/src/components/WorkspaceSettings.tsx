// 设置页「工作区」栏目(#559):解释工作区是什么(第一次用 AI 智能体的人没有
// "项目文件夹"概念) + 默认工作文件夹的查看/更换/恢复内置。
//
// 语义:会话永远有工作区——新会话没选文件夹时用这里的默认值兜底。
// 内置 Default 落在文档区 Mr Otto/Default(惰性创建,见 main/workspaceSettingsStore.ts),
// 新手在 Finder/资源管理器里找得到自己的产出。

import { useEffect } from "react";
import { Button } from "@/components/ui/button.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { useChat } from "../store.js";

/** 路径最后一段。Windows 的反斜杠也认——这个值是给人看的名字,不参与任何路径运算 */
export const workspaceName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function WorkspaceSettings() {
  const settings = useChat((s) => s.workspaceSettings);
  const loadWorkspaceSettings = useChat((s) => s.loadWorkspaceSettings);
  const setDefaultWorkspace = useChat((s) => s.setDefaultWorkspace);
  const pickWorkspace = useChat((s) => s.pickWorkspace);

  useEffect(() => {
    void loadWorkspaceSettings();
  }, [loadWorkspaceSettings]);

  const change = async () => {
    const dir = await pickWorkspace();
    if (dir) await setDefaultWorkspace(dir); // 取消 = 保持原选择
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="workspace" className="flex-1" />
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          工作区就是水獭干活的文件夹：它读的文件、写的文件都在这个文件夹里，
          不会碰你电脑上的其它地方。每个会话开始时都会挑一个工作区——
          做不同的项目就挑不同的文件夹，互不打扰。
        </p>
        <div className="flex flex-col gap-3 rounded-[10px] border border-border px-[14px] py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">默认工作文件夹</span>
            <span className={HINT}>新会话没选文件夹时，就用这里兜底——不选也能直接开聊。</span>
          </div>
          {settings ? (
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                <span className="text-[13px] inline-flex items-center gap-2 min-w-0">
                  <span className="shrink-0">{workspaceName(settings.defaultWorkspace)}</span>
                  {settings.builtin && (
                    <span className="text-muted-foreground text-[11px] rounded-full border border-border px-[8px] py-[1px] shrink-0">
                      内置
                    </span>
                  )}
                </span>
                {/* rtl 省略头部留尾部:路径的尾巴才认得出(同 WorkspacePicker) */}
                <span
                  className="text-muted-foreground text-[11px] min-w-0 truncate [direction:rtl] text-left"
                  title={settings.defaultWorkspace}
                >
                  {settings.defaultWorkspace}
                </span>
                {settings.builtin && (
                  <span className={HINT}>
                    水獭做出来的东西会放在「文档 › Mr Otto › Default」里，随时打开文件夹就能看到。
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => void change()}>
                  更换…
                </Button>
                {!settings.builtin && (
                  <Button variant="ghost" size="sm" onClick={() => void setDefaultWorkspace(null)}>
                    恢复内置
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <span className={HINT}>读取中…</span>
          )}
        </div>
      </section>
    </div>
  );
}
