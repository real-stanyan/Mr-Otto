// 「导入 skill」弹窗（skill 库页入口钮）。
//
// skill 库默认只读 ~/.mr-otto/skills——别家 agent（Claude Code / Codex）装的
// skill 不再静默混入清单。这个弹窗是它们进来的唯一通道：现扫别家安装位，
// 用户勾选，主进程把整个 skill 目录复制进来。复制而非引用——导入完成后
// 别家卸载/改动不影响这边。
//
// 渲染层只送 name 过桥：来源路径由主进程现扫现配，这里指定不了复制来源。

import { useEffect, useState } from "react";
import { CheckIcon, DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { ExternalSkillInfo } from "../../../shared/shellBridge.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";

export function SkillImportDialog() {
  const refreshSkills = useChat((s) => s.refreshSkills);
  // 落点跟着账号走（ADR-0186），不是写死的 ~/.mr-otto/skills
  const configRoot = useChat((s) => s.configRoot);
  const [open, setOpen] = useState(false);
  const [externals, setExternals] = useState<ExternalSkillInfo[] | null>(null); // null = 扫描中
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** name → 失败原因（导入一批后留在行内展示） */
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");

  // 每次打开都现扫：别家目录是用户随时增删的外部文件，缓存只会陈旧
  useEffect(() => {
    if (!open) return;
    setExternals(null);
    setPicked(new Set());
    setFailures(new Map());
    setError("");
    window.otter
      .listExternalSkills()
      .then(setExternals)
      .catch((e: unknown) => {
        setExternals([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [open]);

  const toggle = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const doImport = async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const results = await window.otter.importSkills([...picked]);
      await refreshSkills(); // 部分成功也要刷新——成功那几条已经落盘
      const failed = new Map(
        results.filter((r) => !r.ok).map((r) => [r.name, r.reason ?? "导入失败"])
      );
      if (failed.size === 0) {
        setOpen(false);
      } else {
        // 失败的留在弹窗里带原因；成功的重扫后会以 installed 置灰出现
        setFailures(failed);
        setPicked(new Set(failed.keys()));
        setExternals(await window.otter.listExternalSkills());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        <DownloadIcon className="size-[13px]" />
        导入 skill
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle>导入 skill</DialogTitle>
            <DialogDescription>
              从其他厂家 agent 已安装的 skill 里挑选，复制进{" "}
              <code className="text-[11px]">{configRoot ? `${configRoot}/skills` : "~/.mr-otto/skills"}</code>
              。之后与来源无关—— 那边卸载或改动不影响这边。
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {externals === null && (
              <p className="py-4 text-center text-[12.5px] text-muted-foreground">扫描中…</p>
            )}
            {externals?.length === 0 && !error && (
              <p className="py-4 text-center text-[12.5px] text-muted-foreground">
                没有发现其他厂家安装的 skill。
              </p>
            )}
            {externals?.map((s) => {
              const checked = picked.has(s.name);
              const reason = failures.get(s.name);
              return (
                <button
                  key={s.name}
                  type="button"
                  disabled={s.installed}
                  onClick={() => toggle(s.name)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-[10px] border px-3 py-2 text-left transition-colors duration-150",
                    s.installed
                      ? "cursor-default border-border opacity-45"
                      : checked
                        ? "border-brand/60 bg-brand/[0.06]"
                        : "border-border hover:bg-foreground/[0.04]"
                  )}
                >
                  <span
                    className={cn(
                      "mt-px flex size-[15px] shrink-0 items-center justify-center self-center rounded-[4px] border",
                      checked && !s.installed
                        ? "border-brand bg-brand text-white"
                        : "border-border"
                    )}
                  >
                    {(checked || s.installed) && <CheckIcon className="size-[11px]" />}
                  </span>
                  <span className="shrink-0 font-mono text-[12.5px] font-semibold text-brand">
                    {s.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                    {reason ? (
                      <span className="text-destructive">{reason}</span>
                    ) : (
                      s.description || "（无描述）"
                    )}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">
                    {s.installed ? "已安装" : s.vendor}
                  </span>
                </button>
              );
            })}
          </div>

          {error && <p className="text-[12px] text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={picked.size === 0 || busy} onClick={() => void doImport()}>
              {busy ? "导入中…" : `导入所选（${picked.size}）`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
