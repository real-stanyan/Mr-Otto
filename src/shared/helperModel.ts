// 后台小模型 = 三个 turn 外挂（分区分类 / 跟进建议 / 微压缩）共用的那一款型号。
//
// 为什么要能配（issue #112）：出厂默认是智谱的免费档，而看图的 vision-bridge
// 走的是同一家的免费额度、同一把 key。两者的代价不对称——vision-bridge 失败
// 会让整个 turn 失败（它自己的注释记着高峰期成功率约 1/3、要五段退避约 35s），
// 而外挂失败只是少一条标题。三个外挂每 turn 各吃一次同一份额度，等于拿"可以
// 失败的东西"去挤"不能失败的东西"的配额。
//
// 处置是把选择权交给用户而不是代他挑一款：换到别家型号就换了一把 key、
// 一份额度，vision-bridge 那条路彻底不受影响；愿意共用的人什么都不用做。

import { findModel } from "./modelCatalog.js";

/** 出厂默认。目录里的免费款——不配 key 就不出门（cheapAdapter 的闸门）。
    2026-08-30 从 glm-4.5-flash 换到 glm-4.7-flash：同样免费、窗口 128K → 200K，
    而 4.5-flash 那一条已经不在目录里了（默认值必须能在目录里查到，
    否则 createCheapAdapter 直接返回 null，三个外挂集体静默失效）。
    存量用户手动选过的值走 normaliseHelperModel：查不到就退回这里 */
export const DEFAULT_HELPER_MODEL = "glm-4.7-flash";

/** 把任意输入整形成一个目录里真实存在的型号 id。
    文件是外部输入（用户手改过 / 旧版本写的 / 目录里删掉了那一款），IPC 传来的
    也是外部输入——都不赌形状。认不出来一律退回默认：一个不存在的型号 id 会让
    createCheapAdapter 直接返回 null，三个外挂集体静默失效，而用户看不到任何解释 */
export function normaliseHelperModel(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_HELPER_MODEL;
  return findModel(input) ? input : DEFAULT_HELPER_MODEL;
}
