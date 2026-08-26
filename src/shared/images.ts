// 图片格式嗅探。**按字节签名认,不按扩展名** —— 扩展名是用户给的,签名是文件本身的。
//
// 放在 shared 而不是 session/attachments.ts:手机端要用同一份。
// 手机上判"这张图桌面收不收"的那一刻,必须和桌面判的是**同一套签名** ——
// 两份表迟早会不一样,而不一样的那天表现是"传上去了然后被拒",最难查。
//
// iPhone 默认拍 HEIC,而这张表里没有它:那不是遗漏,是决定。HEIC 由手机端在
// 发之前转成 JPEG(mobile/src/attach.ts),桌面这侧不引解码器。

export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export function detectImageType(data: Uint8Array): ImageType | null {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
    return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
    return "image/gif";
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  )
    return "image/webp";
  return null;
}
