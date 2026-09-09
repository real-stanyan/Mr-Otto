// fnv1a —— FNV-1a 32 位（#971 头像派生首用，#1163 音色派生第二个消费方）。
// 要的只是稳定 + 分布均匀，不需要密码学强度；不用 String.prototype.hashCode 那类——
// JS 没有内置的，各写各的迟早分家。抽到 shared 是因为头像（渲染层）与音色（三端）
// 要对同一个 agent_id 给出同一个数：两份实现哪天差一个 `>>> 0` 就是两张脸对不上
// 一个声音。
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
