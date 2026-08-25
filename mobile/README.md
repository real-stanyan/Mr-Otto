# mobile —— Mr Otto 的手机端（Expo / React Native）

范围只有两件事：**看**当前会话的时间线，**审批**危险操作（ADR-0094 / 0096）。
不建会话、不改设置、不切模型、不管 MCP。

**规则不写在这里。** 全仓唯一的事实源是根目录的 `AGENTS.md`。（Expo 模板会往
子目录塞一份自己的 `AGENTS.md` + `CLAUDE.md`，已删掉——两份规则等于没有规则。
模板里那句提醒本身是对的，抄在下面。）

> Expo 变化很快。写代码前先读对应版本的文档：https://docs.expo.dev/versions/v57.0.0/

## 跑起来

```bash
npm --prefix mobile install
npm --prefix mobile start        # 扫码用 Expo Go 打开
```

**不需要 `expo prebuild`。** 加密走纯 JS 的 `@noble/*`（ADR-0101），没有 native
module，Expo Go 直接能跑。要 prebuild 的只剩计划 C 的 APNs / NSE。

## 登录（Google / GitHub）

和桌面同一个 Supabase 项目、同一套 PKCE，代码在 `src/oauth.ts`。
邮箱密码那条路留着但收进折叠里：**这个账号体系里注册走的是 OAuth**，
用 Google 注册的账号根本没有密码，只留密码登录的话它永远登不进来。

回跳地址是 `Linking.createURL("auth-callback")`，**两种运行形态给出的值不一样**：

| 形态 | 回跳地址 |
|---|---|
| Expo Go | `exp://<局域网 IP>:8081/--/auth-callback`（IP 随网络变） |
| 独立构建 | `mrotto://auth-callback` |

两者都必须进 Supabase → Authentication → URL Configuration → **Redirect URLs**，
否则 GoTrue 会悄悄回落到 SITE_URL，表现为「授权页转完圈却没回到 app」。
开发期加 `exp://**`，发布前删掉；`mrotto://**` 长期留着。
失败信息里会把当前这台机器算出来的地址原样打出来，照抄进白名单即可。

## 和桌面共用的那一份代码

`src/shared/remote/` 里的东西手机端**直接 import 同一份文件**，不是抄一份：
帧的编解码、握手、密封流、base64url。那一层不许碰 node builtin / electron，
由 `tests/architecture.test.ts` 钉着。

metro 需要两处配置才吃得到它们（见 `metro.config.js`）：仓库根进 `watchFolders`，
以及把 `./x.js` 解析到 `./x.ts`（仓库按 ESM 风格写 `.js` 后缀，磁盘上是 `.ts`）。

## 类型检查

```bash
npm --prefix mobile run typecheck
```

**暂时不在根门禁里**——根 `tsconfig.json` 排除了 `mobile/`。这是临时状态，
原因和三条备选路都记在 issue #422（Protocol gap）。
