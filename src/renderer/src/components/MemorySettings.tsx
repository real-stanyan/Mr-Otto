// 记忆栏目(设置页)——MEMORY.md / USER.md 的直接编辑口(ADR-0060)。
//
// 正文不铺在页面上,收进弹窗:两份笔记加起来能有三千多字符,平铺会把「重建搜索索引」
// 这类入口挤到看不见,而它们平时被读的次数远多于笔记正文。卡片上只留标题/占用/条数。
//
// 弹窗里的 textarea 绑的是磁盘上的原文(带 ENTRY_DELIMITER 的 "\n§\n" 分隔符),不是重排过的
// "一行一条":getMemory()/saveMemory() 只归一化(去空条目、保序去重),不重排格式,
// 这里也不例外——归一化在 shared/memoryStore.ts 里是同一套纯函数,占用条上显示的
// used 数字用 charCount(formatEntries(parseEntries(text))) 算,和主进程
// applyUserEdit 真正落盘前做的是同一步计算,页面上看到的数字不会跟保存后的实际值对不上。
//
// 不进 useChat store:这两个文件只有这一个栏目会读/改,没有别处要订阅,进 store
// 反而多一份要维护的镜像(McpSettings/SubagentSettings 那两份清单进 store 是因为
// 别处也要用,这里不成立)。

import { useEffect, useMemo, useState } from "react";
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
  MEMORY_LIMITS,
  type MemoryTarget,
} from "../../../shared/memoryStore.js";

const FIELDS: { target: MemoryTarget; label: string }[] = [
  { target: "memory", label: "MEMORY · 笔记" },
  { target: "user", label: "USER · 关于用户" },
];

/** "已保存"在屏幕上停留的时间,同 ProfileCard 那颗钮一个数 */
const SAVED_HINT_MS = 2000;

function MemoryField({ target, label }: { target: MemoryTarget; label: string }) {
  // null = 还没从主进程读到(disabled 状态);读到之后即使是空字符串也不再是 null
  const [loaded, setLoaded] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .getMemory()
      .then((m) => {
        if (cancelled) return;
        setLoaded(m[target]);
        setText(m[target]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(bridgeErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
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

  // 保存/清空之后不拿本地的 text 直接当 loaded:主进程用
  // formatEntries(parseEntries(...)) 归一化过(去空条目、保序去重)才落盘,
  // 本地这份是归一化*之前*的草稿。两者在有重复/空条目时会不一样——
  // 不重新拉一次的话,textarea 会停在一份磁盘上其实不存在的旧文本上,
  // 且因为 loaded 也被错误地设成了它,dirty 判不出来,保存钮跟着锁死。
  // 磁盘上真正写了什么,只有再读一次 getMemory() 才知道——不在这重新实现一遍归一化
  const syncFromDisk = async () => {
    const m = await window.otter.getMemory();
    setLoaded(m[target]);
    setText(m[target]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.otter.saveMemory(target, text);
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
      await window.otter.saveMemory(target, "");
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
              条目之间用单独一行的 § 分隔。这两份笔记每轮都会进模型的 system prompt——写稳定的偏好和环境事实，
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

export function MemorySettings() {
  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="memory" className="flex-1" />
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          模型用 memory 工具自己攒的两份笔记——
          <strong className="font-medium text-foreground/80">MEMORY</strong> 是随手记的事,
          <strong className="font-medium text-foreground/80">USER</strong> 是关于你的了解。
          在这改也算数:会留一条 memory_user_edit 记录，和模型自己写的一视同仁。
        </p>
        {FIELDS.map((f) => (
          <MemoryField key={f.target} target={f.target} label={f.label} />
        ))}
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
      <p className={HINT}>
        模型用 session_search 回忆历史会话时查的就是这份索引。在这试搜可以验证索引是否健康
        （模型搜索时会额外排除当前会话）。
      </p>
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
        <span className={HINT}>
          {rebuildState === "done" ? "已重建" : "搜不到明明存在的历史时，从事件日志重灌一次索引"}
        </span>
      </div>
    </div>
  );
}
