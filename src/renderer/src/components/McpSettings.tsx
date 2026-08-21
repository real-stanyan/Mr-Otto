// MCP 栏目（设置页）——SubagentSettings 的写法兄弟：本机 server 清单是"看
// ~/.otter/mcp.json 里配了什么、连没连上"，用户在这里增删改 + 手动重连失败的那台。
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
import type { SyntheticEvent } from "react";
import { Plus, RotateCw, Trash2, TriangleAlert } from "lucide-react";
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
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { useChat } from "../store.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import {
  blankRow,
  mcpConfigsEqual,
  mcpDisplayStatus,
  mcpServerIdError,
  recordFromRows,
  rowsFromRecord,
  splitArgs,
  type KeyValueRow,
  type McpDisplayStatus,
} from "../lib/mcpForm.js";
import type { McpServerConfig, McpServerStatus } from "../../../shared/mcp.js";
import { SpecSheet, type SpecRow } from "./elements/spec-sheet.js";
import { DataTable } from "./elements/data-table.js";

const ERR_TXT = "text-err text-[13px]";

const STATUS_LABEL: Record<McpDisplayStatus, string> = {
  connected: "已连接",
  connecting: "连接中",
  "needs-auth": "需要授权",
  failed: "连接失败",
  disabled: "已关闭",
};

// disabled 用和 connecting 一样中性的点——它不是故障，红灯只留给 failed 那一种
// 真正"连不上"的状态（见 mcpForm.ts 里 mcpDisplayStatus 的注释）
const STATUS_DOT: Record<McpDisplayStatus, string> = {
  connected: "bg-ok",
  connecting: "bg-muted-foreground/50 animate-pulse",
  "needs-auth": "bg-warn",
  failed: "bg-err",
  disabled: "bg-muted-foreground/30",
};

function StatusBadge({ status }: { status: McpDisplayStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[5px] text-[11.5px] text-muted-foreground">
      <span className={cn("size-[6px] rounded-full", STATUS_DOT[status])} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function McpSettings() {
  const snapshot = useChat((s) => s.mcpServers);
  const refreshMcp = useChat((s) => s.refreshMcp);
  const closeSettings = useChat((s) => s.closeSettings);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px] flex-1">MCP</span>
        <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="size-3.5" />
          新建
        </Button>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          每个 server 是 <code>~/.otter/mcp.json</code> 里 <code>mcpServers</code> 下的一条记录，
          带来工具、资源、prompt 三种能力。<strong className="font-medium text-foreground/80">
          增删或改配置只在下一次新开的会话里生效</strong>——正在进行的会话装配那一刻就已经定好了
          用哪些工具，之后不会被这里的改动打断，也不会中途补上新连上的 server。
        </p>

        {snapshot.errors.length > 0 && (
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

        {snapshot.servers.length === 0 && snapshot.errors.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border px-[18px] py-8 text-center">
            <p className="text-[13px] text-foreground">还没配置任何 MCP server</p>
            <p className={cn(HINT, "max-w-[420px]")}>
              点右上角「新建」起一台，或者手写一份 <code>~/.otter/mcp.json</code>
              （格式与 Claude Code 的 <code>.mcp.json</code> 兼容，能直接粘过来）。
            </p>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
        )}

        {snapshot.servers.map((server) => (
          <McpServerRow key={server.id} server={server} />
        ))}
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
          <DialogTitle>新建 MCP server</DialogTitle>
          <DialogDescription>
            先起个名字、选传输方式、填最基本的一项；参数/环境变量/请求头建好之后在列表里展开填。
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
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">传输</label>
            <div
              role="radiogroup"
              aria-label="传输方式"
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

function McpServerRow({ server }: { server: McpServerStatus }) {
  const saveMcpServer = useChat((s) => s.saveMcpServer);
  const removeMcpServer = useChat((s) => s.removeMcpServer);
  const reconnectMcpServer = useChat((s) => s.reconnectMcpServer);

  const cfg = server.config;

  const [enabled, setEnabled] = useState(cfg.enabled);
  const [command, setCommand] = useState(cfg.kind === "stdio" ? cfg.command : "");
  const [argsText, setArgsText] = useState(cfg.kind === "stdio" ? cfg.args.join(" ") : "");
  const [url, setUrl] = useState(cfg.kind === "http" ? cfg.url : "");
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(() =>
    rowsFromRecord(cfg.kind === "stdio" ? cfg.env : {})
  );
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(() =>
    rowsFromRecord(cfg.kind === "http" ? cfg.headers : {})
  );

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const resetDraft = () => {
    setEnabled(cfg.enabled);
    setCommand(cfg.kind === "stdio" ? cfg.command : "");
    setArgsText(cfg.kind === "stdio" ? cfg.args.join(" ") : "");
    setUrl(cfg.kind === "http" ? cfg.url : "");
    setEnvRows(rowsFromRecord(cfg.kind === "stdio" ? cfg.env : {}));
    setHeaderRows(rowsFromRecord(cfg.kind === "http" ? cfg.headers : {}));
    setSaveError(null);
  };

  // 草稿始终沿用打开时的 kind——stdio↔http 字段集完全不同，中途切换等于
  // 建一台新 server，那应该走"删掉重建"，不是这份编辑表单该管的事
  const draftConfig: McpServerConfig =
    cfg.kind === "stdio"
      ? {
          kind: "stdio",
          command: command.trim(),
          args: splitArgs(argsText),
          env: recordFromRows(envRows),
          enabled,
        }
      : { kind: "http", url: url.trim(), headers: recordFromRows(headerRows), enabled };

  const dirty = !mcpConfigsEqual(cfg, draftConfig);
  const invalid =
    draftConfig.kind === "stdio" ? draftConfig.command === "" : draftConfig.url === "";

  const display = mcpDisplayStatus(cfg, server.status);
  const hasCapabilities = server.tools.length + server.resources.length + server.prompts.length > 0;

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveMcpServer(server.id, draftConfig);
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除「${server.id}」？下一次新开的会话就不会再挂载它。`)) return;
    setRemoving(true);
    setSaveError(null);
    try {
      await removeMcpServer(server.id);
      // 成功之后这一行会随 mcpServers 整份刷新而从列表里消失，不用自己复位 removing
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
      setRemoving(false);
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    setSaveError(null);
    try {
      await reconnectMcpServer(server.id);
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setReconnecting(false);
    }
  };

  const capabilityRows: SpecRow[] = [
    { label: "传输", value: cfg.kind === "stdio" ? "本地命令" : "HTTP" },
    { label: "工具", value: String(server.tools.length), emphasis: server.tools.length > 0 },
    { label: "资源", value: String(server.resources.length) },
    { label: "Prompt", value: String(server.prompts.length) },
  ];

  return (
    <details
      className="rounded-[10px] border border-border"
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => {
        // 收起时把没保存的改动扔掉——同 SubagentSettings：草稿只活在展开期间，
        // 再打开是从最新快照重新开始，不是"上次编辑到一半的样子"
        if (!e.currentTarget.open) resetDraft();
      }}
    >
      <summary className="flex list-none cursor-pointer items-baseline gap-[10px] px-[14px] py-3 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 truncate font-mono text-[13px] font-semibold text-brand max-w-[160px]">
          {server.id}
        </span>
        <StatusBadge status={display} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {cfg.kind === "stdio" ? cfg.command || "（没填命令）" : cfg.url || "（没填 URL）"}
        </span>
        {display === "connected" && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {server.tools.length} 工具 · {server.resources.length} 资源 · {server.prompts.length} prompt
          </span>
        )}
      </summary>

      <div className="flex flex-col gap-4 border-t border-border px-[14px] py-4">
        {server.error && (display === "failed" || display === "needs-auth") && (
          <p className={ERR_TXT}>{server.error}</p>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">启用</span>
            <p className={HINT}>关掉不会删配置，只是下一次新开的会话不再挂载它</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {cfg.kind === "stdio" ? (
          <>
            <div className="flex flex-col gap-[6px]">
              <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">命令</label>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如 npx"
                className="font-mono text-[12.5px]"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">参数</label>
              <Input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="空格分隔，例如 -y @modelcontextprotocol/server-filesystem /Users/x"
                className="font-mono text-[12.5px]"
              />
              <p className={HINT}>不支持引号里带空格这种 shell 语法——更复杂的命令行直接改 ~/.otter/mcp.json</p>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-[6px]">
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">URL</label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="font-mono text-[12.5px]"
            />
          </div>
        )}

        {cfg.kind === "stdio" ? (
          <KeyValueEditor label="环境变量" rows={envRows} setRows={setEnvRows} baseline={cfg.env} />
        ) : (
          <KeyValueEditor label="请求头" rows={headerRows} setRows={setHeaderRows} baseline={cfg.headers} />
        )}

        {hasCapabilities && (
          <div className="flex flex-col gap-3">
            <SpecSheet
              title="连上之后带来的能力"
              subtitle={server.id}
              rows={capabilityRows}
              visibleCount={capabilityRows.length}
              className="max-w-none"
            />
            {server.tools.length > 0 && (
              <DataTable columns={["工具", "说明"]} rows={server.tools.map((t) => [t.name, t.description])} />
            )}
            {server.resources.length > 0 && (
              <DataTable columns={["资源", "URI"]} rows={server.resources.map((r) => [r.name, r.uri])} />
            )}
            {server.prompts.length > 0 && (
              <DataTable
                columns={["Prompt", "说明"]}
                rows={server.prompts.map((p) => [p.name, p.description ?? ""])}
              />
            )}
          </div>
        )}

        {saveError && <p className={ERR_TXT}>{saveError}</p>}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || invalid || saving} onClick={() => void save()}>
            {saving ? "保存中…" : dirty ? "保存" : "已保存"}
          </Button>
          {display === "failed" && (
            <Button variant="outline" size="sm" disabled={reconnecting} onClick={() => void reconnect()}>
              <RotateCw className={cn("size-3.5", reconnecting && "animate-spin")} />
              {reconnecting ? "重连中…" : "重连"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={removing}
            className={cn(
              "ml-auto border-destructive/60 bg-transparent text-destructive",
              "hover:bg-destructive/10 hover:text-destructive dark:bg-transparent dark:hover:bg-destructive/10"
            )}
            onClick={() => void remove()}
          >
            <Trash2 className="size-3.5" />
            {removing ? "删除中…" : "删除"}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** env/headers 的行编辑器。值输入框直接拿遮罩值预填——这正是防止表单覆盖真
    凭据的机制本体（见文件顶部注释），不是巧合。baseline 是打开这一行时的
    原始（遮罩）配置，只用来给"没改过"的行加一个小标记，不参与提交内容 */
function KeyValueEditor({
  label,
  rows,
  setRows,
  baseline,
}: {
  label: string;
  rows: KeyValueRow[];
  setRows: (rows: KeyValueRow[]) => void;
  baseline: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{label}</label>
      {rows.length === 0 && <p className={HINT}>还没配置任何{label}</p>}
      <div className="flex flex-col gap-[6px]">
        {rows.map((row) => {
          // 键名没改、值也没改——才算"没碰过"。键名一改，值原来跟哪把凭据对应
          // 已经说不清了，不该继续标"未改"
          const unchanged = row.key !== "" && baseline[row.key] === row.value;
          return (
            <div key={row.rowId} className="flex items-center gap-[6px]">
              <Input
                value={row.key}
                onChange={(e) =>
                  setRows(rows.map((r) => (r.rowId === row.rowId ? { ...r, key: e.target.value } : r)))
                }
                placeholder="键名"
                className="w-[180px] shrink-0 font-mono text-[12.5px]"
              />
              <div className="flex min-w-0 flex-1 items-center gap-[6px]">
                <Input
                  value={row.value}
                  onChange={(e) =>
                    setRows(rows.map((r) => (r.rowId === row.rowId ? { ...r, value: e.target.value } : r)))
                  }
                  placeholder="值"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono text-[12.5px]"
                />
                {/* 显示的是已保存凭据的遮罩形态,不是明文——这一格能直接认出"贴的是哪把"，
                    改了哪怕一个字符这个标记就会消失，那正是"这行被当成新值了"的信号 */}
                {unchanged && (
                  <span className="shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground/70">未改</span>
                )}
              </div>
              <button
                type="button"
                className="press-scale shrink-0 p-1 text-muted-foreground hover:text-err"
                onClick={() => setRows(rows.filter((r) => r.rowId !== row.rowId))}
                aria-label="删除这一行"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="press-scale w-fit text-[12px] text-primary hover:underline"
        onClick={() => setRows([...rows, blankRow()])}
      >
        + 加一行
      </button>
    </div>
  );
}
