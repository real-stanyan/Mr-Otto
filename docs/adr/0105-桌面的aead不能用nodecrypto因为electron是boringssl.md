# ADR-0105：桌面的 AEAD 不走 node:crypto —— Electron 链的是 BoringSSL

日期：2026-08-25
状态：已接受

## 背景

`src/main/remoteCryptoNode.ts` 用 `createCipheriv("chacha20-poly1305", …)` 实现
`RemoteCryptoPrimitives` 的 AEAD 那一半，理由写在文件头注里：零新 npm 依赖。

真机联调（桌面 ↔ iPhone 真机 build）时，桌面侧每次握手都失败。日志上的表现是
一条条断线加退避重连：

```
远程桥:对端到场,开一轮握手
远程传输:流断了
远程传输:1000ms 后重连
```

排查先去了网络那一侧，全是好的：VPS 上对公网地址开长连接，`:ok` 72ms 到、心跳
25s 一条准时、活过 100s 不断；`checks/relay.mjs` 11/11 过；网关 55 分钟没重启。

真正的原因要等把那个空 `catch` 补成记录错误名才看得见：

```
远程传输:流断了(活了 380ms,Error: Unknown cipher)
```

`Unknown cipher` 是 node:crypto 的错，不是断线。

## 结论（实测）

Electron 43.4.0：

```
有 chacha20-poly1305 吗: false
含 chacha 的: []
createCipheriv 抛: Unknown cipher
```

同一行代码在 Node 22 上是 `true`。

**Electron 链的是 BoringSSL，不是 OpenSSL。** BoringSSL 只在 AEAD API
（`EVP_aead_chacha20_poly1305`）里提供 ChaCha20-Poly1305，没把它注册进
`EVP_get_cipherbyname` 那张表，而 node:crypto 的 `createCipheriv` 查的正是那张表。

## 决定

桌面侧的 `chachaSeal` / `chachaOpen` 改用 `@noble/ciphers` 的 `chacha20poly1305`
（纯 JS，和手机端 `src/shared/remote/nobleCrypto.ts` 同一份实现，字节兼容，
线格式一致：tag 接在密文尾部）。非对称那半（Ed25519 签名、X25519 ECDH、HKDF、
SHA-256）继续走 node:crypto —— 那些在 Electron 里都正常。

算法选型不变，仍是 ChaCha20-Poly1305（ADR-0094）：换的是**由谁实现**，不是换算法。

## 代价

- 桌面多一个运行时依赖（`@noble/ciphers` 本来就在根 `dependencies` 里，因为
  `src/shared/remote/nobleCrypto.ts` 要用）
- 纯 JS 实现比 BoringSSL 的汇编慢。这条链路上无所谓：一帧是一份 fleet 快照，
  几百字节，一秒最多几帧
- `nodeRemoteCrypto` 不再是"全部走 node:crypto"，头注已订正

## 更要紧的那一半：门禁跑在错误的运行时上

这个缺陷让 **2680 条单测全绿而产品一帧都加不了密**。vitest 跑在真 Node（OpenSSL）
上，Electron 的 BoringSSL 永远不在测试范围内。这不是"忘了写测试"，是**测试运行时
和产品运行时是两个东西**——凡是依赖宿主 crypto/网络栈能力的代码，单测都给不出保证。

守它的可执行版放在 `tests/architecture.test.ts`：`remoteCryptoNode.ts` 里再出现
`createCipheriv` / `createDecipheriv` 就红，错误信息带修法。这是**静态**守卫，
守不住"BoringSSL 还缺别的什么"——那一类只能靠 `tests/e2e/`（真跑 Electron）或真机验收。

## 连带修掉的一条：回调异常伪装成断线

`remoteTransport.ts` 的 SSE 解析器是在读循环里**同步**调 `onPeer()` / `onMessage()` 的。
桥里抛的异常会一路窜出 `reader.read()` 的循环，落进那个本来只该接网络错误的
`catch`，于是被报成"流断了"并触发退避重连——连接其实好端端的。

这一条把排查带偏了一整轮。现在回调异常单独落地（`guard()`），日志明说"不是断线"，
流也不再陪葬：一帧解不开不该让整条连接一起死（`sealedStream` 本来就按帧丢弃）。

同时那个空 `catch` 改成记录错误名 + 存活毫秒数。**空 catch 在跨机器的链路上是
不可接受的**：断在第几秒、被谁断的，是唯一能把"网络问题"和"我的 bug"分开的信息。
