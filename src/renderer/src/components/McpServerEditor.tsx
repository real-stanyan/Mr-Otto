// 已装的那一台的管理面 —— 启用开关 / 改地址与参数 / 重连 / 授权 / 删除。
//
// 原来它是设置页下半那份清单里的一个 <details>：等宽的 id、裸 URL、
// 「20 工具 · 0 资源 · 0 prompt」。同一页上，同一种东西长成了两副样子，
// 而下半这副说的是协议的方言——用户因此问出「所以接通后的连接器就变成
// mcp 了？」（issue #753）。ADR-0178 定的是产品层叫连接器、协议层才叫 MCP，
// 那几个词根本不该出现在这一屏。
//
// 现在它住在连接器详情页里：卡片是索引，详情页是答案（#745 已经定的分工）。
// 这个文件是**原样搬过来的**，逻辑一行没动——搬家和改逻辑分开做，
// 出问题时才分得清是哪一半的锅。
import { useState } from "react";
import { RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/lib/utils.js";
import { HINT } from "../settingsShell.js";
import { useChat } from "../store.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import {
  blankRow,
  hasStrayMaskedValue,
  mcpConfigsEqual,
  mcpDisplayStatus,
  recordFromRows,
  restoredValueOnKeyUndo,
  rowsFromRecord,
  shouldClearValueOnKeyRename,
  splitArgs,
  type KeyValueRow,
} from "../lib/mcpForm.js";
import type { McpServerConfig, McpServerStatus } from "../../../shared/mcp.js";
import { humanizeMcpError } from "../lib/mcpInstalled.js";
import { DataTable } from "./elements/data-table.js";

const ERR_TXT = "text-err text-[13px]";

export function McpServerEditor({
  server,
  blocked,
}: {
  server: McpServerStatus;
  /** 目录里标着"已知接不上"的那几条，值是原因（CatalogEntry.blocked，ADR-0190）。
      有值时这一段不画授权按钮、也不画那条错误红字 —— 详情页上面那条横幅已经
      给出了更准确的答案，而这两样各说各的：
      红字说"凭据不对"会把用户支去检查 token，而那不是问题所在（issue #764）。
      #760 只挡住了上半张页面，同一个撒谎的形状在这份管理面里原样活着 */
  blocked: string | undefined;
}) {
  const saveMcpServer = useChat((s) => s.saveMcpServer);
  // mcp.json 跟着账号走（ADR-0187）：写死 ~/.mr-otto/mcp.json 的话，照着提示去手改
  // 的用户会编辑一个对本账号完全不生效的文件
  const configRoot = useChat((s) => s.configRoot);
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

  // 原来这个函数挂在 <details> 的 onToggle 上（收起就弃稿）。现在编辑器住在
  // 详情页里，"返回"会把整个组件卸载掉，草稿跟着没了——同一个语义，不用再显式
  // 调一次。留着 syncDraftFrom 是因为存成功之后还要用它拉回最新那份

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

  return (

      <div className="flex flex-col gap-4">
        {blocked === undefined && server.error && (display === "failed" || display === "needs-auth") && (
          // 原文留在 title 里：翻译是为了让用户知道该改什么，不是为了把证据藏起来
          <p className={ERR_TXT} title={server.error}>
            {humanizeMcpError(server.error)}
          </p>
        )}

        {blocked === undefined && display === "needs-auth" && cfg.kind === "http" && (
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
              <p className={HINT}>
                不支持引号里带空格这种 shell 语法——更复杂的命令行直接改{" "}
                {configRoot ? `${configRoot}/mcp.json` : "~/.mr-otto/mcp.json"}
              </p>
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

        {/* 工具清单在详情页上半已经列过了，这儿只补它另外带来的两样东西。
            标题用人话：`Prompt` 是协议词汇，按 ADR-0178 不该出现在这一屏 */}
        {server.resources.length > 0 && (
          <DataTable
            columns={["资源", "地址"]}
            rows={server.resources.map((r) => [r.name, r.uri])}
          />
        )}
        {server.prompts.length > 0 && (
          <DataTable
            columns={["现成的问法", "说明"]}
            rows={server.prompts.map((p) => [p.name, p.description ?? ""])}
          />
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
  );
}
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
