// base64url 编解码,手写。
//
// 为什么不用 btoa/atob:RN 的 Hermes 引擎不保证提供它们(Node 有,浏览器有,
// Hermes 要看版本和 polyfill)。src/shared 是三边共享层,不能押在某个宿主的全局上。
// 为什么不用 Buffer:那是 node builtin,这一层不许碰。
//
// 无填充(不带 =)。线上所有字节字段都走这一份,两端必须逐字节一致 ——
// 有一条测试对着 Node 的 Buffer.toString("base64url") 比对,守的就是互通。

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) REVERSE[ALPHABET[i]!] = i;

export function b64encode(u: Uint8Array): string {
  let out = "";
  for (let i = 0; i < u.length; i += 3) {
    const a = u[i]!;
    const b = i + 1 < u.length ? u[i + 1]! : -1;
    const c = i + 2 < u.length ? u[i + 2]! : -1;
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]!;
    if (b < 0) break;
    out += ALPHABET[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]!;
    if (c < 0) break;
    out += ALPHABET[c & 63]!;
  }
  return out;
}

/** 非法输入回 null 而不是抛:这些字节从公网来,坏输入是常态分支 */
export function b64decode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null; // 4n+1 不是任何字节串的编码长度
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = REVERSE[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return out.subarray(0, o);
}
