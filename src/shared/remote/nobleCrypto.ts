// RemoteCryptoPrimitives 的**手机端**实现,纯 JS(@noble/*)。
//
// 为什么不是 react-native-libsodium(spec 原本写的那个,ADR-0102 推翻):
// 那个包的 **native** 那一半(lib.native.ts,真机上跑的就是它)缺三样我们必须有的东西 ——
// `crypto_scalarmult`(X25519 ECDH,一个都没有)、`crypto_aead_chacha20poly1305_ietf`
// (只有 24 字节 nonce 的 XChaCha,而我们的线格式是 12 字节 IETF)、`crypto_hash_sha256`。
// 它的 web 那一半(lib.ts,走 libsodium-wrappers)三样俱全 —— 照着文档验会全部通过,
// 到真机上才崩。
//
// noble 是纯 JS:不需要 native module,于是也不需要 `expo prebuild`,Expo Go 直接能跑。
// 性能上 X25519 每条连接一次、ChaCha 每帧一次而帧都很小,够用。
//
// **这个文件的正确性由"与 nodeRemoteCrypto 逐项互通"定义**,不是由"它自己能自洽"定义:
// 两端算不出同一把密钥的话,整条链路就是坏的。tests/shared/remote/nobleCrypto.test.ts
// 逐个原语交叉验:noble 签的 node 验、node 封的 noble 开、HKDF/SHA-256 逐字节相同。

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";

export function nobleRemoteCrypto(): RemoteCryptoPrimitives {
  return {
    randomBytes(n) {
      return nobleRandomBytes(n);
    },

    generateX25519(): KeyPair {
      const privateKey = x25519.utils.randomSecretKey();
      return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
    },

    x25519(privateKey, peerPublicKey) {
      // 低阶(如全零)对端公钥会让 noble 抛,和 node 的
      // ERR_OSSL_FAILED_DURING_DERIVATION 是同一类。两边都抛 = deriveSession
      // 里那一圈 try/catch 对两个实现同样有效(见 handshake.ts 的注释)
      return x25519.getSharedSecret(privateKey, peerPublicKey);
    },

    generateEd25519(): KeyPair {
      const privateKey = ed25519.utils.randomSecretKey();
      return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
    },

    ed25519Sign(privateKey, message) {
      return ed25519.sign(message, privateKey);
    },

    ed25519Verify(publicKey, message, signature) {
      try {
        return ed25519.verify(signature, message, publicKey);
      } catch {
        // 长度不对/点不在曲线上:那是"验不过",不是异常。
        // node 那侧的 verify 对同样的输入回 false,两个实现必须同型
        return false;
      }
    },

    hkdfSha256(ikm, salt, info, length) {
      return hkdf(sha256, ikm, salt, info, length);
    },

    sha256(data) {
      return sha256(data);
    },

    chachaSeal(key, nonce, plaintext) {
      return chacha20poly1305(key, nonce).encrypt(plaintext);
    },

    chachaOpen(key, nonce, box) {
      try {
        return chacha20poly1305(key, nonce).decrypt(box);
      } catch {
        return null; // 认证失败是常态分支(乱序/篡改),不是异常
      }
    },
  };
}
