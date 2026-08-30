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
// 一键清逐项走 residueClean：**算不算完成看 result.kind**（issue #759 review
// C1e，判据是 shared/residue.ts 的 residueSettled，和主进程的差集投影、store
// 的精确摘除同一个纯函数）。cleaned/gone/skipped = 了结，划掉；failed = 下过手
// 但它还活着，留在原地给红字——旧写法的 `ok || note` 把 failed 那句"已发送终止
// 信号，进程组仍存活"当成了成功，进程还在跑却报清完了。所以 onDone 只在
// "一条 failed 都没有"时才调。
//
// review finding 2：onDone 不清 items——items 的真相在挂载方(store)手里，
// 只随 residue_cleaned 事件按 detector:id 精确摘除；这个组件叫 onDone 单纯
// 是"该关弹窗了"的信号，不代表"清单已经空了"（勾了 A 清完，B 没勾不该跟着
// 消失）。挂载方额外给一个 open 布尔——弹窗关着但 items 里还剩东西时(比如
// 用户点了"以后再说"），组件照 open 隐身，剩下的条目留着给角标去数。

import { useEffect, useRef, useState } from "react";
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
import { residueSettled, type CleanupResult, type ResidueItem } from "../../../shared/residue.js";

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
  open,
  onDone,
  title = "清理残留",
}: {
  sessionId: string;
  items: ResidueItem[];
  /** 弹窗可见性,挂载方（store 的 bootResidueOpen / liveResidueOpen）控制。
      与 items 解耦（review finding 2）：关掉弹窗不等于清单被清空 */
  open: boolean;
  onDone: () => void;
  /** 挂载方区分"上次残留"/"本次残留"，不传就是通用标题 */
  title?: string;
}) {
  // owned 默认勾、suspected 默认不勾
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        items.filter((i) => i.confidence === "owned" && !isDisplayOnly(i)).map((i) => i.id)
      )
  );
  const [results, setResults] = useState<Map<string, CleanupResult>>(new Map());
  const [busy, setBusy] = useState(false);
  /** 已经替用户判过一次"要不要默认勾"的 id。有它才能区分"用户手动取消了这条"
      和"这条是刚到的新条目"——前者不该被重新勾上，后者必须被勾上 */
  const seeded = useRef<Set<string>>(new Set(items.map((i) => i.id)));

  // 新出现的 owned 条目自动并进 checked（issue #759 review I2）。
  // 为什么不能只靠 useState 的惰性初值：live 路径上这个组件是**先挂载后来数据**
  // （挂载方无条件挂着，items 一开始是空数组），初值那一发算的是空集，之后
  // liveResidue 再怎么到都不会重算——于是"owned 默认勾选"在 live 路径整个失效，
  // 用户看到一屏全空的 checkbox 和一个禁用的清理按钮。分两批到达也是同理。
  // 只并入没见过的 id：用户手动取消掉的那条在 seeded 里，不会被后续重渲勾回去
  useEffect(() => {
    const fresh = items.filter(
      (i) => i.confidence === "owned" && !isDisplayOnly(i) && !seeded.current.has(i.id)
    );
    for (const i of items) seeded.current.add(i.id);
    if (fresh.length === 0) return;
    setChecked((prev) => {
      const next = new Set(prev);
      for (const i of fresh) next.add(i.id);
      return next;
    });
  }, [items]);

  // 空 items 不渲染 + open=false 不渲染：调用方可以无条件挂载这个组件，
  // 自己决定要不要弹（items 有剩但 open=false，就是"以后再说"之后的样子）。
  // 早退写在 hooks **之后**——React 的 hooks 顺序不能被条件分支打断
  if (items.length === 0 || !open) return null;

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
    // 判据统一走 residueSettled：cleaned/gone/skipped 算了结，failed 留在原地
    if (res.every(residueSettled)) onDone();
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
                const done = result !== undefined && residueSettled(result);
                const failed = result !== undefined && !residueSettled(result);
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
