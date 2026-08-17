// AttachmentStore — 图片附件的内容寻址存储(DSH lite,见 docs/adr/0009)。
// EventStore 同级的 app 资源:组装根特权,可直接碰 fs
// (ExecutionWorld 硬规则管的是工具实现,不管 app 基础设施)。
// 不可变:同内容同 id,写过即永存;孤儿文件无害(重发自动复用),GC 留将来。

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserAttachmentRef } from "./events.js";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

/** magic bytes 嗅探真实图片类型——扩展名和调用方声明都不可信,字节才是事实 */
export function detectImageType(
  data: Uint8Array
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
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

/** 两种分隔符手工剥(DSH 教训:POSIX 上 path.basename 不剥 \,Windows 客户端
    的完整本机路径会原样漏进日志)。剥完为空 = 没有可用名字 */
export function stripToBasename(name: string): string | undefined {
  const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim();
  return leaf === "" ? undefined : leaf.slice(0, 255);
}

export class AttachmentStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir 的 mode 只在新建时生效,已有目录补一刀
  }

  /** 校验(类型嗅探+限额)→ 内容寻址落盘 → 返轻量 ref。同内容天然去重 */
  save(data: Uint8Array, name?: string): UserAttachmentRef {
    const mediaType = detectImageType(data);
    if (!mediaType) throw new Error("不支持的图片格式(仅收 png/jpeg/webp/gif)");
    if (data.byteLength > IMAGE_MAX_BYTES) {
      throw new Error(`图片超过 10MB 上限(实际 ${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
    }
    const hex = createHash("sha256").update(data).digest("hex");
    const path = join(this.dir, hex);
    if (!existsSync(path)) {
      writeFileSync(path, data, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const clean = name === undefined ? undefined : stripToBasename(name);
    return {
      id: `sha256:${hex}`,
      mediaType,
      bytes: data.byteLength,
      ...(clean !== undefined ? { name: clean } : {}),
    };
  }

  /** id 严格校验后才拼路径——非法 id(含路径穿越)无门 */
  read(id: string): Uint8Array {
    const m = ID_PATTERN.exec(id);
    if (!m) throw new Error(`附件 id 非法: ${id}`);
    return readFileSync(join(this.dir, m[1]!));
  }
}
