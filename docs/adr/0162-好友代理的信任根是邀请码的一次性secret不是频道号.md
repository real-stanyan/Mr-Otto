# ADR-0162：好友代理的信任根是邀请码里那把一次性 secret，不是频道号

> 原为 ADR-0161。合并前重新 fetch 时发现 #658 那条 lane 的 0161 已经先落 main（项目 ADR-0074：编号在合并时claim，不在开分支时）。提交信息改不了，所以留这一行让旧引用还查得回来。

- 状态：已接受
- 日期：2026-08-28
- 关联：issue #657（收尾任务）、#622（需求与决策表）；ADR-0151（好友代理架构宪法，
  本决策补它留空的那一格）；ADR-0095（自远程的 TOFU 与它的后果表）；
  issue #583 / `src/shared/remote/pairing.ts`（扫码配对——本决策直接复用它的机制）

## 背景

ADR-0151 定下「信任来源是密码学身份（pin 公钥），friendships 只是授权目录」，
并把首次 pin 交给「邀请码路径」。到 #656 合并为止，邀请码路径只做了一半：

`proxyInvite` 生成了 `{ channelId, secret, hostIdentityPub }` 三样，B 拿到后
**用了前两样里的 channelId 和第三样**（连房间、pin A 的公钥），
而那把 `secret` 一次都没被验过——`proxyManager` 里 host 侧写的是
`peerIdentityPub: () => []`，注释里承认「握手时由 secret 证明（pairing 机制）」，
但 `proxyConnection` 从没接上 `pairing.ts`。

后果不是「少一层校验」，是**没有校验**：A 的 host 连接会接受任何连进这个 relay
房间的 guest，然后按白名单用**A 自己的 Shopify / Google Ads 凭证**替它执行。
channelId 是随机 32 字节，难猜是真的；但难猜是**缓解**，不是**认证**——
它出现在 relay 的 URL query 里、出现在两端的日志里、也出现在 A 发给 B 的那条 DM 里。
「知道频道号」和「是被邀请的那个 B」之间没有任何密码学联系。

## 决策

**握手层认人，认的是「谁能对邀请码里那把一次性 secret 签出名」。**

机制早就写好了，只是没接：`pairing.ts` 的 `buildPairProof` / `verifyPairProof`，
`HandshakeHello` 里预留的 `identityPub` / `pair` 两个字段。接法与 `remoteBridge`
那条已经真机验证过的路一模一样：

1. **B（guest）**：`buildHello` 带 `pair` —— 用邀请码的 secret 对
   「角色 + deviceId + secret + 这一轮的 ephPub + 自己那半个 nonce」签名。
   secret 进签名而不上线（中继看不到它）；eph/nonceHalf 进签名，所以证明绑死这一次连接，
   截走了换到另一条连接上也用不了。
2. **A（host）**：先逐把试已 pin 的公钥（`deriveSession` 自带签名校验）；
   **全验不过才**轮到邀请路径 —— 拿手里那张还活着的邀请验 `pair`，
   **验过才 pin、才作废那张邀请、才 `deriveSession`**。
3. 顺序是「先落 pin 再作废」：反过来的话，中间崩一下就成了「邀请没了也没配上」。

`hello.identityPub` 是 B **自称**的公钥。它不是「查表查出来的可信值」，
而是**验签的输入**：冒名者填自己那把，就得用自己那把私钥对含 secret 的载荷签名，
而它没有 secret。所以「自称」在这里不构成弱点——这与 `pairing.ts` 头注里
「目录不是信任来源」是同一条推理，只是把「Supabase 的 devices 表」换成了「relay 的房间」。

### 长期信任落在 pin，不落在邀请码

邀请码是一次性的、10 分钟就过期（`PROXY_INVITE_TTL_MS`）。所以 `proxyStore`
多两个字段：

- `pins`：验过证明之后落下的好友身份公钥。B 重连、A 重启都走这条，不再消耗邀请。
- `channels`：A 给这个好友开的 relay 频道 id。**要落盘**——channelId 是随机生成的，
  不落盘的话 A 一重启就找不回来了，而「每次重开 app 都让用户重发一张邀请」不是产品。
  频道 id 本身不是凭证（知道它只能 attach 到房间，握不了手），落盘不构成新的泄漏面。

**secret 不落盘。** 一次性的东西落了盘就不是一次性的了；它只活在 A 那次
`proxyCreateInvite` 的闭包里，用掉或过期就没了。

### 撤销 = 授权、pin、频道一起清

`revokeGrant` 三个都删。只删授权的话，那条通道还随时能重新握手，只差 A 再点一次
「分享」——那不是用户按下「撤销」时想要的。要重新给，重发一张邀请码，
而那本身就是一次有意识的授权动作。

## 后果

| | |
|---|---|
| ✅ | 拿到 channelId 的人连不上：`tests/main/proxyConnection.test.ts` 与 `tests/main/proxyManager.test.ts` 各钉一条「不带证明 / 错 secret / 邀请已作废」的拒绝路径 |
| ✅ | A 不认 B 时是**单向**没通：B 那侧会 ready（它从邀请码里 pin 了 A），但 A 一帧都不发给它——授权清单到不了，proxy_req 也没人执行 |
| ✅ | 复用同一份 `pairing.ts`，自远程与好友代理的信任建立只有一套逻辑、一处修 |
| ⚠️ | 邀请码本身仍是**带外凭证**：谁拿到谁就能配对。10 分钟 TTL + 一次性 + 「只发给本人」的界面提示是全部缓解。这与扫码配对的取舍一致（二维码被拍走也是同一件事） |
| ⚠️ | B 侧不持久化：B 重启后要重新走一次邀请码。A 侧的 `resumeHosts()` 已经让 A 成为「一直在场的房东」，B 侧对称的那一半等 B 侧把代理 MCP 接进会话 world 时一并做（issue #657 未完项） |
| ❌ | 不做「逐次调用审批」：白名单内全自动是 ADR-0151 的既定取舍，本决策不改它。界面上如实说「圈中的工具对方随时能调、不再逐次问你」，并把每一笔记进审计账 |

## 被否掉的路

- **靠 friendships 判断**（B 是不是 A 的好友 → 放行）：目录不是信任来源，
  拿到库的人插一行就成立；而且 relay 是盲管道，不该知道什么叫好友（ADR-0151 第 1 条）。
- **靠 channelId 的不可猜性**：即「现状」。它是缓解不是认证，理由见背景。
- **给每个好友一把长期共享密钥**：等于把一次性 secret 变成长期 secret，
  丢一次就永久失守；而 pin 公钥的做法丢了也只是丢公钥。
