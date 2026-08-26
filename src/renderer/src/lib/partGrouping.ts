// 消息 part → 分组路径（assistant-ui 的 groupBy）。
//
// 三层结构:
//   group-chainOfThought          过程区(不折叠,只是个容器)
//     ├─ group-reasoning          思考块(自己一条折叠头:「思考 823 字 · 1.2s」)
//     └─ group-tool               工具时间线(Tool Timeline)
//
// 思考**不进**时间线:它是模型的自言自语,和"干了什么"是两件事,混在一条折叠头
// 底下读者要在工具行之间捞文章。代价说清楚:分组是相邻合并的,「bash → 思考 →
// bash」会切成"时间线 / 思考块 / 时间线"三块,而不是一条多步时间线 —— 这是
// 把思考拎出去必然的找零,接受。
//
// 旁白(narration:true,投影层把「带工具的 content」投成这个,见 toThreadMessages.ts)
// 走**工具**那条路径而不是思考:它是模型边干边说的一句过渡话,属于"干了什么"的
// 一部分。它要是也算思考,「bash → 说一句 → bash」同样会被切成三块。
//
// 单独一个文件而不是写在 thread.tsx 里:thread.tsx 是抄来的上游组件(升级时要人工合),
// 而"旁白算工具不算思考"是本仓的判断,该能单独验(tests/renderer/partGrouping.test.ts)。

import { groupPartByType } from "@assistant-ui/react";

/** 上游的按 type 查表版。standalone-tool-call(MCP app / display:"standalone" 的工具)
    要查工具 UI 注册表才判得出来,只有这个 helper 认得 —— 所以基础映射照用它,
    本仓只在外面截一层旁白 */
const BY_TYPE = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
  // 来源 chip 挨在一起时排成一行(每条自己一行会把回复撑散)。
  // 不进 chain-of-thought:它是"这次回答引了哪些页",属于结论的一部分,
  // 不该跟着过程一起折叠
  source: ["group-sources"],
});

/** 常量而不是每次现拼:返回值直接进 buildGroupTree,新数组引用没有坏处,
    但没必要每个 part 都造一个 */
const NARRATION_PATH = ["group-chainOfThought", "group-tool"] as const;

/** groupBy 本体。模块级常量 —— GroupedParts 拿函数引用当 memo key,
    渲染里现拼一个会让整棵分组树每次重渲染都重建 */
export const OTTO_GROUP_PARTS_BY: typeof BY_TYPE = (part, context) =>
  part.type === "reasoning" && (part as { narration?: boolean }).narration === true
    ? NARRATION_PATH
    : BY_TYPE(part, context);
