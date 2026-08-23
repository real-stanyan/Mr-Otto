// 「看图模型」——vision-bridge 代读员那一款（issue #258）。
//
// 当前模型没眼睛而消息带图时，由这一款先把图读成文字（image_described 事件）
// 再喂当前模型。这条路失败会让整轮对话失败，所以值得让用户换到自己愿意
// 花钱的那家去——出厂默认是免费视觉款，高峰期常限流。
//
// 选单只列原生看图的型号（ModelPicker 的 filter）：一个没眼睛的代读员
// 会让所有带图消息集体失败。落盘/整形套路同 HelperModelSetting。

import { useEffect, useState } from "react";

import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { DEFAULT_VISION_MODEL } from "../../../shared/visionModel.js";
import { describeModel, type ModelChoice } from "../../../shared/modelCatalog.js";
import { ModelPicker } from "./ModelPicker.js";

const VISION_ONLY = (m: ModelChoice) => m.supportsVision;

export function VisionModelSetting() {
  // null = 还没从主进程读到（同 HelperModelSetting 的 loaded 模式）
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .getVisionModel()
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
    // 先落乐观值再等回值覆盖：主进程可能把没眼睛/不存在的型号换回默认
    setModel(next);
    window.otter
      .setVisionModel(next)
      .then((saved) => setModel(saved))
      .catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  return (
    <section className="flex flex-col gap-[6px]">
      <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">看图模型</h2>
      <div className="rounded-[14px] border border-border bg-card px-4 py-[13px] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-[550]">图片代读</span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              你在用的型号没眼睛时，由这一款先把图读成文字
            </span>
          </span>
          <ModelPicker
            value={model ?? ""}
            onChange={(next) => pick(next)}
            disabled={model === null}
            placeholder="读取中…"
            filter={VISION_ONLY}
            className="border border-border rounded-md px-2 py-1 shrink-0"
          />
        </div>
        {error !== null && <p className="text-[11.5px] text-destructive">{error}</p>}
        <p className="text-[12px] leading-[1.6] text-muted-foreground">
          默认 {describeModel(DEFAULT_VISION_MODEL)?.label ?? DEFAULT_VISION_MODEL}
          ——免费但高峰期常限流，而这条路失败会让整轮对话失败。选单里只有原生看图的款；
          型号本身有眼睛的话不走这条路，这里选什么都不影响它。
        </p>
      </div>
    </section>
  );
}
