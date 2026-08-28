// 连接器目录（MCP 设置页顶部）——"想接一台 server"这件事此前唯一的入口是
// 新建对话框：用户得先知道这台 server 叫什么、URL 是什么、命令怎么敲。这个
// 网格把"有哪些"变成可浏览的。
//
// 两层，分野在 lib/mcpDirectory.ts 里落地：
// - 首屏是仓内精选层（MCP_CATALOG），零网络、立刻出现。注册表当不了首屏——
//   它按字母序返回，第一条是 ac.inference.sh，没有任何排名信号。
// - 打了字才去查公开注册表，结果压在一条"未经核验"的分隔线下面。
//
// 图标只认打进包的本地资源键（CatalogEntry.icon），**永远不接远程 URL**：
// 注册表条目的 icons 由投稿者自由填写，让渲染进程去加载等于每翻一次目录就把
// 用户 IP 交给一批陌生服务器。没有本地图标的一律画首字母色块。
//
// 慢请求盖掉新结果这件事，只能在这一侧挡：searchMcpRegistry 走
// ipcRenderer.invoke，AbortSignal 过不了 IPC 这道桥（主进程侧只有一个 15 秒
// 超时），所以"取消"是不存在的——能做的是给每次查询编号，回来的结果对不上
// 当前编号就丢掉。打了 notion 又立刻改成 linear，notion 的响应后到也进不来。

import { useEffect, useRef, useState } from "react";
import { Check, Plus, Search, ShieldCheck } from "lucide-react";
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
import { HINT } from "../settingsShell.js";
import { useChat } from "../store.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import {
  buildDirectory,
  configFromEntry,
  directoryTint,
  installPackageName,
  installSourceLabel,
  needsInstallConfirm,
  uniqueServerId,
  type DirectoryItem,
} from "../lib/mcpDirectory.js";
import { searchCatalog, type CatalogEntry } from "../../../shared/mcpCatalog.js";

// eager:true 只把**地址**收进来（?url），不是把 SVG 内容打进包里（同 FileTypeIcon）
const ICON_URLS = import.meta.glob<string>("../assets/mcp/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

function iconUrl(icon: string | undefined): string | undefined {
  return icon === undefined ? undefined : ICON_URLS[`../assets/mcp/${icon}.svg`];
}

const DEBOUNCE_MS = 250;

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const GRID = "grid gap-2 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]";

export function McpDirectory({ installedIds }: { installedIds: string[] }) {
  const searchMcpRegistry = useChat((s) => s.searchMcpRegistry);
  const saveMcpServer = useChat((s) => s.saveMcpServer);
  const authorizeMcpServer = useChat((s) => s.authorizeMcpServer);

  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<CatalogEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<DirectoryItem | null>(null);
  const [filling, setFilling] = useState<DirectoryItem | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // 每次查询的编号。回来的结果对不上此刻的编号 = 它属于一个已经被顶掉的
  // 查询，丢掉（见文件顶部注释：IPC 那头没有取消这回事，只能在这里判）
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const mine = seq.current + 1;
    seq.current = mine;
    if (q === "") {
      // 空查询不打网（主进程侧也拦了一道），首屏就该是精选层
      setRegistry([]);
      setRegistryError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = await searchMcpRegistry(q);
          if (seq.current !== mine) return;
          setRegistry(out);
          setRegistryError(null);
        } catch (e) {
          if (seq.current !== mine) return;
          // 搜不动 ≠ 没有结果：吞成空列表会让用户以为这台 server 不存在
          setRegistry([]);
          setRegistryError(bridgeErrorMessage(e));
        } finally {
          if (seq.current === mine) setSearching(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchMcpRegistry]);

  const { curated, longTail } = buildDirectory({
    query,
    curated: searchCatalog(query),
    registry,
    installedIds,
  });

  const install = async (item: DirectoryItem, values: Record<string, string>) => {
    const entry = item.entry;
    // 撞名就补后缀（uniqueServerId 内部复用 mcpServerIdError 那把尺子）——
    // 目录页装第二台同名 server 不该弹一个"已经有一台叫…"让用户自己改名
    const id = uniqueServerId(entry.id, installedIds);
    setInstalling(entry.id);
    setInstallError(null);
    try {
      await saveMcpServer(id, configFromEntry(entry, values));
    } catch (e) {
      setInstallError(bridgeErrorMessage(e));
      setInstalling(null);
      return;
    }
    if (entry.transport === "http") {
      // 授权失败不等于装失败：配置已经落盘了，下面那张卡片上还能再点一次
      // 「授权」。把它报成"装不上"是撒谎
      try {
        await authorizeMcpServer(id);
      } catch (e) {
        setInstallError(`「${id}」已装上，但授权没跑通：${bridgeErrorMessage(e)}`);
      }
    }
    setInstalling(null);
  };

  const start = (item: DirectoryItem) => {
    setInstallError(null);
    if (needsInstallConfirm(item)) {
      setConfirming(item);
      return;
    }
    if (item.entry.params.length > 0) {
      setFilling(item);
      return;
    }
    void install(item, {});
  };

  // 确认卡点了同意之后：该填参数的接着填，不然直接装
  const afterConfirm = (item: DirectoryItem) => {
    setConfirming(null);
    if (item.entry.params.length > 0) {
      setFilling(item);
      return;
    }
    void install(item, {});
  };

  const searched = query.trim() !== "";

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-[10px] size-[14px] -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索连接器"
          aria-label="搜索连接器"
          className="pl-8"
        />
      </div>

      {installError && <p className="text-[13px] text-err">{installError}</p>}

      {curated.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className={SECTION_LABEL}>精选</span>
          <div className={GRID}>
            {curated.map((item) => (
              <DirectoryCard
                key={item.entry.id}
                item={item}
                busy={installing === item.entry.id}
                onAdd={() => start(item)}
              />
            ))}
          </div>
        </div>
      )}

      {searched && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-[10px]">
            <span className={cn(SECTION_LABEL, "shrink-0 normal-case tracking-normal")}>
              以下来自公开注册表，未经核验
            </span>
            <span className="h-px flex-1 bg-border" aria-hidden />
          </div>
          {registryError ? (
            <p className="text-[13px] text-err">注册表搜不动：{registryError}</p>
          ) : searching ? (
            <p className={HINT}>搜索中…</p>
          ) : longTail.length === 0 ? (
            <p className={HINT}>注册表里没有匹配的 server</p>
          ) : (
            <div className={GRID}>
              {longTail.map((item) => (
                <DirectoryCard
                  key={item.entry.id}
                  item={item}
                  busy={installing === item.entry.id}
                  onAdd={() => start(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <InstallConfirmDialog
        item={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={afterConfirm}
      />
      <ParamsDialog
        item={filling}
        onCancel={() => setFilling(null)}
        onSubmit={(item, values) => {
          setFilling(null);
          void install(item, values);
        }}
      />
    </div>
  );
}

function EntryIcon({ entry }: { entry: CatalogEntry }) {
  const src = iconUrl(entry.icon);
  if (src !== undefined) {
    return (
      <img
        src={src}
        // 图标是名字的复述，名字就在旁边——给它 alt 只会让读屏器念两遍
        alt=""
        aria-hidden
        draggable={false}
        className="size-8 shrink-0 select-none rounded-[8px]"
      />
    );
  }
  // 没有本地图标就画首字母色块。颜色由 id 定死（directoryTint），同一条目
  // 每次都是同一个颜色，色块才有"认出来"的价值
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[8px] text-[13px] font-semibold",
        directoryTint(entry.id)
      )}
    >
      {entry.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function DirectoryCard({
  item,
  busy,
  onAdd,
}: {
  item: DirectoryItem;
  busy: boolean;
  onAdd: () => void;
}) {
  const { entry, verified, installed } = item;
  return (
    <div className="flex items-center gap-[10px] rounded-[10px] border border-border bg-card px-3 py-[10px]">
      <EntryIcon entry={entry} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-[6px]">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{entry.name}</span>
          {verified && (
            <span className="inline-flex shrink-0 items-center gap-[3px] text-[10.5px] text-muted-foreground">
              <ShieldCheck className="size-[11px]" aria-hidden />
              已核验
            </span>
          )}
        </div>
        <p className="truncate text-[12px] text-muted-foreground" title={entry.description}>
          {entry.description}
        </p>
      </div>
      {installed ? (
        // 已装的不可点：增删改在下面那份列表里（McpServerRow），这里再放一条
        // 编辑路径等于两个地方管同一台 server
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center text-ok"
          title="已经装上了"
        >
          <Check className="size-4" aria-hidden />
          <span className="sr-only">{entry.name} 已经装上了</span>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          aria-label={`添加 ${entry.name}`}
          className={cn(
            "press-scale inline-flex size-6 shrink-0 items-center justify-center rounded-[7px]",
            "text-muted-foreground transition-colors duration-150",
            "hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
          )}
          onClick={onAdd}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** 未经核验的 stdio 装之前的那道确认。文案要说清"会发生什么"——
    "从 npm 下载并在你的电脑上运行"，不是"是否添加这台 server" */
function InstallConfirmDialog({
  item,
  onCancel,
  onConfirm,
}: {
  item: DirectoryItem | null;
  onCancel: () => void;
  onConfirm: (item: DirectoryItem) => void;
}) {
  const entry = item?.entry;
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>装上「{entry?.name ?? ""}」？</DialogTitle>
          <DialogDescription>
            {entry &&
              `这会从 ${installSourceLabel(entry)} 下载 ${installPackageName(entry)} 并在你的电脑上运行它。这台 server 来自公开注册表，未经核验。`}
          </DialogDescription>
        </DialogHeader>
        {entry && (
          <pre className="overflow-x-auto rounded-[8px] border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
            {[entry.command ?? "", ...(entry.args ?? [])].join(" ").trim()}
          </pre>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => item && onConfirm(item)}>知道了，装上</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 带参数的条目：一格一个 param。值代进 url / args 的占位符（configFromEntry），
    代不进去的落 env / headers */
function ParamsDialog({
  item,
  onCancel,
  onSubmit,
}: {
  item: DirectoryItem | null;
  onCancel: () => void;
  onSubmit: (item: DirectoryItem, values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // 每次打开都是新鲜的草稿——同 NewMcpServerDialog 的做法。这里还多一层理由：
  // 上一条目的值留在框里，下一条目会拿着一份别人的凭据去落盘
  const openedFor = item?.entry.id ?? null;
  useEffect(() => {
    setValues({});
    setError(null);
  }, [openedFor]);

  const submit = () => {
    if (!item) return;
    const missing = item.entry.params.find(
      (p) => p.required && (values[p.name] ?? "").trim() === ""
    );
    if (missing) {
      setError(`「${missing.name}」是必填的`);
      return;
    }
    const trimmed = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v.trim()])
    );
    onSubmit(item, trimmed);
  };

  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>配置「{item?.entry.name ?? ""}」</DialogTitle>
          <DialogDescription>{item?.entry.authNote}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {item?.entry.params.map((p) => (
            <div key={p.name} className="flex flex-col gap-[6px]">
              <label
                htmlFor={`mcp-param-${p.name}`}
                className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase"
              >
                {p.name}
                {!p.required && <span className="ml-1 lowercase">（可选）</span>}
              </label>
              <Input
                id={`mcp-param-${p.name}`}
                value={values[p.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[12.5px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              {p.description !== "" && <p className={HINT}>{p.description}</p>}
            </div>
          ))}
          {error && <p className="text-[13px] text-err">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={submit}>装上</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
