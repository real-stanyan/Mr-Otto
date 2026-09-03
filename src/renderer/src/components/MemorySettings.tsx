// 记忆栏目(设置页)——MEMORY.md / USER.md / 项目档三档的直接编辑口(ADR-0060,三档见 ADR-0116)。
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
import type { FtsHit, MemorySyncState } from "../../../shared/shellBridge.js";
import type { MemoryLoadedEvent } from "../../../session/events.js";
import {
  charCount,
  formatEntries,
  parseEntries,
  ENTRY_DELIMITER,
  MEMORY_LIMITS,
  assertMemoryFits,
  type MemoryTarget,
} from "../../../shared/memoryStore.js";
import { MAX_TOPICS } from "../../../shared/memoryTopics.js";

type ProjectMemory = {
  /** 作用域键（#886）：有 remote 的仓是 `host/path`，其余是项目根绝对路径。
      渲染层只当它是一个不透明的身份串——认得 hash 怎么拼的只有主进程 */
  id: string;
  text: string;
  /** 磁盘上还没有这个项目的目录（当前会话的项目根，第一次保存时才由主进程造出来）。
      带这个标记的那条不给「删掉这个项目的记忆」——没东西可删，点了也只会看起来没反应 */
  pending?: true;
};

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
  // 才落盘,本地这份是归一化*之前*的草稿,两者在有重复/空条目时会不一样——不重新
  // 问一次的话,loaded 会被设成没归一化的草稿,dirty 判不出来,保存钮跟着锁死
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
        {/* 高度也要有个头：条目一多，field-sizing-content 的 textarea 会一直长，
            弹窗顶穿视口，页脚那两个按钮就够不着了。超出的部分自己滚 */}
        <DialogContent className="sm:max-w-[720px] max-h-[calc(100dvh-4rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              条目之间用单独一行的 § 分隔。这份笔记每轮都会进模型的 system prompt——写稳定的偏好和环境事实，
              不写任务进度。
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-2">
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
                  <li key={e} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-2 py-1">
                    {/* truncate = white-space:nowrap，它的 min-content 是一整行宽。
                        没有 min-w-0，这一行会把弹窗的栅格轨道一路撑出卡片外 */}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e}>
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
    value="" 是"未选中"哨兵,合法:作用域键非空(空 root.txt 的目录压根不进这份清单) */
function MoveToProjectSelect({
  projects,
  disabled,
  onMove,
}: {
  projects: ProjectMemory[];
  disabled: boolean;
  /** 返回 Promise 而不是 void:失败(超限/IPC 报错)要能在这里接住并显示——
      跟 submit/clear/deleteCurrent 那几个动作同一个模式,不做成静默失败 */
  onMove: (scope: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        value={value}
        disabled={disabled || busy}
        onValueChange={(scope) => {
          setValue("");
          setBusy(true);
          setError(null);
          onMove(scope)
            .catch((e: unknown) => setError(bridgeErrorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <SelectTrigger size="sm" className="h-6 w-32 shrink-0 text-[11px]">
          <SelectValue placeholder={busy ? "移动中…" : "移到项目档"} />
        </SelectTrigger>
        <SelectContent align="end">
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id} className="text-[11px]">
              {p.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error !== null && <span className="max-w-40 text-right text-[11px] text-destructive">{error}</span>}
    </div>
  );
}

/** 项目档区:哪个项目要靠一个下拉切——只看得见当前会话那份的话,历史项目的记忆
    就成了看不见的黑洞。key={current.id} 强制切换项目时重挂载 MemoryField:
    不同项目是不同的草稿,切换该跟打开一个新字段一样干净,不带上一个的草稿。
    sessionScope 是当前会话的作用域键:它可能还没有磁盘目录(见 MemorySettings 的
    注释),这时候它照样出现在下拉里、且默认选中——新仓库里第一次写项目档就是
    从这儿开始的 */
function ProjectMemoryCard({
  projects,
  sessionScope,
  refreshProjects,
}: {
  projects: ProjectMemory[];
  /** exactOptionalPropertyTypes：这里是"可能没有"而不是"可以不传"，显式带上 undefined */
  sessionScope: string | undefined;
  refreshProjects: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
        <span className="text-[13px] font-[650]">PROJECT · 项目档</span>
        <p className="text-[13px] text-muted-foreground">
          还没有任何项目记忆。项目档按当前会话所在的 git 仓库走——在一个 git 仓库里开会话，它的项目档就会出现在这里。
        </p>
      </div>
    );
  }
  // 没手动切过就默认停在当前会话那个项目上:打开设置页最想看的是"我现在这个仓库
  // 记了什么",不是按字母序排第一的那个。走到这里 projects 非空(上面的 length
  // 判断是证据),最后那个 ?? 兜底断言安全
  const current = (projects.find((p) => p.id === (picked ?? sessionScope)) ?? projects[0])!;

  const deleteCurrent = async () => {
    if (!window.confirm(`删掉「${current.id}」的项目记忆？不可恢复。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await window.otter.deleteProjectMemory(current.id);
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
        <Select value={current.id} onValueChange={setPicked}>
          <SelectTrigger size="sm" className="ml-auto max-w-60 min-w-32 bg-card text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current.pending !== true && (
          <Button variant="outline" size="sm" disabled={deleting} onClick={() => void deleteCurrent()}>
            删掉这个项目的记忆
          </Button>
        )}
      </div>
      {error !== null && <p className="px-1 text-[13px] text-destructive">{error}</p>}
      <MemoryField
        key={current.id}
        target="project"
        label={`PROJECT · ${current.id}`}
        fetchText={() =>
          window.otter.listProjectMemories().then((ps) => ps.find((p) => p.id === current.id)?.text ?? "")
        }
        onSave={async (text) => {
          await window.otter.saveMemory("project", text, undefined, current.id);
          await refreshProjects(); // 项目文本变了,外层的 projects 列表(picker/移到项目档下拉)也要跟着新
        }}
      />
    </div>
  );
}

type TopicMemory = { slug: string; label: string; text: string; seed: boolean };

/** 主题桶分区（第四档，#846）：列表选一个桶，正文用 MemoryField（与三档同一套编辑/忘掉），
    改显示名落 .label，非种子桶可删。桶的创建不在这里——建桶是模型写记忆时的动作 */
function TopicMemoryCard() {
  const [topics, setTopics] = useState<TopicMemory[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => window.otter.listTopicMemories().then(setTopics);
  useEffect(() => {
    void refresh();
  }, []);
  const current = topics.find((t) => t.slug === picked) ?? topics[0] ?? null;
  useEffect(() => {
    setLabel(current?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.slug, current?.label]);

  const saveLabel = async () => {
    if (!current) return;
    setError(null);
    try {
      await window.otter.setTopicLabel(current.slug, label);
      await refresh();
    } catch (err) {
      setError(bridgeErrorMessage(err));
    }
  };
  const remove = async () => {
    if (!current || current.seed) return;
    if (!window.confirm(`删掉主题桶「${current.label}」（${current.slug}）？不可恢复。`)) return;
    try {
      await window.otter.deleteTopicMemory(current.slug);
      setPicked(null);
      await refresh();
    } catch (err) {
      setError(bridgeErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-[650]">TOPIC · 主题桶</span>
        <span className="text-xs text-muted-foreground">
          {topics.length} 个 · 上限 {MAX_TOPICS}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {topics.map((t) => (
          <Button
            key={t.slug}
            size="sm"
            variant={t.slug === current?.slug ? "default" : "outline"}
            onClick={() => setPicked(t.slug)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {current && (
        <>
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={current.slug}
              className="h-8 text-[13px]"
            />
            <Button variant="outline" size="sm" onClick={() => void saveLabel()}>
              改显示名
            </Button>
            {!current.seed && (
              <Button variant="destructive" size="sm" onClick={() => void remove()}>
                删桶
              </Button>
            )}
          </div>
          <MemoryField
            key={current.slug}
            target="topic"
            label={`${current.label} (${current.slug})`}
            fetchText={() =>
              window.otter.listTopicMemories().then((ts) => ts.find((t) => t.slug === current.slug)?.text ?? "")
            }
            onSave={(text) => window.otter.saveMemory("topic", text, undefined, undefined, current.slug)}
          />
        </>
      )}
      {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
    </div>
  );
}

export function MemorySettings() {
  const [onDisk, setOnDisk] = useState<ProjectMemory[]>([]);
  const [syncStatus, setSyncStatus] = useState<MemorySyncState>({ kind: "off" });
  const refreshProjects = () => window.otter.listProjectMemories().then(setOnDisk);
  useEffect(() => {
    void refreshProjects();
    void window.otter.memorySyncStatus().then(setSyncStatus);
  }, []);

  /** 当前会话的作用域键,取自它自己的 memory_loaded 事件(同 OttoThread 的 MemoryCard):
      渲染层不认得 git,也不该自己去爬 .git——那是主进程算好落进事件里的事实。
      **旧日志没有 projectScope**(#886 之前),退回 projectRoot——那正是它当时的键 */
  const sessionScope = useChat((s) => {
    const e = s.events.find((x): x is MemoryLoadedEvent => x.type === "memory_loaded");
    return e?.projectScope ?? e?.projectRoot;
  });

  /** 磁盘上那份 + 当前会话的项目根（哪怕它还没有目录）。
      为什么必须补这一条:root.txt 只有真正写过项目档才会出现,而
      listProjectMemories 跳过没有 root.txt 的目录,设置页的一切又都从这个列表推导——
      于是在一个**新仓库**里,用户既不能创建也不能预填它的项目档,得先设法诱使模型
      自己选 project 才行。而「移到项目档」这颗按钮是「不迁移存量」这个决定的配套,
      它恰恰在最需要的场景(新仓库、项目约定还堵在超限的全局档里)不可用（ADR-0116）。
      合成的那条 text 是空串:它在磁盘上还不存在,保存一次就由主进程连 root.txt 一起造出来 */
  const projects = useMemo<ProjectMemory[]>(() => {
    if (!sessionScope || onDisk.some((p) => p.id === sessionScope)) return onDisk;
    return [...onDisk, { id: sessionScope, text: "", pending: true as const }].sort((a, b) =>
      a.id.localeCompare(b.id)
    );
  }, [onDisk, sessionScope]);

  /** MEMORY 区某条「移到项目档」:先写项目档、再从全局删,顺序不许调换——中途失败
      宁可重复一条(用户看得见、能删),不可丢失。第二步不传 sessionId:主进程
      applyUserEdit 的默认参数落到 MEMORY_EDITS_SESSION（main/memoryEdit.ts 的内部常量),
      渲染层因此不需要 import 那个主进程模块——两次整份写,不借 forgetMemory。
      超限检查在任何 saveMemory 之前做:跟 memory 工具的 applyOps 同一个语义——超限
      报错、不自动淘汰、不截断,逼用户先腾地。检查放在两次写之前,是因为"项目档写完、
      发现超限、全局档没删"比"直接拒绝"更糟——用户会看到同一条记忆凭空出现在两档里,
      且不知道该信哪一份。调用方(MoveToProjectSelect)负责把这里抛出的错误显示出来 */
  const moveToProject = async (entry: string, allEntries: string[], scope: string) => {
    const proj = projects.find((p) => p.id === scope);
    const nextProject = proj?.text ? `${proj.text}${ENTRY_DELIMITER}${entry}` : entry;
    assertMemoryFits("project", nextProject); // 抛的话下面两次 saveMemory 都不会跑，见 memoryStore.ts 的注释
    await window.otter.saveMemory("project", nextProject, undefined, scope);
    await window.otter.saveMemory("memory", formatEntries(allEntries.filter((x) => x !== entry)));
    await refreshProjects();
  };

  const syncHint = (() => {
    switch (syncStatus.kind) {
      case "off":
        return "记忆只在这台电脑上（登录后会跟账号同步）";
      case "idle":
        return "已与账号同步";
      case "syncing":
        return "同步中…";
      case "error":
        return "同步失败，会自动重试";
    }
  })();

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="memory" className="flex-1" />
        <span className={HINT} title={syncStatus.kind === "error" ? syncStatus.message : undefined}>
          {syncHint}
        </span>
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
                    onMove={(scope) => moveToProject(entry, allEntries, scope).then(refresh)}
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
        <ProjectMemoryCard projects={projects} sessionScope={sessionScope} refreshProjects={refreshProjects} />
        <TopicMemoryCard />
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
