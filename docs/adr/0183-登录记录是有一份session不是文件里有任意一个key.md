# ADR-0183：「登录记录」是有一份 session，不是 auth.json 里有任意一个 key

- 状态：已接受
- 日期：2026-08-29
- 关联：issue #729；**收紧 ADR-0182**（进门闸的判据那一条，其余不变）

## 背景

ADR-0182 把进门闸的判据定成「这台机器上有没有登录记录」，实现是
`authStorage.hasAny()` —— **文件里存着任意一个 key 就算有**。合并当天就被实测绕过。

维护者在 main 上跑 `npm run dev`：侧栏底部明明写着「未登录 · 点击登录」，登录闸却没有
出现，整个 app 照常可用。查 `~/Library/Application Support/mr-otto-dev/auth.json`，
里面**一份 session 都没有**，只有三条：

```
sb-otto-auth-auth-token-code-verifier
sb-otto-auth-auth-token-flows-code-verifier
sb-otto-auth-auth-token-flow-<hash>-code-verifier
```

两件事叠在一起，任何一件单独都足以让 0182 的判据失效：

1. **`-code-verifier` 是「点了一次 OAuth 然后放弃」留下的。** supabase 在
   `signInWithOAuth` **一开始**就往 `<storageKey>-code-verifier` 写一笔（换 code 时
   再读回来，`GoTrueClient.js:3354`）。它证明有人点过按钮，不证明登录成功过 ——
   而这正是 0182 的判据认不出来的区别。
2. **`sb-otto-auth-*` 是已退役的自托管项目**（ADR-0098 迁到 Supabase Cloud 之前那套）。
   哪怕它下面真有 token，也换不出当前项目的 user。

0182 的推理没错（闸门必须同步、离线可答，所以停在本地文件层，不能看 `signedIn`），
错的是「本地文件层」这一层被读成了「文件非空」而不是「里面有东西可用」。

## 决策

判据收紧成：**auth.json 里存着一份 session** —— 存在某个 key 满足

- key 里**不含 `code-verifier`**，且
- 值能 `JSON.parse` 成对象，且带**非空 `access_token`**

`hasAny()` 换成 `hasSession()`。0182 的其余部分（闸门位置、`needsSignIn`、
背景沿用 Splash 那套、离线放行的取舍）一概不动。

### 为什么按形状判，不按 key 名硬拼

supabase 的 key 是可以算出来的 —— `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
（`supabase-js/dist/index.mjs` 的 `defaultStorageKey`），对本项目就是
`sb-kpeemypbhkynapkjzewr-auth-token`。硬拼这把 key 更精确，但它的失败模式无法接受：

**supabase 哪天改了 key 方案，用户会掉进「登录了也进不去」的死循环** —— 新 token 写在
新 key 下，我们按老 key 查永远查不到，于是登录成功、闸门照旧、再登一次、再照旧。
一个只能靠删配置目录逃出来的循环。

按形状判的退化方向相反：最坏情况是**多认一份退役项目的旧 token**。那个人进得来，
但进去之后处处是未登录态（账号页画的还是登录卡）—— 这正是 0182 已经决定要放行的
那一类人（离线 / session 过期），不是新增的风险面。

一句话：这两条路一个失败在「把人锁在外面」，一个失败在「多放进来一个本来就该放的人」。

## 后果

- e2e 播的那条记录得跟着改形状（带 `access_token`），但 **key 仍然刻意不用
  `sb-<ref>-auth-token`** —— 写成 supabase 认得的 key，supabase-js 会拿着这把假 token
  去刷新，e2e 就真的出网了，而那套用例的第一条规矩是不碰网络。闸门按形状认、不按
  key 名认，所以这两个约束正好能同时满足。
- 判据是纯函数、真实文件验得动：本机两份 profile 实测 `mr-otto-dev → false`
  （只有 code-verifier 残留）、`mr-otto → true`（有当前项目的真 session）。

## 教训

`hasAny()` 那个名字本身就是味道 —— 它描述的是**实现**（Object.keys 非空），不是**意图**
（有没有登录过）。名字停在实现层，判据就容易停在实现层；`hasSession()` 这个名字写不出
「随便有个 key 就行」的实现。
