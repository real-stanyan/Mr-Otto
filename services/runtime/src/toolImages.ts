// 云会话里工具产出的图（generate_image，#1682 日常能力：「给妈妈做张生日贺卡」）。
//
// 三件事住在一起，因为它们是同一条路的三段：
//   · `createToolImageIntakeMiddleware` —— 桌面 src/main/imageIntake.ts 的云端版：工具交字节，这里落进团队的附件库
//     （图生图 edit_last 从这里读回来），**再传一份进 Storage 的 `chat-media`**，路径 = chatMediaPath(团队, 会话, sha256, mime)。
//     手机只认 Storage 里的对象（它够不着 VPS 的磁盘），不传这一份，日志里有 ref、手机上是一块灰。
//     附件 id 是 `sha256:<hex>`（AttachmentStore.save 的方案），对象名用同一个 hex——与 chatMediaIntake 收用户图时
//     「id 与 Storage 对象名同一个 hex」是同一条纪律，于是 mobileChat 的 chatMediaItemsOf 从 ref 拼得出路径。
//   · `publishToolImages` —— 上面那一步的本体，群座位的桥也用它：座位里画的图要在群那边的目录里再传一份
//     （群与座位不是同一个团队，RLS 按团队/会话目录放行，座位目录群里的人读不到）。
//   · `decideRuntimeImageRoute` —— 出图走哪条路：桌面 routeImage 的云端版（同一套措辞纪律，ADR-0248）。
//     身份证明是 runtime 那一套（x-runtime-secret + on-behalf 所有者，ADR-0233），钱记在所有者头上，同聊天。
//
// 失败的立场照桌面 imageIntake：落库 / 上传失败的那一张**跳过**，不炸工具调用，模型看到的 output 一个字不变。
// 上传失败也跳过（不只是落库失败）：ref 进了日志而 Storage 里没有对象，手机上画出来的是一张永远加载不出的图。
import type { AttachmentStore } from "../../../src/session/attachments.js";
import type { UserAttachmentRef } from "../../../src/session/events.js";
import type { ToolMiddleware } from "../../../src/loop/middleware.js";
import type { ToolImage } from "../../../src/tools/tool.js";
import type { BillingMe } from "../../../src/shared/billing.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { CHAT_MEDIA_BUCKET, chatMediaPath } from "../../../src/shared/chatMedia.js";
import { pickImageModel } from "../../../src/shared/imageModel.js";

/** 云会话里出图用哪一款。云会话没有出图选单（没有 `image_model_changed` 可读），所以钉一个默认：
    桌面「没选过」的人用的是 `imageModels[0]`（网关按价排序的第一款），0032 的头注写明那一款此刻是
    seedream-5-0-lite（$0.035/张）。**钉成常量而不是现读 `[0]`**：`[0]` 随改价漂移（0032 那次就漂过一回），
    云端没有界面让人看见「这次换了一款」；钉住之后它不在网关清单里时照 pickImageModel 回落 `[0]`，不报错 */
export const RUNTIME_IMAGE_MODEL = "seedream-5-0-lite";

/** 往 Storage 里传一个对象（daemon 接 supabase.storage.from(bucket).upload，upsert——按内容寻址，重传无害） */
export type MediaUpload = (bucket: string, path: string, data: Uint8Array, contentType: string) => Promise<void>;

export interface ToolImagesPort {
  /** 这个团队的附件库（只用 save / read：夹具不必造真目录） */
  store: Pick<AttachmentStore, "save" | "read">;
  upload: MediaUpload;
  log?: (msg: string) => void;
}

/** PNG / JPEG 的宽高（手机按它定气泡比例；读不出 = 0，气泡退回方块）。只读头几百字节，不解码 */
export function imageSizeOf(data: Uint8Array): { width: number; height: number } | null {
  // PNG：8 字节签名 + IHDR（长度 4 + 类型 4）之后就是宽高，各 4 字节大端
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const w = ((data[16]! << 24) | (data[17]! << 16) | (data[18]! << 8) | data[19]!) >>> 0;
    const h = ((data[20]! << 24) | (data[21]! << 16) | (data[22]! << 8) | data[23]!) >>> 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  // JPEG：按段走到第一个 SOF（C0–CF，除去 C4 / C8 / CC），高在宽前面
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i += 1; continue; }
      const marker = data[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      const len = (data[i + 2]! << 8) | data[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (data[i + 5]! << 8) | data[i + 6]!;
        const w = (data[i + 7]! << 8) | data[i + 8]!;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** 一批图：落附件库 + 传进 `chat-media/<团队>/<会话>/<hex>.<ext>`。回传成功的那几张的 ref（带宽高，读得出才带）。
    哪一张失败就跳过哪一张（格式附件库不收 / 体积超 / 桶不收这种 mime / 网络），不抛 */
export async function publishToolImages(
  port: ToolImagesPort,
  workspaceId: string,
  sessionId: string,
  images: readonly ToolImage[],
  name: string,
): Promise<UserAttachmentRef[]> {
  const refs: UserAttachmentRef[] = [];
  for (const img of images) {
    let ref: UserAttachmentRef;
    try {
      ref = port.store.save(img.data, `${name}.${extOf(img.mimeType)}`);
    } catch (err) {
      port.log?.(`工具产出的图落不进附件库，跳过：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // 路径用附件库**嗅探出来的** mediaType，不用工具自报的：对象扩展名要与字节对得上
    const hex = ref.id.startsWith("sha256:") ? ref.id.slice("sha256:".length) : ref.id;
    try {
      await port.upload(CHAT_MEDIA_BUCKET, chatMediaPath(workspaceId, sessionId, hex, ref.mediaType), img.data, ref.mediaType);
    } catch (err) {
      port.log?.(`工具产出的图传不上去（session=${sessionId}），跳过：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const size = imageSizeOf(img.data);
    refs.push(size === null ? ref : { ...ref, width: size.width, height: size.height });
  }
  return refs;
}

/** 桌面 createImageIntakeMiddleware 的云端版：多了「传一份进 Storage」那一步（见文件头） */
export function createToolImageIntakeMiddleware(port: ToolImagesPort, where: { workspaceId: string; sessionId: string }): ToolMiddleware {
  return async (ctx, next) => {
    const outcome = await next();
    // 失败的调用不留图（同桌面 imageIntake：denied/error 没有「这次产出了什么」可言）
    if (outcome.status !== "ok") return outcome;
    const images = outcome.images ?? [];
    if (images.length === 0) return outcome;
    const refs = await publishToolImages(port, where.workspaceId, where.sessionId, images, ctx.call.name);
    if (refs.length === 0) return outcome;
    return { ...outcome, imageRefs: refs };
  };
}

function extOf(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "bin";
  }
}

export type RuntimeImageRoute =
  | { url: string; headers: Record<string, string>; model: string }
  | { blocked: string };

/** 出图走哪条路（桌面 routeImage 的云端版）。快照是**所有者**的 /me（钱记在所有者头上，ADR-0217）。
    四种走不通分开措辞，纪律同 ADR-0248：「问不到」与「网关不供出图」都不许写成「没订阅」 */
export function decideRuntimeImageRoute(o: {
  me: BillingMe | null | "unreachable";
  /** 网关刚说过额度用完、窗口还没到（会话房的 routeMemo，同聊天那条） */
  exhausted?: boolean;
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  agentId?: string;
}): RuntimeImageRoute {
  if (o.me === "unreachable") return { blocked: "这一刻查不到主人的订阅状态，图没画；稍后再试一次。" };
  const me = o.me;
  if (me === null || me.status !== "active" || me.plan === null) {
    return { blocked: "生成图片要主人订阅 Mr Otto（桌面端设置 → 账号 → 订阅）。" };
  }
  if (o.exhausted) return { blocked: "主人的订阅额度用完了，等这扇额度窗口刷新或加购额度后再画。" };
  if (me.imageModels.length === 0) return { blocked: "订阅网关暂时不供出图。" };
  return {
    url: `${o.edgeBase}/llm/v1/images`,
    model: pickImageModel(me.imageModels, RUNTIME_IMAGE_MODEL),
    headers: {
      "x-runtime-secret": o.runtimeSecret,
      [ON_BEHALF_HEADER]: o.ownerUid,
      [WORKSPACE_HEADER]: o.workspaceId,
      [SESSION_HEADER]: o.sessionId,
      ...(o.agentId ? { [AGENT_HEADER]: o.agentId } : {}),
    },
  };
}
