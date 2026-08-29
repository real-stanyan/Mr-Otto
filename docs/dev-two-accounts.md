# 同一台机器上开两个账号

好友系统的验收要两个真账号（#34）：加好友、私信、在线点，每一条的两端都在 RLS 的两侧，
自己给自己发不算验过。一个人测就得同时跑两个实例、登两个号。

## 数据隔离

`OTTO_PROFILE` 换掉 userData 目录：

```bash
npm run dev                    # ~/Library/Application Support/mr-otto
OTTO_PROFILE=b npm run dev     # ~/Library/Application Support/mr-otto-b
```

不设就是原来的目录，老数据原地不动。目录名只接受 `[a-zA-Z0-9_-]`，非法字符直接报错而不是静默清洗——它要拼进文件系统路径。

隔离的是 `auth.json`（登录态）、`sessions.db`（会话日志）、`keys.json`、`attachments/`。不隔离的是服务端：两个实例连的是同一个 Supabase 和同一个网关，这正是要测的东西。

**自 ADR-0187 起，隔离还多了一层**：本机数据按**登录账号**分抽屉，`OTTO_PROFILE` 之内又切了一刀。

```
~/Library/Application Support/mr-otto-b/
  auth.json                        ← 留在根（uid 从这儿读）
  accounts/<sha256(uid) 前16位>/     ← sessions.db、keys.json、attachments/…

~/.mr-otto/accounts/<同一个抽屉名>/   ← memories/、mcp.json、mcp-auth.json、skills/、agents/
```

所以这一节以前那句「用 `OTTO_PROFILE=b` 起的 B 实例**共用同一份** mcp.json」**已经不成立了**——
`~/.mr-otto/` 那一层过去连 `OTTO_PROFILE` 都不分（记忆和 MCP 令牌一直是两个实例共享的，
这正是 #749 的一半），现在按账号分开了。要验「B 调的是 A 的凭证」，两边本来就各配各的 MCP。

抽屉名是 uid 的哈希，人认不出来。每个抽屉里有一张 `who.txt`（邮箱 + uid）——
`grep -r . ~/.mr-otto/accounts/*/who.txt` 就知道哪间是谁的。界面上凡是说
「去哪个目录手改」的地方也都显示真路径（`configRoot`），不再是写死的 `~/.mr-otto/…`。

**换号会重启**：登录一个和开机时不同的账号，app 会 `relaunch` 一次去换抽屉。
按下面的顺序登录不受影响（每个实例开机时 `auth.json` 里就是它自己那个号）。

## 登录必须一个一个来

`mrotto://auth-callback` 这个 scheme，macOS 只会交给一个实例。两个 dev 用的是同一个 Electron bundle，交给谁不由我们定。所以：

1. 只开实例 A（`npm run dev`），登账号 1，**退出**
2. 只开实例 B（`OTTO_PROFILE=b npm run dev`），登账号 2，**退出**
3. 两个一起开——各自从自己的 `auth.json` 恢复登录态，不再需要深链

只有 OAuth 那一步碰深链，恢复不碰。稳态并行没问题。

## 之后

两个号互加好友（邮箱精确搜索）：A 发申请 → B 收到 → B 接受，然后私信、在线点、分支徽章
都有了两端。想验 RLS 挡没挡住，把其中一边退成陌生人再看同一个界面——那才是第三个视角。

## 已知边界

- 两个实例的 vite dev server 端口会自动错开，不用管。
- 两个实例的**通知/焦点抢夺**没做隔离，深链回调成功后会 `app.focus({steal:true})`——但按上面的顺序登录不会触发这条路径。
- 两个号的额度桶各算各的（注册赠额是按用户发的），一边跑干了不影响另一边——所以拿它验 402 只能验一边。

## 好友代理的两账号验收（issue #622 / #657，ADR-0151 / ADR-0162）

前置：两个号已经互为好友（上一节），A 那台至少接通一台 MCP server
（`~/.mr-otto/accounts/<A 的抽屉>/mcp.json` —— 自 ADR-0187 起 A 和 B 各有各的一份，
不再共用，所以「B 调的是 A 的凭证」天然可验：B 那边根本没配过那台 server；
想再确认一次就看 A 的审计账里有没有记上那一笔）。

1. **A 授权**：好友区把鼠标停在 B 那一行 → 钥匙图标 → 勾服务/勾工具 → 「生成邀请码」→ 复制。
   邀请码 10 分钟有效、一次性。
2. **带外发给 B**：私信、粘贴板，都行——它就是一把钥匙，走什么通道由人决定。
3. **B 接受**：好友区底下「好友代理…」→「接受邀请」页 → 粘贴 → 接受。
   界面显示「已连上，等对方推来授权清单」= 握手过了、A 已经 pin 住 B。
4. **看 A 那边落了什么**：`~/Library/Application Support/mr-otto/accounts/<A 的抽屉>/proxy-store.json`
   （0600）里应当出现这个好友的 `grants` / `pins` / `channels` 三条。
   **`pins` 是关键**——它在的意思是「A 验过了 B 对邀请码 secret 的持有证明」，
   不在就说明握手没走通（见 ADR-0162）。
5. **撤销**：A 的「已授权」页点撤销 → 三条一起没，B 那条通道当场失效。
6. **审计**：同一页「查看记录」。放行与拒绝都记，拒绝还带人话原因。

### 先单验中继那一层

上面第 3 步不通时，先分清是「中继没把两个不同用户放进同一个房间」还是「握手没过」：

```bash
SUPABASE_JWT_SECRET='...' node services/edge/checks/relay.mjs
```

它里面有一段专门打好友代理的路由（`?channel=` + host/guest + 两个不同 uid）。
那几条绿了，问题就在握手层，不在中继。

### 还没做的那一半

B 侧拿到的代理 MCP **还没接进会话的 world**——也就是说第 3 步之后 B 那边的水獭
暂时还调不到 A 的工具（proxyMcp 已经就位，缺的是把它换进 ExecutionWorld 的那一步）。
B 侧也不持久化：B 重启要重新走一次邀请码。见 issue #657。
