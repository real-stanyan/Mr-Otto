// 记忆栏目(设置页)——MEMORY.md / USER.md 的直接编辑口(ADR-0059)。
//
// textarea 绑的是磁盘上的原文(带 ENTRY_DELIMITER 的 "\n§\n" 分隔符),不是重排过的
// "一行一条":getMemory()/saveMemory() 只归一化(去空条目、保序去重),不重排格式,
// 这里也不例外——归一化在 shared/memoryStore.ts 里是同一套纯函数,占用条上显示的
// used 数字用 charCount(formatEntries(parseEntries(text))) 算,和主进程
// applyUserEdit 真正落盘前做的是同一步计算,页面上看到的数字不会跟保存后的实际值对不上。
//
// 不进 useChat store:这两个文件只有这一个栏目会读/改,没有别处要订阅,进 store
// 反而多一份要维护的镜像(McpSettings/SubagentSettings 那两份清单进 store 是因为
// 别处也要用,这里不成立)。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
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
  const used = charCount(formatEntries(parseEntries(text)));
  const limit = MEMORY_LIMITS[target];
  const over = used > limit;
  const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;

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

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border px-[14px] py-3">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-[650]">{label}</span>
        <span
          className={cn(
            "ml-auto font-mono text-xs tabular-nums",
            over ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {used.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
        </span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200 ease-strong motion-reduce:transition-none",
            over ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={loaded === null || busy}
        placeholder={loaded === null ? "读取中…" : "还没有记忆"}
        className="min-h-32 font-mono text-xs"
      />
      {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
      <div className="flex items-center gap-2">
        {saved && !dirty && <span className="saved-hint text-xs text-muted-foreground">已保存</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || loaded === null || loaded === ""}
            onClick={() => void clear()}
          >
            清空
          </Button>
          <Button size="sm" disabled={busy || loaded === null || !dirty || over} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
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
      </section>
    </div>
  );
}
