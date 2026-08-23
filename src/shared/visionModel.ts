// 看图模型 = vision-bridge 的代读员型号（issue #258）。
//
// 为什么要能配：代读员曾写死 glm-4.6v-flash（免费档，高峰期成功率 ~1/3、
// 五段退避 ~35s），而代读失败会让整个 turn 失败。配了别家视觉款 key 的用户
// 应该能把这条"不能失败的路"换到自己愿意花钱的那家去，不用改代码。
//
// 与后台小模型（shared/helperModel.ts）同款落盘/整形套路，多一条硬约束：
// 型号必须原生看图（supportsVision）——一个没眼睛的代读员会让所有带图消息
// 集体失败，且报错看不出为什么。

import { findModel } from "./modelCatalog.js";

/** 出厂默认。目录里的免费视觉款 */
export const DEFAULT_VISION_MODEL = "glm-4.6v-flash";

/** 把任意输入整形成目录里真实存在、且原生看图的型号 id。
    文件和 IPC 都是外部输入，不赌形状；认不出来/没眼睛一律退回默认 */
export function normaliseVisionModel(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_VISION_MODEL;
  const m = findModel(input);
  return m && m.supportsVision ? input : DEFAULT_VISION_MODEL;
}
