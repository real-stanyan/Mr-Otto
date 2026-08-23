// 「后台小模型」——三个 turn 外挂（分区分类 / 跟进建议 / 微压缩）共用的那一款。
//
// 为什么这一格值得单独存在（issue #112）：出厂默认 glm-4.5-flash 和看图的
// vision-bridge 走同一家的免费额度、同一把 key。两者的代价不对称——vision-bridge
// 失败会让整个 turn 失败（它的注释记着高峰期成功率约 1/3），而外挂失败只是
// 少一条标题。三个外挂每 turn 各吃一次同一份额度，等于拿"可以失败的东西"
// 去挤"不能失败的东西"的配额。
//
// 处置是把选择权交出去，不代用户挑：换到别家型号 = 换了一把 key、一份额度，
// vision-bridge 那条路彻底不受影响；愿意共用的人什么都不用做。
//
// 落盘走 window.otter.getHelperModel / setHelperModel，形状判定在主进程
// （shared/helperModel.ts）——渲染层传什么不直接信，回值才是真正存下去的那个。

import { useEffect, useState } from "react";

import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { DEFAULT_HELPER_MODEL } from "../../../shared/helperModel.js";
import { describeModel } from "../../../shared/modelCatalog.js";
import { ModelPicker } from "./ModelPicker.js";

export function HelperModelSetting() {
  // null = 还没从主进程读到（同 AutoCompactSettings 的 loaded 模式：
  // 没读到之前不画一个看着像"当前值"的默认值）
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .getHelperModel()
      .then((m) => {
        if (!cancelled) setModel(m);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(bridgeErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = (next: string) => {
    setError(null);
    // 先落乐观值再等回值覆盖：主进程可能把认不出来的型号换成出厂默认，
    // 那时界面要跟着回到默认，而不是停在用户点的那个不存在的 id
    setModel(next);
    window.otter
      .setHelperModel(next)
      .then((saved) => setModel(saved))
      .catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  return (
    <section className="flex flex-col gap-[6px]">
      <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">后台小模型</h2>
      <div className="rounded-[14px] border border-border bg-card px-4 py-[13px] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-[550]">章节标题 · 跟进建议 · 微压缩</span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              每轮对话结束后在后台各跑一次，跟你正在用的型号无关
            </span>
          </span>
          <ModelPicker
            value={model ?? ""}
            onChange={(next) => pick(next)}
            disabled={model === null}
            placeholder="读取中…"
            className="border border-border rounded-md px-2 py-1 shrink-0"
          />
        </div>
        {error !== null && <p className="text-[11.5px] text-destructive">{error}</p>}
        <p className="text-[12px] leading-[1.6] text-muted-foreground">
          默认 {describeModel(DEFAULT_HELPER_MODEL)?.label ?? DEFAULT_HELPER_MODEL}
          ——和「看图」用的是同一家的免费额度、同一把 key。看图那条路失败会让整轮对话失败，
          这三个外挂失败只是少一条标题；额度紧张就把这里换到别家，两边就各走各的 key 了。
        </p>
      </div>
    </section>
  );
}
