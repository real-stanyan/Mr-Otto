# ADR-0102：手机端的加密原语用纯 JS 的 @noble/*，不用 react-native-libsodium

日期：2026-08-25
状态：已接受（推翻 spec 第二节末尾那句「Expo 侧仍需 `react-native-libsodium`」）
相关：ADR-0095（中继与 E2E）、ADR-0097（一套 AEAD 两把寿命不同的密钥）、ADR-0100（在场信号）

## 背景

`RemoteCryptoPrimitives`（`src/shared/remote/crypto.ts`）是一个恰好十个成员的接口：
桌面用 `node:crypto` 实现（`remoteCryptoNode.ts`，零新依赖），手机端本来计划用
`react-native-libsodium` 实现——理由是 RN 没有 `node:crypto`，而 libsodium 三样俱全。

开工前照例先验一遍，把包装上读它的导出面。**结论是这条路走不通。**

`react-native-libsodium@1.7.0` 有两个实现文件：

- `src/lib.ts` —— web / JS 那一半，背后是 `libsodium-wrappers`
- `src/lib.native.ts` —— **真机上跑的那一半**，走 JSI 打到原生

前者三样俱全。后者，也就是 iPhone 上真正执行的那个，缺我们必须有的三样：

| 需要的 | native 那半有没有 |
|---|---|
| `crypto_scalarmult` / `_base`（X25519 ECDH） | **完全没有** |
| `crypto_aead_chacha20poly1305_ietf_*`（12 字节 nonce） | 没有；只有 **X**ChaCha（24 字节 nonce） |
| `crypto_hash_sha256` | 没有；只有 `crypto_generichash`（BLAKE2b） |

X25519 那条是死路：`crypto_box_easy` 不是裸 ECDH，拿不到那 32 字节共享秘密，
而会话密钥的整个派生都建在它上面。

这个包最阴险的地方是**照文档验会全部通过**：`lib.ts` 导出得好好的，
Node 里 import 也跑得通，要到真机上才崩。

## 决定

手机端用 **`@noble/curves` + `@noble/hashes` + `@noble/ciphers`**（纯 JS）实现同一个接口，
落在 `src/shared/remote/nobleCrypto.ts`。

十个原语一一对上，且**逐项与 `node:crypto` 交叉验过**
（`tests/shared/remote/nobleCrypto.test.ts`）：X25519 共享秘密逐字节相同、
Ed25519 互签互验、HKDF-SHA256 与 SHA-256 逐字节相同、ChaCha20-Poly1305-IETF
一边封另一边开、被改一位的签名/密文两边同样回 false/null。最后一条把
`handshake.ts` 与 `sealedStream.ts` 一起拉进来跑整轮：一端全 node、一端全 noble，
两个方向的帧都解得开，6 位安全码两端算出来一样。

**这个文件的正确性由"与 nodeRemoteCrypto 互通"定义，不由"它自己自洽"定义**——
两端算不出同一把密钥的失败方式是"连上了、解不开"，最难查的那一种。

## 代价与收益

**代价：纯 JS 比原生慢。** 数量级上无所谓：X25519 每条连接一次，ChaCha 每帧一次
而帧都是几百字节到几 KB。真到了瓶颈再换 `react-native-quick-crypto` 之类，
接口不用动——这正是当初把加密收窄成十个成员的原因。

**收益：不需要 native module。** 于是也不需要 `expo prebuild`，Expo Go 直接能跑。
交接 issue #418 里记的「`expo prebuild` 是重议仓库形态的时点」因此**往后挪**：
触发它的只剩计划 C 的 APNs / NSE，而不是加密。

**顺带**：同一份 `nobleCrypto.ts` 住在 `src/shared/remote/` 里，
于是它的互通测试跑在**根门禁**里，不依赖 `mobile/` 的 CI 怎么接
（那个问题仍然悬着，见 #418）。

## 什么前提被推翻时该重议

- `react-native-libsodium` 的 native 那半补齐了 `crypto_scalarmult` 与 IETF ChaCha
  （那时换回去能省下纯 JS 的开销，但要重新做一遍交叉验）
- 帧大小或频率涨到纯 JS 的 ChaCha 成为瓶颈（先量，再换实现，接口不动）
