// 本机文件的 sha256（#1491 P3）：云会话的媒体按内容寻址，对象名就是它。一次读 1MB 喂进去，不把整段视频读进 JS 内存
// （同 friendsApi 的 TUS 上传那条纪律）。同步算：50MB 的视频大约一秒，发送那一下卡一下可以接受——异步分片要么
// 原生模块、要么 Worker，这一期都没有。
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { File } from "expo-file-system";

const CHUNK = 1024 * 1024;

export function sha256OfFile(uri: string): string {
  const file = new File(uri);
  const size = file.size;
  const handle = file.open();
  try {
    const h = sha256.create();
    let offset = 0;
    while (offset < size) {
      handle.offset = offset;
      const chunk = handle.readBytes(Math.min(CHUNK, size - offset));
      if (chunk.byteLength === 0) break;
      h.update(chunk);
      offset += chunk.byteLength;
    }
    return bytesToHex(h.digest());
  } finally {
    handle.close();
  }
}

export function fileSizeOf(uri: string): number {
  return new File(uri).size;
}
