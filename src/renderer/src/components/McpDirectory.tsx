// 连接器目录（MCP 设置页顶部）——"想接一台 server"这件事此前唯一的入口是
// 新建对话框：用户得先知道这台 server 叫什么、URL 是什么、命令怎么敲。这个
// 网格把"有哪些"变成可浏览的。
//
// 两层，分野在 lib/mcpDirectory.ts 里落地：
// - 首屏是仓内精选层（MCP_CATALOG），零网络、立刻出现。注册表当不了首屏——
//   它按字母序返回，第一条是 ac.inference.sh，没有任何排名信号。
// - 打了字才去查公开注册表，结果压在一条"未经核验"的分隔线下面。
//
// 卡片右边那一格说的是**此刻的真实状态**，不是"配置里有没有这个 id"
// （installSlot，见 lib/mcpDirectory.ts）。这两件事不是一回事：授权失败、
// 连不上、被关掉，配置里都有它——一律画勾等于告诉用户"完事了"（issue #722）。
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
import { Check, Loader2, Plus, Search, ShieldCheck } from "lucide-react";
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
  installSlot,
  installPackageName,
  installSourceLabel,
  groupByCategory,
  needsInstallConfirm,
  uniqueServerId,
  type DirectoryItem,
  type InstalledServer,
} from "../lib/mcpDirectory.js";
import { searchCatalog, type CatalogEntry } from "../../../shared/mcpCatalog.js";
import { McpEntryIcon } from "./McpEntryIcon.js";
import type { McpServerStatus } from "../../../shared/mcp.js";
import {
  filterInstalled,
  humanizeMcpError,
  installedItems,
  splitInstalled,
} from "../lib/mcpInstalled.js";
import { mcpDisplayStatus } from "../lib/mcpForm.js";
import { McpConnectorPage } from "./McpConnectorPage.js";

const DEBOUNCE_MS = 250;

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const GRID = "grid gap-2 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]";

export function McpDirectory({
  servers,
  onPageChange,
}: {
  /** 盘上那几台的完整快照。传整份而不是 {id,status} 的精简版（#753）：
      已装的那几台现在也画成卡片放在最上面，而"目录里没有的那些"（手填的、
      注册表来的）只能从配置现造条目——那需要 url/command。详情页里的管理面
      也吃这份 */
  servers: McpServerStatus[];
  /** 详情页开着时通知外面：它是一整屏，下面那份 server 清单得让位，
      不然"新页面"底下还挂着上一页的尾巴（#745） */
  onPageChange?: (open: boolean) => void;
}) {
  const searchMcpRegistry = useChat((s) => s.searchMcpRegistry);
  const saveMcpServer = useChat((s) => s.saveMcpServer);
  const authorizeMcpServer = useChat((s) => s.authorizeMcpServer);

  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<CatalogEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  // 打开的详情页。存 id 而不是整个 item：item 每次 buildDirectory 都是新对象，
  // 存下来的那份会在装完之后停在旧状态上（卡片切成 ✓ 了，详情页还写着"添加"）
  const [openedId, setOpenedId] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<DirectoryItem | null>(null);
  const [filling, setFilling] = useState<DirectoryItem | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // 原文跟着译文一起存：humanizeMcpError 只翻认得出的那几类，而调试时
  // 还得看得到 SDK 的原话——它去 title（ADR-0189 定的那条约定）
  const [installError, setInstallError] = useState<{ text: string; raw: string } | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);

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

  const installed: InstalledServer[] = servers.map((s) => ({
    id: s.id,
    status: mcpDisplayStatus(s.config, s.status),
    tools: s.tools.map((t) => t.name),
  }));
  const installedIds = installed.map((s) => s.id);
  const mine = filterInstalled(installedItems(servers), query);
  const { connected, pending } = splitInstalled(mine);
  const { curated, longTail } = buildDirectory({
    query,
    // 装过的不在下面的分类里重复出现——它已经在最上面那两组里了。
    // 同一台 server 在一屏上出现两次，用户要先想明白"这两张是不是一个东西"
    curated: searchCatalog(query).filter((e) => !installedIds.includes(e.id)),
    registry,
    installed,
  });

  const install = async (item: DirectoryItem, values: Record<string, string>) => {
    const entry = item.entry;
    // 撞名就补后缀（uniqueServerId 内部复用 mcpServerIdError 那把尺子）——
    // 目录页装第二台同名 server 不该弹一个"已经有一台叫…"让用户自己改名
    const id = uniqueServerId(entry.id, installedIds);
    setInstalling(entry.id);
    setInstallError(null);
    setInstallNote(null);
    try {
      await saveMcpServer(id, configFromEntry(entry, values));
    } catch (e) {
      const raw = bridgeErrorMessage(e);
      setInstallError({ text: humanizeMcpError(raw), raw });
      setInstalling(null);
      return;
    }
    if (entry.transport === "http") {
      if (item.verified) {
        // 授权失败不等于装失败：配置已经落盘了，下面那张卡片上还能再点一次
        // 「授权」。把它报成"装不上"是撒谎
        try {
          await authorizeMcpServer(id);
        } catch (e) {
          const raw = bridgeErrorMessage(e);
          setInstallError({ text: `「${id}」已装上，但授权没跑通：${humanizeMcpError(raw)}`, raw });
        }
      } else {
        // 未核验的不自动拉授权。授权会按对方 server 自己给的 OAuth 元数据
        // 开系统浏览器（主进程的 shell.openExternal），也就是说：在一个开放
        // 投稿的注册表里点一下卡片，浏览器就被带去一个陌生人指定的地址。
        // 「代码跑在对方机器上」这条豁免讲的是不执行代码，管不到"把用户的
        // 浏览器送去哪"——所以这一步交回给用户，在他自己想授权的时候点
        setInstallNote(
          `「${id}」已装上。这台来自公开注册表，没有自动拉授权——要用的话，在下面那台的卡片里点一次「授权」。`
        );
      }
    }
    setInstalling(null);
  };

  // 卡片上那颗「授权」——needs-auth 时用户就在这一格，别逼他先弄明白
  // 「上面这张卡和下面那一行是同一台 server」
  const authorize = async (item: DirectoryItem) => {
    const id = item.entry.id;
    setInstalling(id);
    setInstallError(null);
    setInstallNote(null);
    try {
      await authorizeMcpServer(id);
    } catch (e) {
      const raw = bridgeErrorMessage(e);
      setInstallError({ text: `「${id}」授权没跑通：${humanizeMcpError(raw)}`, raw });
    }
    setInstalling(null);
  };

  const start = (item: DirectoryItem) => {
    setInstallError(null);
    setInstallNote(null);
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

  // 现查而不是存对象：装完之后 installed 变了，buildDirectory 会产出一份新的
  // item，详情页上那颗按钮得跟着变。存下 item 的那一版会停在打开那一刻的状态
  const opened =
    openedId === null
      ? null
      : ([...mine, ...curated, ...longTail].find((i) => i.entry.id === openedId) ?? null);

  // 通知外面"这一屏被一整页盖住了"。放 effect 里而不是在 setOpenedId 旁边顺手
  // 调一次：openedId 还会因为搜索词变化而失效（搜走了那条，opened 变 null），
  // 那种情况下也得把清单还回去
  useEffect(() => {
    onPageChange?.(opened !== null);
  }, [opened, onPageChange]);

  // 装/授权的结果两个分支都要说 —— 详情页上点了「添加」失败却一声不吭，
  // 比在目录页上失败更糟：那一屏除了这颗按钮什么都没有
  const messages = (
    <>
      {installError && (
        <p className="text-[13px] text-err" title={installError.raw}>
          {installError.text}
        </p>
      )}
      {installNote && <p className={HINT}>{installNote}</p>}
    </>
  );

  // 两道对话框跟着 messages 一起，两个分支都挂 —— 详情页上点「添加」同样会
  // 走到"要填参数"和"未核验的 stdio 先确认"这两步，而只挂在网格那一支的话，
  // 状态设了、对话框根本没渲染：按钮点下去一声不响（#745 差点这样出门）
  const dialogs = (
    <>
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
    </>
  );

  if (opened !== null) {
    return (
      <div className="flex flex-col gap-3">
        {messages}
        <McpConnectorPage
          item={opened}
          server={servers.find((s) => s.id === opened.entry.id)}
          busy={installing === opened.entry.id}
          icon={<EntryIcon entry={opened.entry} size={40} />}
          onBack={() => setOpenedId(null)}
          onAdd={() => start(opened)}
          onAuthorize={() => void authorize(opened)}
        />
        {dialogs}
      </div>
    );
  }

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

      {messages}

      {/* 我装的那几台，放在最上面（issue #753）。两组而不是一组：一张写着
          「连不上」的卡挂在「已接通」这个标题下面是自相矛盾，而把没接通的
          藏起来更糟——那台就再也点不到了，连改配置的入口都找不到 */}
      {[
        { label: "已接通", items: connected },
        { label: "待接通", items: pending },
      ]
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <div key={g.label} className="flex flex-col gap-2">
            <span className={SECTION_LABEL}>{g.label}</span>
            <div className={GRID}>
              {g.items.map((item) => (
                <DirectoryCard
                  key={item.entry.id}
                  item={item}
                  busy={installing === item.entry.id}
                  onAdd={() => start(item)}
                  onAuthorize={() => void authorize(item)}
                  onOpen={() => setOpenedId(item.entry.id)}
                />
              ))}
            </div>
          </div>
        ))}

      {curated.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* 不搜的时候按分类分段（八十多张平铺是一堵墙）；搜的时候平铺——
              结果本来就少，再切成七段反而更难扫。
              「精选」这个标题只在搜索时出现：它存在的意义是跟下面那块
              「来自公开注册表，未经核验」对照，而不搜时下面那块根本不在，
              一个没有对照物的来路标记只是又一行字。每张卡自己带的
              「已核验」角标在两种排法里都在，来路从来没丢 */}
          {searched ? (
            <div className="flex flex-col gap-2">
              <span className={SECTION_LABEL}>精选</span>
              <div className={GRID}>
                {curated.map((item) => (
                  <DirectoryCard
                    key={item.entry.id}
                    item={item}
                    busy={installing === item.entry.id}
                    onAdd={() => start(item)}
                    onAuthorize={() => void authorize(item)}
                    onOpen={() => setOpenedId(item.entry.id)}
                  />
                ))}
              </div>
            </div>
          ) : (
            groupByCategory(curated).map(({ category, items }) => (
              <div key={category} className="flex flex-col gap-2">
                <span className={SECTION_LABEL}>{category}</span>
                <div className={GRID}>
                  {items.map((item) => (
                    <DirectoryCard
                      key={item.entry.id}
                      item={item}
                      busy={installing === item.entry.id}
                      onAdd={() => start(item)}
                      onAuthorize={() => void authorize(item)}
                      onOpen={() => setOpenedId(item.entry.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
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
                  onAuthorize={() => void authorize(item)}
                  onOpen={() => setOpenedId(item.entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {dialogs}
    </div>
  );
}

function EntryIcon({ entry, size = 32 }: { entry: CatalogEntry; size?: number }) {
  // 真身在 McpEntryIcon（issue #786 抽出，分享确认框共用）；这里只是
  // 「CatalogEntry → 三个字段」的投影，目录页的调用点保持原签名
  return <McpEntryIcon icon={entry.icon} label={entry.name} tintKey={entry.id} size={size} />;
}

function DirectoryCard({
  item,
  busy,
  onAdd,
  onAuthorize,
  onOpen,
}: {
  item: DirectoryItem;
  busy: boolean;
  onAdd: () => void;
  onAuthorize: () => void;
  onOpen: () => void;
}) {
  const { entry, verified } = item;
  const slot = installSlot(item, busy);
  // 整张卡可点开详情（#745）。不用 <button> 包整张：右边那颗还是按钮，
  // 按钮套按钮既非法也会让读屏器读出两层可点。role+tabIndex+键盘处理是
  // 这个形状（"卡片是个链接，里面还有一颗独立的钮"）唯一能两边都对的写法
  const open = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onOpen();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${entry.name} 详情`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      }}
      className={cn(
        "press-card flex cursor-pointer items-center gap-[10px] rounded-[10px] border border-border",
        "bg-card px-3 py-[10px] transition-colors duration-150 hover:border-foreground/20",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      )}
    >
      <EntryIcon entry={entry} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-[6px]">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{entry.name}</span>
          {/* 长尾卡也要自己带记号：分隔线只在区块顶部，24 条结果滚两屏之后它
              早就出了视口，那时候「这张是不是核过的」只能靠"没有已核验角标"
              去反推——缺席不是信号。两个记号同样安静（同字号、同弱色），
              区别只在字面 */}
          {verified ? (
            <span className="inline-flex shrink-0 items-center gap-[3px] text-[10.5px] text-muted-foreground">
              <ShieldCheck className="size-[11px]" aria-hidden />
              已核验
            </span>
          ) : (
            <span className="shrink-0 text-[10.5px] text-muted-foreground/70">未核验</span>
          )}
        </div>
        <p className="truncate text-[12px] text-muted-foreground" title={entry.description}>
          {entry.description}
        </p>
      </div>
      {slot.kind === "done" ? (
        // 已装且连上了：不可点。增删改在下面那份列表里（McpServerRow），
        // 这里再放一条编辑路径等于两个地方管同一台 server
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center text-ok"
          title="已经装上了"
        >
          <Check className="size-4" aria-hidden />
          <span className="sr-only">{entry.name} 已经装上了</span>
        </span>
      ) : slot.kind === "authorize" ? (
        // 装上了但还没授权。**这一格不能画勾**——上一版画了，于是"浏览器关掉、
        // 授权没成"和"完事了"长得一模一样（issue #722）
        <button
          type="button"
          aria-label={`授权 ${entry.name}`}
          className={cn(
            "press-scale inline-flex shrink-0 items-center rounded-[7px] px-[7px] py-[3px]",
            "text-[11px] font-medium text-muted-foreground transition-colors duration-150",
            "ring-1 ring-border hover:bg-foreground/[0.06] hover:text-foreground"
          )}
          title="已装上，还差一次授权"
          onClick={(e) => {
            e.stopPropagation();
            onAuthorize();
          }}
        >
          授权
        </button>
      ) : slot.kind === "note" ? (
        <span className="shrink-0 text-[11px] text-muted-foreground" title={slot.title}>
          {slot.label}
        </span>
      ) : (
        <button
          type="button"
          disabled={slot.kind === "busy"}
          aria-label={`添加 ${entry.name}`}
          className={cn(
            "press-scale inline-flex size-6 shrink-0 items-center justify-center rounded-[7px]",
            "text-muted-foreground transition-colors duration-150",
            "hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          {slot.kind === "busy" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="size-4" aria-hidden />
          )}
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
