// 出图型号：这条会话选了哪一款、真要用时用哪一款、以及它叫什么名字（#1086）。
//
// 三件事住在一起，因为它们是同一个问题的三段，而分开写必然分家：
//   · `currentImageModel` —— 日志投影（最后一条 `image_model_changed` 说了算，
//     同 `autoOn` / `currentLane` 的取法）。选单画勾用它，主进程解路也用它。
//   · `pickImageModel` —— 「选的那款此刻还在不在网关清单里」。不在就回落最便宜那款，
//     **不报错**：同 `visionModelFor` / `helperModelFor` 的纪律，网关下架一款不该让
//     出图整个不通，而「你选的那款没了」这件事没有任何用户能据此行动的出路。
//   · `IMAGE_MODEL_LABELS` —— id → 人话名字。**人手维护、会过时**（同 mcpCatalog.ts
//     的立场）：`describeModel` 那张目录里没有出图型号，不给这张表的话选单里是
//     七行裸 id（`seedream-5-0-pro`），而用户嘴里说的是「Seedream 5 Pro」。
//     认不出的**原样显示 id**，不猜也不美化 —— 网关上了新款而本仓这张表还没跟上时，
//     裸 id 至少是真的，编一个名字则是假的。

import type { SessionEvent } from "../session/events.js";

/** 这条会话此刻选的出图型号。`null` = 没选过（照旧走网关最便宜那款）。
    与型号 / lane / Auto 同一个取法：最后一条事件胜出，不加第二种持久化 */
export function currentImageModel(events: readonly SessionEvent[]): string | null {
  return events.filter((e) => e.type === "image_model_changed").at(-1)?.model ?? null;
}

/** 这一次出图真正用哪一款。`imageModels` 非空是前提（调用方由 `imageBlocked` 守着）。
    两个消费方（主进程解路 + 选单画勾）共用这一份 —— 各写一遍的结果是网关下架某款
    的那天，界面上还勾着它而实际跑的是另一款 */
export function pickImageModel(imageModels: readonly string[], preferred?: string | null): string {
  return preferred != null && imageModels.includes(preferred) ? preferred : imageModels[0]!;
}

/** 出图型号的人话名字。键是 `model_route.logical_model`（网关下发的那串 id）。
    加一款出图模型时**顺手往这里补一行** —— 漏了不会报错，只会在选单里显示裸 id */
export const IMAGE_MODEL_LABELS: Readonly<Record<string, string>> = {
  // Google（Nano Banana 一族。厂商自己的代号比型号 id 更常被人叫出口，
  // 所以两个都写：搜「gemini」和搜「banana」都要找得到）
  "gemini-2.5-flash-image": "Nano Banana",
  "gemini-3.1-flash-image": "Nano Banana 2",
  "gemini-3.1-flash-lite-image": "Nano Banana 2 Lite",
  "gemini-3-pro-image": "Nano Banana Pro",
  // ByteDance
  "seedream-4.5": "Seedream 4.5",
  "seedream-5-0-lite": "Seedream 5.0 Lite",
  "seedream-5-0-pro": "Seedream 5.0 Pro",
  // OpenAI
  "gpt-image-1": "GPT Image 1",
  "gpt-image-1-mini": "GPT Image 1 Mini",
  "gpt-image-2": "GPT Image 2",
  "gpt-5.4-image-2": "GPT-5.4 Image 2",
};

/** 选单上写什么。认不出就原样回 id（见文件头） */
export function imageModelLabel(id: string): string {
  return IMAGE_MODEL_LABELS[id] ?? id;
}
