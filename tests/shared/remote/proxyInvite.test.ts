import { describe, expect, it } from "vitest";
import {
  createProxyInvite,
  decodeProxyInvite,
  encodeProxyInvite,
  PROXY_INVITE_TTL_MS,
  proxyInviteExpired,
} from "../../../src/shared/remote/proxyInvite.js";
import type { RemoteCryptoPrimitives } from "../../../src/shared/remote/crypto.js";

// 假 crypto：randomBytes 给确定值（每次自增），公钥固定 32 字节
function fakeCrypto(): RemoteCryptoPrimitives {
  let n = 0;
  return {
    randomBytes(len: number) {
      return Uint8Array.from({ length: len }, (_, i) => (n++ + i) & 0xff);
    },
  } as unknown as RemoteCryptoPrimitives;
}

const PUB = Uint8Array.from({ length: 32 }, (_, i) => 200 + (i % 50));

describe("proxyInvite（好友代理邀请码，issue #622 PR-C1）", () => {
  it("生成→编码→解码 往返一致", () => {
    const inv = createProxyInvite(fakeCrypto(), PUB, 1000);
    const text = encodeProxyInvite(inv);
    const back = decodeProxyInvite(text);
    expect(back).not.toBeNull();
    expect(back!.channelId).toBe(inv.channelId);
    expect([...back!.secret]).toEqual([...inv.secret]);
    expect([...back!.hostIdentityPub]).toEqual([...PUB]);
    expect(back!.createdTs).toBe(1000);
  });

  it("channelId 与 secret 每次随机（同一 crypto 连续两份不同）", () => {
    // 共享一个 crypto 实例——真实实现（noble/node）的 randomBytes 真随机，
    // 这里 fake 用自增序列模拟「连续两次结果不同」。各自新建 fake 会重置序列，
    // 那就成了「两份相同」，测的不是随机性
    const c = fakeCrypto();
    const a = createProxyInvite(c, PUB, 1);
    const b = createProxyInvite(c, PUB, 1);
    expect(a.channelId).not.toBe(b.channelId);
    expect([...a.secret]).not.toEqual([...b.secret]);
  });

  it("host 身份公钥不是 32 字节 → 生成直接抛", () => {
    expect(() => createProxyInvite(fakeCrypto(), Uint8Array.from([1, 2, 3]), 0)).toThrow(/32 字节/);
  });

  it("解码：前缀/段数/版本/长度不对 → null", () => {
    const good = encodeProxyInvite(createProxyInvite(fakeCrypto(), PUB, 5));
    expect(decodeProxyInvite("otto-pair:1:x:y:z:5")).toBeNull(); // 错前缀（那是扫码配对）
    expect(decodeProxyInvite("otto-proxy:1:only:three")).toBeNull(); // 段数不够
    expect(decodeProxyInvite(good.replace(":1:", ":99:"))).toBeNull(); // 版本不符
    expect(decodeProxyInvite("not-an-invite")).toBeNull();
    expect(decodeProxyInvite("")).toBeNull();
  });

  it("过期判断：默认 10 分钟 TTL", () => {
    const inv = createProxyInvite(fakeCrypto(), PUB, 1000);
    expect(proxyInviteExpired(inv, 1000 + PROXY_INVITE_TTL_MS - 1)).toBe(false);
    expect(proxyInviteExpired(inv, 1000 + PROXY_INVITE_TTL_MS + 1)).toBe(true);
    // 自定义 TTL
    expect(proxyInviteExpired(inv, 1000 + 500, 1000)).toBe(false);
  });
});
