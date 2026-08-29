// 「连接器」栏目（设置页；内部 id 仍是 mcp，见 settingsShell.tsx 与 ADR-0178）——
// 页面上半是可浏览的连接器目录（McpDirectory，ADR-0171），下半是本机 server 清单。
// 下半是 SubagentSettings 的写法兄弟：清单是"看
// ~/.mr-otto/mcp.json 里配了什么、连没连上"，用户在这里增删改 + 手动重连失败的那台。
// 在此之前，配置这份文件唯一的办法是手改 JSON——这个栏目替掉那条路。
//
// 与 Subagent 栏目最大的不同：这里的凭据(env/headers)过桥前已经遮罩过
// (`sk-31cf5*****828c`)，表单必须防住"没碰这个字段、原样存回去把真凭据
// 覆盖成星号"这个坑。做法是让输入框直接拿遮罩值预填：用户不碰它，交回去的
// 还是那串星号，主进程的 mergeMaskedCreds 认得出"这跟磁盘上这把 key 的遮罩
// 形态一样"，原样保留真值；用户一旦改了哪怕一个字符，交回去的就不再等于
// 那串遮罩，主进程认定这是新值，原样存下。整条防线建在"不碰 = 原样往返"
// 这条街上，组件不需要、也不能自己判断"这一格里现在是遮罩还是真值"
// （真值从来不过桥，组件压根看不到）。
//
// "挂载一次定终身"的诚实告知放在栏目顶部——这不是 bug，是这个功能的设计边界：
// 已经在跑的会话装配时读过一次工具清单，改配置/删 server 不会让它中途长出
// 或掉线工具，下一次新开会话才会用上新配置（main/agent.ts 顶部注释里的原话）。

import { useEffect, useState } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { McpDirectory } from "./McpDirectory.js";
import { useChat } from "../store.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import {
  blankRow,
  hasStrayMaskedValue,
  mcpConfigsEqual,
  mcpDisplayStatus,
  mcpServerIdError,
  recordFromRows,
  restoredValueOnKeyUndo,
  rowsFromRecord,
  shouldClearValueOnKeyRename,
  splitArgs,
  type KeyValueRow,
  type McpDisplayStatus,
} from "../lib/mcpForm.js";
import type { McpServerConfig, McpServerStatus } from "../../../shared/mcp.js";

const ERR_TXT = "text-err text-[13px]";

export function McpSettings() {
  const snapshot = useChat((s) => s.mcpServers);
  const refreshMcp = useChat((s) => s.refreshMcp);
  const [newOpen, setNewOpen] = useState(false);
  // 目录页里开着某个连接器的详情页 —— 那是一整屏，这一页的其余部分让位（#745）
  const [onConnectorPage, setOnConnectorPage] = useState(false);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="mcp" className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="size-3.5" />
          新建
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        {!onConnectorPage && snapshot.errors.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-err/30 bg-err/[0.06] px-[14px] py-3">
            <span className="flex items-center gap-[6px] text-[12.5px] font-medium text-err">
              <TriangleAlert className="size-[13px]" />
              mcp.json 有 {snapshot.errors.length} 处解析不动
            </span>
            {snapshot.errors.map((e) => (
              <p key={e} className="font-mono text-[12px] leading-[1.5] text-err/90">
                {e}
              </p>
            ))}
          </div>
        )}

        {/* 目录页本身就是最好的空状态：一屏可点的连接器，比一句"还没配置任何
            连接器"有用得多——原来那个空状态块因此删掉了 */}
        {/* 整页就这一个东西了（issue #753）：已装的那几台在最上面（「已接通」/
            「待接通」），下面是还没装的目录。同一套卡片语言，点进去是同一张
            详情页——管理面也在那儿。
            下半那份等宽 id + 裸 URL + 「0 资源 · 0 prompt」的清单已经删掉：
            同一种东西不该在一页上长成两副样子，而后者说的是协议的方言 */}
        <McpDirectory servers={snapshot.servers} onPageChange={setOnConnectorPage} />
      </section>
      <NewMcpServerDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        existingIds={snapshot.servers.map((s) => s.id)}
      />
    </div>
  );
}

type NewKind = "stdio" | "http";

function NewMcpServerDialog({
  open,
  onOpenChange,
  existingIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
}) {
  const saveMcpServer = useChat((s) => s.saveMcpServer);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<NewKind>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开都是新鲜的草稿——同 NewSubagentDialog 的做法
  useEffect(() => {
    if (open) {
      setId("");
      setKind("stdio");
      setCommand("");
      setUrl("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmedId = id.trim();
    const idErr = mcpServerIdError(trimmedId, existingIds);
    if (idErr) {
      setError(idErr);
      return;
    }
    const trimmedCommand = command.trim();
    const trimmedUrl = url.trim();
    if (kind === "stdio" && trimmedCommand === "") {
      setError("先填命令，例如 npx");
      return;
    }
    if (kind === "http" && trimmedUrl === "") {
      setError("先填 URL");
      return;
    }
    const cfg: McpServerConfig =
      kind === "stdio"
        ? { kind: "stdio", command: trimmedCommand, args: [], env: {}, enabled: true }
        : { kind: "http", url: trimmedUrl, headers: {}, enabled: true };
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer(trimmedId, cfg);
      onOpenChange(false);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>手动添加连接器</DialogTitle>
          <DialogDescription>
            目录里没有的那种。先起个名字、选连接方式、填最基本的一项；
            其余（参数 / 环境变量 / 请求头）建好之后点开它自己那张卡再填。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-[6px]">
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">名字</label>
            <Input
              autoFocus
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如 github"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">连接方式</label>
            <div
              role="radiogroup"
              aria-label="连接方式"
              className="inline-flex w-fit gap-1 rounded-[10px] border border-border bg-card p-1"
            >
              {(["stdio", "http"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  className={cn(
                    "press-scale rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors duration-150",
                    kind === k
                      ? "bg-foreground/[0.10] font-[550] text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setKind(k)}
                >
                  {k === "stdio" ? "本地命令" : "HTTP"}
                </button>
              ))}
            </div>
          </div>
          {kind === "stdio" ? (
            <div className="flex flex-col gap-[6px]">
              <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">命令</label>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如 npx"
                className="font-mono text-[12.5px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-[6px]">
              <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">URL</label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="font-mono text-[12.5px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          )}
          {error && <p className={ERR_TXT}>{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建并连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
