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
  const [newOpen, setNewOpen] = useState(false);

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

        {/* 目录页本身就是最好的空状态：一屏可点的连接器，比一句"还没配置任何
            MCP server"有用得多——原来那个空状态块因此删掉了 */}
        <McpDirectory installedIds={snapshot.servers.map((s) => s.id)} />

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
  const authorizeMcpServer = useChat((s) => s.authorizeMcpServer);

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
  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // resetDraft(打开态收起时)和"存成功之后"都要把草稿拉回某一份 config，
  // 但拉回的对象不一样：收起时用的是这一次渲染闭包里的 cfg（没有异步间隙，
  // 就是"当前"）；存成功之后不能用闭包里的 cfg——那是存之前的旧快照，
  // 存完之后 store 已经换成了新的遮罩（旧值被吃回真值/新值被新遮罩盖住），
  // 闭包里那份是过期的。syncDraftFrom 把"拿哪份 config 重置草稿"这件事
  // 参数化，两个调用点各传各的
  const syncDraftFrom = (c: McpServerConfig) => {
    setEnabled(c.enabled);
    setCommand(c.kind === "stdio" ? c.command : "");
    setArgsText(c.kind === "stdio" ? c.args.join(" ") : "");
    setUrl(c.kind === "http" ? c.url : "");
    setEnvRows(rowsFromRecord(c.kind === "stdio" ? c.env : {}));
    setHeaderRows(rowsFromRecord(c.kind === "http" ? c.headers : {}));
    setSaveError(null);
  };

  const resetDraft = () => syncDraftFrom(cfg);

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
  // Critical review finding 的兜底闸：改键名时 onChange 处理器已经会主动清空
  // 跟着的值（见下面 KeyValueEditor 的调用），这里是万一那道防线被绕过时的
  // 最后一道——草稿里只要还有一行"键名不在原配置里、值却是原配置某把凭据的
  // 遮罩"，一律挡住保存，不能让遮罩字符串有任何机会被当真凭据写盘
  const strayMasked =
    cfg.kind === "stdio"
      ? hasStrayMaskedValue(envRows, cfg.env)
      : hasStrayMaskedValue(headerRows, cfg.headers);
  const invalid =
    (draftConfig.kind === "stdio" ? draftConfig.command === "" : draftConfig.url === "") ||
    strayMasked;

  const display = mcpDisplayStatus(cfg, server.status);
  const hasCapabilities = server.tools.length + server.resources.length + server.prompts.length > 0;

  const save = async () => {
    // O3 review finding：dirty 原来只靠 Save 按钮的 disabled 属性挡，函数
    // 本身没有这条不变量——按钮确实是唯一的调用入口（没有 <form>/onSubmit/
    // onKeyDown），但把它写进函数比全靠一个 JSX 属性更经得起以后的改动
    if (!dirty || invalid) return;
    setSaving(true);
    setSaveError(null);
    // 上一次授权失败的残留一并清掉（#474）：save/remove/reconnect 都可能
    // 把这台修好，状态灯变绿了旁边还挂着「授权失败」是在撒谎
    setAuthError(null);
    try {
      await saveMcpServer(server.id, draftConfig);
      // 存成功后拿 store 里刚落地的那份重置草稿，不是这次渲染闭包里的旧
      // cfg——不然凭据字段换成新遮罩之后，草稿还停在存之前的样子，dirty
      // 立刻判真，"已保存"按钮会当场变回"保存"，像是没存成功，其实只是
      // 草稿没跟上（Important review finding）。三个写操作都回全量快照，
      // 这里用 getState() 现取，同 SubagentSettings 的 copyToOtterAgents
      // 用的是同一招：只信刚落地的那份，不信闭包里可能已经过期的旧值
      const fresh = useChat.getState().mcpServers.servers.find((s) => s.id === server.id);
      if (fresh) syncDraftFrom(fresh.config);
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
    setAuthError(null); // 同 save：别让旧的授权失败文案留在一台已删除/重建的 server 旁
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
    setAuthError(null); // 同 save：重连成功后旧的「授权失败」不该继续挂着
    try {
      await reconnectMcpServer(server.id);
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setReconnecting(false);
    }
  };

  // 跑一次 OAuth 授权：主进程开系统浏览器，用户点完同意后 mcpHub.authorize
  // 自动重连——这里只管按钮的三态(等待/成功/失败)和失败原因的显示。
  // 失败原因逐台显示而不是统一吞成"授权失败"：超时/用户拒绝/服务端报错
  // 是三件不同的事，混成一句话会让用户第二次点之前完全不知道该改什么
  const authorize = async () => {
    setAuthorizing(true);
    setAuthError(null);
    try {
      await authorizeMcpServer(server.id);
    } catch (e) {
      setAuthError(bridgeErrorMessage(e));
    } finally {
      setAuthorizing(false);
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

        {display === "needs-auth" && cfg.kind === "http" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={authorizing}
              className="mcp-authorize-btn"
              onClick={() => void authorize()}
            >
              {authorizing ? "等浏览器…" : "授权"}
            </Button>
            {authError && <p className={cn(ERR_TXT, "mcp-auth-error")}>{authError}</p>}
          </div>
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
              <p className={HINT}>不支持引号里带空格这种 shell 语法——更复杂的命令行直接改 ~/.mr-otto/mcp.json</p>
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
    凭据的机制本体（见文件顶部注释），不是巧合。
    baseline 是这一行此刻对应的**实时** server.config.env/headers——随
    onMcpChanged 推送更新，不是这一行展开那一刻冻结的快照（review 指出旧注释
    写错了这一点）。这份实时性是特意保留的：改键名要不要清空值、"未改"标记
    准不准，跟的都该是磁盘上此刻的真实凭据形状，而不是这一行刚展开时的旧照——
    两者在大多数时候是同一份，只有外部（比如手改 mcp.json）在这一行展开期间
    改动了同一台 server 时才会分岔，而这时候跟"此刻"走显然更安全 */
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
          // 改名清空之后：originalKey 存在（这行本来是从磁盘加载的）、键名已经
          // 跟 originalKey 不一样、值是空的——这三条一起才说明"是被改名清空的"，
          // 不是用户自己手动清空了一个从没改过名的字段
          const renamedAndCleared =
            row.originalKey !== null && row.key !== row.originalKey && row.value === "";
          // Critical review finding 的可见信号：万一 onChange 的清空没生效
          // （不该发生，但这里不赌它一定不发生），这一行会亮出来，而不是
          // 悄悄地把遮罩存出去。判据复用 hasStrayMaskedValue 本体（只传这一行），
          // 不在这里另写一份等价逻辑——两份判据一旦不小心分叉，"挡住保存"的闸
          // 和"告诉用户为什么"的提示就可能对不上号
          const stray = hasStrayMaskedValue([row], baseline);
          return (
            <div key={row.rowId} className="flex flex-col gap-1">
              <div className="flex items-center gap-[6px]">
                <Input
                  value={row.key}
                  onChange={(e) => {
                    const newKey = e.target.value;
                    setRows(
                      rows.map((r) => {
                        if (r.rowId !== row.rowId) return r;
                        // 先判"改名又改回来了"（M1 review finding）：键名回到
                        // originalKey、值还是空的（上一步改名清空剩下的，或者
                        // 用户自己删空的）——把原始遮罩找回来，不然这一行会
                        // 带着"键名没变过"的假象和一个空值滑向保存，把真凭据
                        // 覆盖成空字符串，而 renamedAndCleared/stray 两道警示
                        // 都不认这个状态（前者要求键名不等于 originalKey，
                        // 后者显式排除空值）
                        const restored = restoredValueOnKeyUndo(newKey, r.originalKey, r.value, baseline);
                        if (restored !== null) {
                          return { ...r, key: newKey, value: restored };
                        }
                        // 改键名这一刻：这一格的值如果还是旧键名对应的原始遮罩,
                        // 说明用户没碰过它——继续留着提交,会被 mergeMaskedCreds
                        // 按新键名去磁盘上找旧值,找不到就把这串星号原样当真凭据
                        // 写盘（Critical review finding）。这里主动清空,逼用户
                        // 重新填一遍真值，而不是让一个看不出变化的错误悄悄发生
                        const clear = shouldClearValueOnKeyRename(r.key, r.value, baseline);
                        return { ...r, key: newKey, value: clear ? "" : r.value };
                      })
                    );
                  }}
                  placeholder="键名"
                  className="w-[180px] shrink-0 font-mono text-[12.5px]"
                />
                <div className="flex min-w-0 flex-1 items-center gap-[6px]">
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      setRows(rows.map((r) => (r.rowId === row.rowId ? { ...r, value: e.target.value } : r)))
                    }
                    placeholder={renamedAndCleared ? "键名改了，请重新填值" : "值"}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(
                      "min-w-0 flex-1 font-mono text-[12.5px]",
                      (renamedAndCleared || stray) && "border-warn/60 focus-visible:border-warn"
                    )}
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
              {stray && (
                <p className="pl-[186px] text-[11px] text-warn">
                  这一行的值还是旧键名的遮罩形态，不是真凭据——请重新填值，否则无法保存
                </p>
              )}
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
