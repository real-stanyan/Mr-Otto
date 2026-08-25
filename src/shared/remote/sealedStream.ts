// 单向加密流。丢掉 libsodium secretstream(spec 第二节订正)换来桌面侧零依赖,代价是 nonce 管理
// 和乱序/重放检测从'库送的'变成'自己写的'。所以它们住在一个纯文件里,并且
// 被逐条钉住:重放拒、迟到拒、前缀不对拒、密钥不对拒、截断不抛。
//
// 线格式:[8 字节大端计数器][密文][16 字节 tag]
// nonce = [4 字节前缀(握手派生,每方向一条)][8 字节计数器]
//
// 计数器明文出现在帧头,是故意的:收端要先知道 nonce 才能验签。
// 它不是秘密——泄漏的只是"这是第几帧",而帧数本来就是网关可见的元数据。

import type { RemoteCryptoPrimitives } from "./crypto.js";

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const PREFIX_BYTES = NONCE_BYTES - COUNTER_BYTES; // 4

function nonceFor(prefix: Uint8Array, counter: bigint): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  n.set(prefix.slice(0, PREFIX_BYTES), 0);
  new DataView(n.buffer).setBigUint64(PREFIX_BYTES, counter, false); // 大端
  return n;
}

export function createSealer(
  p: RemoteCryptoPrimitives,
  key: Uint8Array,
  noncePrefix: Uint8Array
): { seal(plain: Uint8Array): Uint8Array } {
  let counter = 0n;
  return {
    seal(plain) {
      const c = counter;
      // 不回绕:到顶就抛,让上层断开重连换一把新密钥。
      // 静默回绕 = 同一把 key 复用同一个 nonce = ChaCha 的灾难性失效
      if (c === 0xffffffffffffffffn) throw new Error("远程流计数器耗尽,必须重连");
      counter += 1n;
      const box = p.chachaSeal(key, nonceFor(noncePrefix, c), plain);
      const out = new Uint8Array(COUNTER_BYTES + box.length);
      new DataView(out.buffer).setBigUint64(0, c, false);
      out.set(box, COUNTER_BYTES);
      return out;
    },
  };
}

export function createOpener(
  p: RemoteCryptoPrimitives,
  key: Uint8Array,
  noncePrefix: Uint8Array
): { open(box: Uint8Array): Uint8Array | null } {
  // -1 表示"还没收过任何一帧",这样第 0 帧(counter=0)才收得进来
  let highest = -1n;
  return {
    open(frame) {
      if (frame.length < COUNTER_BYTES + TAG_BYTES) return null;
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const counter = view.getBigUint64(0, false);
      // 严格递增:重放(==)和迟到(<)一起挡掉。
      // 先查计数器再验签,省掉一次白费的 AEAD
      if (counter <= highest) return null;
      const plain = p.chachaOpen(key, nonceFor(noncePrefix, counter), frame.slice(COUNTER_BYTES));
      if (!plain) return null;
      // 只有验签通过才推进水位线——否则伪造一个大计数器就能把后续真帧全饿死
      highest = counter;
      return plain;
    },
  };
}
