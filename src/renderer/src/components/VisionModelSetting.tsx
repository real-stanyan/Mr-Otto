// 「看图模型」——vision-bridge 代读员那一款（issue #258）。
//
// 当前模型没眼睛而消息带图时，由这一款先把图读成文字（image_described 事件）
// 再喂当前模型。这条路失败会让整轮对话失败，所以值得让用户换到自己愿意
// 花钱的那家去——出厂默认是免费视觉款，高峰期常限流。
//
// 选单只列原生看图的型号（ModelPicker 的 filter）：一个没眼睛的代读员
// 会让所有带图消息集体失败。落盘/整形套路同 HelperModelSetting。
//
// 住在子智能体栏目的「内置」栏里，版式对齐 BuiltinSubagentRow（issue #262）：
// 它不是子智能体（没有工具、不进 task 清单、点不开编辑页），但用户的心智模型
// 是"后台替我干活的帮手都在内置那一栏"——memory-reviewer 在那，代读员也该在。
// 行内文案写明区别，不装成一个 agent。

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { HINT } from "../settingsShell.js";
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

  const defaultLabel = describeModel(DEFAULT_VISION_MODEL)?.label ?? DEFAULT_VISION_MODEL;
  return (
    <div className="flex flex-col">
      {/* 版式对齐 BuiltinSubagentRow，但不可点：它没有编辑页可进 */}
      <div
        className="w-full flex items-center gap-[10px] px-[14px] py-3 border border-border rounded-[10px]"
        title={`型号本身有眼睛的话不走这条路。默认 ${defaultLabel}——免费但高峰期常限流；这条路失败会让整轮对话失败`}
      >
        <span className="font-mono text-[13px] font-semibold text-brand shrink-0">vision-bridge</span>
        <Badge variant="secondary" className="shrink-0">内置</Badge>
        <span className="text-muted-foreground text-[12.5px] flex-1 min-w-0 truncate">
          图片代读员，不是 agent：你在用的型号没眼睛而消息带图时，先由它把图读成文字。选单只列原生看图的款。
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
      {error !== null && <p className={cn(HINT, "px-[14px] pt-1 text-destructive")}>{error}</p>}
    </div>
  );
}
