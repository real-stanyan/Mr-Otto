// 记忆栏目(设置页)——MEMORY.md / USER.md / 项目档三档的直接编辑口(ADR-0060,三档见 tiered-memory 方案)。
//
// 正文不铺在页面上,收进弹窗:笔记加起来能有几千字符,平铺会把「重建搜索索引」这类入口挤到看不见。弹窗里的
// textarea 绑的是磁盘原文(带 "\n§\n" 分隔符),不是重排过的"一行一条":getMemory()/saveMemory() 只归一化
// (去空条目、保序去重),不重排格式,占用条的 used 数字用同一套纯函数算,跟主进程落盘前做的是同一步计算。
//
// 不进 useChat store:这些文件只有这一个栏目会读/改,没有别处要订阅。
//
// MemoryField 是三档共用的一个组件:memory/user 从 getMemory() 读,project 从 listProjectMemories() 按选中
// 的 root 现拼一份——数据源不同,靠 fetchText/onSave 两个 prop 注入,不再有一个叫 "TwoTier" 的窄化类型
// 悬在三档界面里。

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { useChat } from "../store.js";
import type { FtsHit } from "../../../shared/shellBridge.js";
import {
  charCount,
  formatEntries,
  parseEntries,
  ENTRY_DELIMITER,
  MEMORY_LIMITS,
  type MemoryTarget,
} from "../../../shared/memoryStore.js";

type ProjectMemory = { root: string; text: string };

/** entryAction 渲染时拿到的上下文，见 MemoryField 的 entryAction 参数注释 */
type MoveCtx = { allEntries: string[]; disabled: boolean; refresh: () => Promise<void> };

/** "已保存"在屏幕上停留的时间,同 ProfileCard 那颗钮一个数 */
const SAVED_HINT_MS = 2000;

function MemoryField({
  target,
  label,
  fetchText,
  onSave,
  entryAction,
}: {
  target: MemoryTarget;
  label: string;
  /** 问磁盘上这个 target 当前的文本——memory/user 走 getMemory(),project 由调用方
      按选中的 root 现问一次 listProjectMemories()，数据源不同,组件本体不关心 */
  fetchText: () => Promise<string>;
  onSave: (text: string) => Promise<void>;
  /** 每条记忆旁的可选操作(只有 MEMORY 档用来渲染"移到项目档"下拉)。allEntries 是当前
      磁盘全量条目,disabled 在草稿未保存时为真(移动直接读写磁盘,别跟草稿打架) */
  entryAction?: (entry: string, ctx: MoveCtx) => ReactNode;
}) {
  // null = 还没从主进程读到(disabled 状态);读到之后即使是空字符串也不再是 null
  const [loaded, setLoaded] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchText()
      .then((t) => {
        if (cancelled) return;
        setLoaded(t);
        setText(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(bridgeErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // target 变化(挂载切换到另一档/另一个项目)才重问;fetchText/onSave 不进依赖——
    // 那样会在父组件因别的状态重渲染时打断这里正在打的字
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), SAVED_HINT_MS);
    return () => clearTimeout(t);
  }, [saved]);

  const dirty = loaded !== null && text !== loaded;
  const limit = MEMORY_LIMITS[target];
  // 卡片上那条读的是磁盘上的(loaded),弹窗里那条读的是草稿(text)——
  // 关掉弹窗不保存时,卡片不该跟着草稿走
  const savedEntries = parseEntries(loaded ?? "");
  const savedUsed = charCount(formatEntries(savedEntries));
  const used = charCount(formatEntries(parseEntries(text)));
  const over = used > limit;
  const pct = (n: number) => (limit > 0 ? Math.max(0, Math.min(100, (n / limit) * 100)) : 0);

  // 有未保存的改动就别静默丢:草稿只活在这个组件里,关掉就没了
  const requestClose = (next: boolean) => {
    if (next) { setOpen(true); return; }
    if (dirty && !window.confirm(`「${label}」有未保存的修改，丢弃？`)) return;
    setText(loaded ?? "");
    setError(null);
    setOpen(false);
  };

  // 保存/清空之后不拿本地 text 直接当 loaded:主进程归一化过(去空条目、保序去重)
  // 才落盘,本地这份是归一化*之前*的草稿,两者在有重复/空条目时会不一样——
  // 磁盘上真正写了什么,只有重新问一次才知道,不在这重新实现一遍归一化
  const syncFromDisk = async () => {
    const t = await fetchText();
    setLoaded(t);
    setText(t);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
      await syncFromDisk();
      setSaved(true);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(`清空「${label}」的全部记忆？`)) return;
    setBusy(true);
    setError(null);
    try {
      await onSave("");
      await syncFromDisk();
      setSaved(true);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const Meter = ({ n }: { n: number }) => (
    <div className="h-[3px] overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-200 ease-strong motion-reduce:transition-none",
          n > limit ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${pct(n)}%` }}
      />
    </div>
  );
  const Count = ({ n }: { n: number }) => (
    <span className={cn("font-mono text-xs tabular-nums", n > limit ? "text-destructive" : "text-muted-foreground")}>
      {n.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
    </span>
  );

  return (
    <>
      <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="font-[650]">{label}</span>
          <span className="ml-auto">
            <Count n={savedUsed} />
          </span>
        </div>
        <Meter n={savedUsed} />
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <span>
            {loaded === null
              ? "读取中…"
              : savedEntries.length === 0
                ? "还没有记忆"
                : `${savedEntries.length} 条`}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={loaded === null}
            onClick={() => setOpen(true)}
          >
            查看 / 编辑
          </Button>
        </div>
        {error !== null && !open && <p className="text-destructive text-[13px]">{error}</p>}
      </div>

      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              条目之间用单独一行的 § 分隔。这份笔记每轮都会进模型的 system prompt——写稳定的偏好和环境事实，
              不写任务进度。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline">
              <span className="ml-auto">
                <Count n={used} />
              </span>
            </div>
            <Meter n={used} />
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={loaded === null || busy}
              placeholder={loaded === null ? "读取中…" : "还没有记忆"}
              className="min-h-[320px] font-mono text-xs"
            />
            {entryAction && savedEntries.length > 0 && (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {savedEntries.map((e) => (
                  <li key={e} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1">
                    <span className="flex-1 truncate font-mono text-xs" title={e}>
                      {e}
                    </span>
                    {entryAction(e, { allEntries: savedEntries, disabled: dirty || busy, refresh: syncFromDisk })}
                  </li>
                ))}
              </ul>
            )}
            {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || loaded === null || loaded === ""}
              onClick={() => void clear()}
            >
              清空
            </Button>
            <div className="flex items-center gap-2">
              {saved && !dirty && <span className="saved-hint text-xs text-muted-foreground">已保存</span>}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => requestClose(false)}>
                关闭
              </Button>
              <Button size="sm" disabled={busy || loaded === null || !dirty || over} onClick={() => void submit()}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 一次性动作("移到某个项目"),不是常驻状态——选完立刻回落到占位符。
    value="" 是"未选中"哨兵,合法:项目 root 都是绝对路径,不可能是空串 */
function MoveToProjectSelect({
  projects,
  disabled,
  onMove,
}: {
  projects: ProjectMemory[];
  disabled: boolean;
  onMove: (root: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(root) => {
        setValue("");
        onMove(root);
      }}
    >
      <SelectTrigger size="sm" className="h-6 w-32 shrink-0 text-[11px]">
        <SelectValue placeholder="移到项目档" />
      </SelectTrigger>
      <SelectContent align="end">
        {projects.map((p) => (
          <SelectItem key={p.root} value={p.root} className="text-[11px]">
            {p.root}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 项目档区:哪个项目要靠一个下拉切——只看得见当前会话那份的话,历史项目的记忆
    就成了看不见的黑洞。key={current.root} 强制切换项目时重挂载 MemoryField:
    不同项目是不同的草稿,切换该跟打开一个新字段一样干净,不带上一个的草稿 */
function ProjectMemoryCard({
  projects,
  refreshProjects,
}: {
  projects: ProjectMemory[];
  refreshProjects: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
        <span className="text-[13px] font-[650]">PROJECT · 项目档</span>
        <p className="text-[13px] text-muted-foreground">还没有任何项目记忆</p>
      </div>
    );
  }
  // 走到这里 projects 非空(上面的 length 判断是证据),断言安全
  const current = (projects.find((p) => p.root === picked) ?? projects[0])!;

  const deleteCurrent = async () => {
    if (!window.confirm(`删掉「${current.root}」的项目记忆？不可恢复。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await window.otter.deleteProjectMemory(current.root);
      await refreshProjects();
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[13px] font-[650]">PROJECT · 项目档</span>
        <Select value={current.root} onValueChange={setPicked}>
          <SelectTrigger size="sm" className="ml-auto max-w-60 min-w-32 bg-card text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {projects.map((p) => (
              <SelectItem key={p.root} value={p.root}>
                {p.root}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={deleting} onClick={() => void deleteCurrent()}>
          删掉这个项目的记忆
        </Button>
      </div>
      {error !== null && <p className="px-1 text-[13px] text-destructive">{error}</p>}
      <MemoryField
        key={current.root}
        target="project"
        label={`PROJECT · ${current.root}`}
        fetchText={() =>
          window.otter.listProjectMemories().then((ps) => ps.find((p) => p.root === current.root)?.text ?? "")
        }
        onSave={async (text) => {
          await window.otter.saveMemory("project", text, undefined, current.root);
          await refreshProjects(); // 项目文本变了,外层的 projects 列表(picker/移到项目档下拉)也要跟着新
        }}
      />
    </div>
  );
}

export function MemorySettings() {
  const [projects, setProjects] = useState<ProjectMemory[]>([]);
  const refreshProjects = () => window.otter.listProjectMemories().then(setProjects);
  useEffect(() => {
    void refreshProjects();
  }, []);

  /** MEMORY 区某条「移到项目档」:先写项目档、再从全局删,顺序不许调换——中途失败
      宁可重复一条(用户看得见、能删),不可丢失。第二步不传 sessionId:主进程
      applyUserEdit 的默认参数落到 MEMORY_EDITS_SESSION（main/memoryEdit.ts 的内部常量),
      渲染层因此不需要 import 那个主进程模块——两次整份写,不借 forgetMemory */
  const moveToProject = async (entry: string, allEntries: string[], root: string) => {
    const proj = projects.find((p) => p.root === root);
    const nextProject = proj?.text ? `${proj.text}${ENTRY_DELIMITER}${entry}` : entry;
    await window.otter.saveMemory("project", nextProject, undefined, root);
    await window.otter.saveMemory("memory", formatEntries(allEntries.filter((x) => x !== entry)));
    await refreshProjects();
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="memory" className="flex-1" />
      </header>
      <section className={SETTINGS_BODY}>
        <MemoryField
          target="memory"
          label="MEMORY · 笔记"
          fetchText={() => window.otter.getMemory().then((m) => m.memory)}
          onSave={(text) => window.otter.saveMemory("memory", text)}
          {...(projects.length === 0
            ? {}
            : {
                entryAction: (entry: string, { allEntries, disabled, refresh }: MoveCtx) => (
                  <MoveToProjectSelect
                    projects={projects}
                    disabled={disabled}
                    onMove={(root) => void moveToProject(entry, allEntries, root).then(refresh)}
                  />
                ),
              })}
        />
        <MemoryField
          target="user"
          label="USER · 关于用户"
          fetchText={() => window.otter.getMemory().then((m) => m.user)}
          onSave={(text) => window.otter.saveMemory("user", text)}
        />
        <ProjectMemoryCard projects={projects} refreshProjects={refreshProjects} />
        <SearchIndexCard />
      </section>
    </div>
  );
}

const HIT_TYPE_LABEL: Record<FtsHit["type"], string> = {
  user_message: "用户",
  assistant_message: "助手",
  tool_result: "工具结果",
};

/** 跨会话回忆的索引诊断卡（issue #190）：试搜框直接打 EventStore.searchText——
    用户拿自己记得的词验证「索引里有没有」；搜不到明明存在的历史时，
    同一张卡里的重建按钮从事件日志重灌。回车才搜，不做输入即搜：
    <3 字符的查询走 LIKE 全表扫描，键入途中的半截词不值得跑它 */
function SearchIndexCard() {
  const sessions = useChat((s) => s.sessions);
  const titleOf = useMemo(() => {
    const m = new Map(sessions.map((s) => [s.sessionId, s.title] as const));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [sessions]);

  const [query, setQuery] = useState("");
  // null = 还没搜过（不渲染结果区，和"0 命中"区分开）
  const [hits, setHits] = useState<FtsHit[] | null>(null);
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await window.otter.searchIndex(q));
      setSearched(q);
    } catch (err) {
      setError(bridgeErrorMessage(err));
      setHits(null);
    } finally {
      setBusy(false);
    }
  };

  const [rebuildState, setRebuildState] = useState<"idle" | "busy" | "done">("idle");
  const rebuild = async () => {
    setRebuildState("busy");
    setError(null);
    try {
      await window.otter.rebuildSearchIndex();
      setRebuildState("done");
      setTimeout(() => setRebuildState("idle"), SAVED_HINT_MS);
    } catch (err) {
      setError(bridgeErrorMessage(err));
      setRebuildState("idle");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-[650]">搜索索引 · 跨会话回忆</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder="搜历史会话正文，回车执行"
          className="h-8 text-[13px]"
        />
        <Button variant="outline" size="sm" disabled={busy || !query.trim()} onClick={() => void search()}>
          {busy ? "搜索中…" : "搜索"}
        </Button>
      </div>
      {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
      {hits !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {hits.length === 0
              ? `「${searched}」没有命中——如果确定历史里有，试试下面的重建`
              : `「${searched}」命中 ${hits.length} 个会话${hits.length >= 20 ? "（已截断）" : ""}`}
          </span>
          {hits.length > 0 && (
            <ul className="flex max-h-[240px] flex-col gap-1 overflow-y-auto">
              {hits.map((h) => (
                <li key={`${h.sessionId}:${h.seq}`} className="rounded-md bg-muted/50 px-2.5 py-1.5">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="truncate font-medium">{titleOf(h.sessionId)}</span>
                    <span className="shrink-0 text-muted-foreground">{HIT_TYPE_LABEL[h.type]}</span>
                    {h.score > 0 && (
                      <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
                        {h.score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 break-all font-mono text-xs text-muted-foreground">{h.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={rebuildState === "busy"}
          onClick={() => void rebuild()}
        >
          {rebuildState === "busy" ? "重建中…" : "重建搜索索引"}
        </Button>
        {rebuildState === "done" && <span className={HINT}>已重建</span>}
      </div>
    </div>
  );
}
