// imageIntake — 工具产出的图片从「字节」变成「日志里的一条 ref」的那一步。
//
// 为什么是中间件而不是工具自己做：硬规则「工具实现只依赖 ExecutionWorld，
// 禁止直接 import fs」。附件库是 app 级资源（EventStore 同级，见
// session/attachments.ts 开头），工具够不着也不该够得着。工具交字节，
// 落库在这里发生 —— 与 turnDiff 中间件填 diffStat 是同一条缝（ADR-0141）。
//
// 为什么不进日志本体：一张 1024×1024 的 PNG base64 ≈ 1-2MB，而日志是
// append-only 的，撑爆了删不掉。附件库是内容寻址的，同一张图重复产出天然去重。
//
// 落库失败不该炸掉工具调用：格式不认（AttachmentStore 只收 png/jpeg/webp/gif）
// 或超 10MB 时，这一张跳过，其余照落。模型看到的 output 一个字都不变 ——
// 它本来就不消费这些图（视觉桥是另一条路，ADR-0009）。

import type { AttachmentStore } from "../session/attachments.js";
import type { UserAttachmentRef } from "../session/events.js";
import type { ToolMiddleware } from "../loop/middleware.js";

export function createImageIntakeMiddleware(store: AttachmentStore): ToolMiddleware {
  return async (ctx, next) => {
    const outcome = await next();
    // 失败的调用不留图：denied/error 的 output 是拒绝文案或错误信息，
    // 此时哪怕工具塞了字节进来也没有"这次产出了什么"可言
    if (outcome.status !== "ok") return outcome;
    const images = outcome.images ?? [];
    if (images.length === 0) return outcome;

    const refs: UserAttachmentRef[] = [];
    for (const img of images) {
      try {
        // name 给工具名：附件库只拿它当 basename 存进 ref，时间线上那行
        // 「谁产出的」就有出处了。没有真文件名可用——图是生成出来的，不是读来的
        refs.push(store.save(img.data, `${ctx.call.name}.${extOf(img.mimeType)}`));
      } catch {
        // 这一张落不进去（格式/体积）：跳过。理由不上报——它对用户没有可操作性，
        // 而把它塞进 output 会改掉模型看到的内容（本中间件的立场是不碰 output）
      }
    }
    if (refs.length === 0) return outcome;
    return { ...outcome, imageRefs: refs };
  };
}

/** mimeType → 扩展名。认不出就 bin —— 真正的格式判定在 AttachmentStore.save
    里按字节签名做（不采信调用方自报的 mimeType，同 shared/images.ts 的立场），
    这里只是给 ref 拼一个人看得懂的名字 */
function extOf(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "bin";
  }
}
