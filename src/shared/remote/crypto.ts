// 密码学原语的注入接口。这里只有类型，零实现——
// 桌面用 node:crypto（src/main/remoteCryptoNode.ts），手机用 react-native-libsodium，
// 而握手/流封装那些**我们自己写的逻辑**只依赖这个接口，因此可以在单测里
// 用假原语跑，既不慢也不把平台依赖拖进 src/shared。
//
// 纯文件：不许 import node builtin / electron。

export interface KeyPair {
  /** 原始字节，不是 KeyObject —— 接口要能被 RN 侧实现 */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface RemoteCryptoPrimitives {
  randomBytes(n: number): Uint8Array;

  generateX25519(): KeyPair;
  /** 原始 32 字节共享秘密（未经 KDF，调用方必须再过 HKDF） */
  x25519(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array;

  generateEd25519(): KeyPair;
  ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array;
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;

  /** ChaCha20-Poly1305-IETF。nonce 恒为 12 字节，返回 密文||16 字节 tag */
  chachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** 认证失败回 null,不抛 —— 解密失败是常态分支(乱序/篡改),不是异常 */
  chachaOpen(key: Uint8Array, nonce: Uint8Array, box: Uint8Array): Uint8Array | null;
}
