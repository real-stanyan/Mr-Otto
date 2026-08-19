// avatarImage — 用户选的图片文件 → 能进 profiles.avatar_url 的 data URL。
//
// 为什么是 data URL 而不是上传到对象存储:这个仓库的 Supabase 是自托管的,
// Storage 没配、也没有 VPS 访问权(同 #77 的处境)。头像走 text 列意味着
// 零新基建,代价是它跟着好友列表一起被查出来 —— 所以下面这些数字不是随手定的:
// 边长压到 256、编成 webp,一张脸大约 10~30KB,好友量级两位数时可以接受。
//
// 全在渲染层做,不经主进程:<input type="file"> / FileReader / canvas 都是 Web API,
// 不是 Node API,没有碰硬规则那条线(渲染层不许直接摸 Node)。

/** 存进库的边长。头像最大只会显示在弹窗里的 72px,256 是给 3x 屏留的余量 */
export const AVATAR_SIZE = 256;

/** 编码质量。0.82 在人脸上看不出损失,再高只是让 base64 变长 */
const QUALITY = 0.82;

/** 一路降到这个质量还超标就放弃 —— 到这一步说明源图不是常规照片 */
const MIN_QUALITY = 0.5;

export interface CropRect {
  sx: number;
  sy: number;
  size: number;
}

/**
 * 原图 → 居中正方形裁剪框(cover 语义:填满,不留白,不变形)。
 * 头像位是圆的,任何"完整放进去"的做法都会在圆边留出背景色的月牙。
 */
export function coverCropRect(width: number, height: number): CropRect {
  const size = Math.min(width, height);
  return {
    sx: Math.round((width - size) / 2),
    sy: Math.round((height - size) / 2),
    size,
  };
}

/** 超出上限时的下一档质量。返回 null = 已经到底,别再试了 */
export function nextQuality(current: number): number | null {
  const next = Math.round((current - 0.15) * 100) / 100;
  return next >= MIN_QUALITY ? next : null;
}

/** canvas 能不能编出这个格式(Safari 早期不支持 webp,退回 jpeg) */
function pickMimeType(canvas: HTMLCanvasElement): "image/webp" | "image/jpeg" {
  return canvas.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这个文件读不出图片"));
    };
    img.src = url;
  });
}

/**
 * 图片文件 → 正方形 data URL。maxChars 是硬顶(对应主进程的 AVATAR_MAX_CHARS),
 * 超了就一路降质量重编,降到底还超就抛 —— 与其存一张会把每次好友刷新都拖慢的图,
 * 不如当场告诉用户换一张。
 */
export async function fileToAvatarDataUrl(file: File, maxChars: number): Promise<string> {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这台机器画不了 canvas，换张已经是方形的小图试试");

  const { sx, sy, size } = coverCropRect(img.naturalWidth, img.naturalHeight);
  // 缩小时开高质量重采样:默认的最近邻在 256px 上会把头发边缘搓成锯齿
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  const mime = pickMimeType(canvas);
  let quality: number | null = QUALITY;
  while (quality !== null) {
    const url = canvas.toDataURL(mime, quality);
    if (url.length <= maxChars) return url;
    quality = nextQuality(quality);
  }
  throw new Error("这张图压不下来，换一张试试");
}
