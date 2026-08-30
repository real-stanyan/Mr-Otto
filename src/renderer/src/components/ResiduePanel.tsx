// 残留清单弹窗（issue #759）。
//
// 为什么是"弹窗"不是常驻侧栏面板：残留是一次性的收尾动作(处理完就没了)，
// 不是"干活的姿势"（同侧栏那七块面板的定位区别，见 lib/sidePanel.ts 的注释）。
// 样式和"默认勾选 + 原生 checkbox + 一次性确认弹窗"的骨架照抄
// ShareGrantDialog（issue #694）先例；shadcn/ui + Tailwind（ADR-0010）。
//
// owned 默认勾、suspected 默认不勾：owned 是水獭自己起的进程，suspected 可能
// 是用户自己留着的 dev server，替他做清理决定比让他自己看清单再点更容易误杀
// (diffResidue 的分类规则见 shared/residue.ts)。suspected 端口那一档比较特殊——
// diffResidue 规则 3 写死了它"仅展示，不提供清理"（没法安全 kill 一个不确定
// 是谁在监听的端口），所以连 checkbox 都不给，纯展示行。
//
// 一键清逐项走 residueClean：ok → 视为完成；ok:false 但带 note(比如"已消失",
// 说明它已经不在了) → 同样视为完成；其余的真失败留在原地给用户看清红字，
// 不能假装收工了——所以 onDone 只在"一个真失败都没有"时才调。

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { CleanupResult, ResidueItem } from "../../../shared/residue.js";

/** 分组顺序 + 中文标题（brief 点名的顺序：进程组 / 模拟器 / 端口） */
const DETECTOR_ORDER = ["process_groups", "simulators", "ports"] as const;
const DETECTOR_LABEL: Record<ResidueItem["detector"], string> = {
  process_groups: "进程组",
  simulators: "模拟器",
  ports: "端口",
};

/** suspected 端口那种"仅展示"的行——diffResidue 规则 3 写死了这句 cleanupHint。
    不可清理，只能看，不给 checkbox 免得用户以为勾了能清 */
function isDisplayOnly(item: ResidueItem): boolean {
  return item.cleanupHint.includes("仅展示");
}

export function ResiduePanel({
  sessionId,
  items,
  onDone,
  title = "清理残留",
}: {
  sessionId: string;
  items: ResidueItem[];
  onDone: () => void;
  /** 挂载方区分"上次残留"/"本次残留"，不传就是通用标题 */
  title?: string;
}) {
  // owned 默认勾、suspected 默认不勾。只在挂载那一刻算一次(items 引用变了也
  // 不重算)——用户手上已经改动过的勾选不该被后台重新推的一批数据打乱
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        items.filter((i) => i.confidence === "owned" && !isDisplayOnly(i)).map((i) => i.id)
      )
  );
  const [results, setResults] = useState<Map<string, CleanupResult>>(new Map());
  const [busy, setBusy] = useState(false);

  // 空 items 不渲染：调用方可以无条件挂载这个组件，自己决定要不要弹
  if (items.length === 0) return null;

  const toggle = (id: string): void =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clean = async (): Promise<void> => {
    setBusy(true);
    const res = await window.otter.residueClean(sessionId, [...checked]);
    setResults((prev) => {
      const next = new Map(prev);
      for (const r of res) next.set(r.id, r);
      return next;
    });
    setBusy(false);
    // ok 或带 note(比如"已消失")都视为处理完；还有一条真失败就留在原地
    if (res.every((r) => r.ok || r.note)) onDone();
  };

  const groups = DETECTOR_ORDER.map((detector) => ({
    detector,
    rows: items.filter((i) => i.detector === detector),
  })).filter((g) => g.rows.length > 0);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onDone(); // 右上角 X / Esc 关掉 = "以后再说"
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            这些进程/模拟器/端口没有随任务收尾自动清干净。owned
            是水獭自己起的，已经替你勾上；suspected
            可能是你自己留着的东西，默认不动。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[360px] space-y-3 overflow-y-auto" data-testid="residue-groups">
          {groups.map((g) => (
            <div key={g.detector} className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {DETECTOR_LABEL[g.detector]}
              </div>
              {g.rows.map((item) => {
                const result = results.get(item.id);
                const done = Boolean(result && (result.ok || result.note));
                const failed = Boolean(result && !result.ok && !result.note);
                const displayOnly = isDisplayOnly(item);
                return (
                  <div
                    key={item.id}
                    className={`flex items-start gap-2 rounded-md px-2 py-[6px] text-xs ${
                      done ? "opacity-40 line-through" : ""
                    }`}
                  >
                    {displayOnly ? (
                      <span className="mt-[1px] size-[13px] shrink-0" aria-hidden />
                    ) : (
                      <input
                        type="checkbox"
                        checked={checked.has(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={busy || done}
                        className="mt-[1px] size-[13px] shrink-0 accent-[var(--brand)]"
                        aria-label={item.label}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{item.label}</span>
                        {item.confidence === "suspected" && (
                          <Badge variant="secondary" className="shrink-0">
                            可能是你自己开的
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {item.cleanupHint}
                      </div>
                      {failed && (
                        <div className="flex items-center gap-1 text-[11px] text-err">
                          <AlertTriangle className="size-3 shrink-0" />
                          {result?.note ?? "清理失败"}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDone}>
            以后再说
          </Button>
          <Button size="sm" disabled={busy || checked.size === 0} onClick={() => void clean()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? "清理中…" : `清理选中 (${checked.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
