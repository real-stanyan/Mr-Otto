// RemoteCryptoPrimitives 的桌面实现。非对称那半走 node:crypto,
// **AEAD 那半走 @noble/ciphers** —— 后者不是偏好,是被 Electron 逼的,见下。
//
// 为什么是 ChaCha20-Poly1305 而不是 AES-GCM:三家的交集在这里。
// node ✅ / CryptoKit ChaChaPoly ✅ / @noble/ciphers ✅,
// 而 AES-GCM 在 libsodium 那侧要 AES-NI 硬件支持,ARM 上
// crypto_aead_aes256gcm_is_available() 会回 false(spec 第二节订正)。
//
// ── 为什么 AEAD 不用 node:crypto ──
//
// **Electron 链的是 BoringSSL,不是 OpenSSL。** BoringSSL 只在 AEAD API 里
// 提供 ChaCha20-Poly1305,没把它注册进 EVP_get_cipherbyname 那张表,于是
// `createCipheriv("chacha20-poly1305", …)` 在 Electron 里直接抛 `Unknown cipher`。
// 实测 Electron 43.4.0:`crypto.getCiphers()` 里含 "chacha" 的条目**一个都没有**;
// 同一行代码在 Node 22 上正常。
//
// 这个缺陷单测抓不到 —— vitest 跑在真 Node 上,2680 条全绿,而产品在 Electron 里
// 一帧都加不了密。真机联调时它伪装成了"网络断流":异常从 SSE 读循环里窜出来,
// 被外层 catch 当成连接错误。守它的可执行版在 tests/architecture.test.ts。
//
// 主进程组装根特权:允许直接 import node builtin(src/shared 那边不行)。

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";

const TAG_BYTES = 16;

/** node 的 KeyObject ⇄ 原始字节。接口收原始字节是为了 RN 侧也能实现,
    代价是每次用都要重新包一层 DER —— 握手一轮几次调用,可忽略 */
const DER_PREFIX = {
  x25519Priv: Buffer.from("302e020100300506032b656e04220420", "hex"),
  x25519Pub: Buffer.from("302a300506032b656e032100", "hex"),
  ed25519Priv: Buffer.from("302e020100300506032b657004220420", "hex"),
  ed25519Pub: Buffer.from("302a300506032b6570032100", "hex"),
} as const;

function privKey(raw: Uint8Array, kind: "x25519Priv" | "ed25519Priv"): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([DER_PREFIX[kind], Buffer.from(raw)]),
    format: "der",
    type: "pkcs8",
  });
}

function pubKey(raw: Uint8Array, kind: "x25519Pub" | "ed25519Pub"): KeyObject {
  return createPublicKey({
    key: Buffer.concat([DER_PREFIX[kind], Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function rawOf(k: KeyObject, kind: "private" | "public"): Uint8Array {
  const der = k.export(
    kind === "private" ? { format: "der", type: "pkcs8" } : { format: "der", type: "spki" }
  ) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32)); // 两种曲线的原始密钥都是尾部 32 字节
}

function generate(type: "x25519" | "ed25519"): KeyPair {
  // 不能把联合类型的 `type` 直接传给 generateKeyPairSync —— 它按字面量类型重载,
  // 联合类型进去会让 TS 的重载解析滑到无关的重载(报错信息里那串 slh-dsa 就是证据),
  // 所以在这里按分支各自传字面量
  const { privateKey, publicKey } =
    type === "x25519" ? generateKeyPairSync("x25519") : generateKeyPairSync("ed25519");
  return { privateKey: rawOf(privateKey, "private"), publicKey: rawOf(publicKey, "public") };
}

export function nodeRemoteCrypto(): RemoteCryptoPrimitives {
  return {
    randomBytes: (n) => new Uint8Array(randomBytes(n)),

    generateX25519: () => generate("x25519"),
    x25519: (priv, peerPub) =>
      new Uint8Array(
        diffieHellman({ privateKey: privKey(priv, "x25519Priv"), publicKey: pubKey(peerPub, "x25519Pub") })
      ),

    generateEd25519: () => generate("ed25519"),
    ed25519Sign: (priv, msg) =>
      new Uint8Array(edSign(null, Buffer.from(msg), privKey(priv, "ed25519Priv"))),
    ed25519Verify: (pub, msg, sig) => {
      // 畸形公钥会让 createPublicKey 抛。验签失败是常态分支(公钥 pin 不上就是要走到这),
      // 不能让它变成异常把整条连接炸掉
      try {
        return edVerify(null, Buffer.from(msg), pubKey(pub, "ed25519Pub"), Buffer.from(sig));
      } catch {
        return false;
      }
    },

    hkdfSha256: (ikm, salt, info, length) =>
      new Uint8Array(hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), length)),
    sha256: (data) => new Uint8Array(createHash("sha256").update(Buffer.from(data)).digest()),

    // noble 的 encrypt 已经把 tag 接在密文尾部,和 node 那版的线格式一致
    chachaSeal: (key, nonce, plaintext) => chacha20poly1305(key, nonce).encrypt(plaintext),
    chachaOpen: (key, nonce, box) => {
      if (box.length < TAG_BYTES) return null;
      try {
        return chacha20poly1305(key, nonce).decrypt(box);
      } catch {
        return null; // 认证失败是常态分支(乱序/篡改),不是异常
      }
    },
  };
}
