# 同一台机器上开两个账号

德州要 ≥2 人（#48），好友系统的验收也要两个真账号（#34）。一个人测就得同时跑两个实例、登两个号。

## 数据隔离

`OTTO_PROFILE` 换掉 userData 目录：

```bash
npm run dev                    # ~/Library/Application Support/mr-otto
OTTO_PROFILE=b npm run dev     # ~/Library/Application Support/mr-otto-b
```

不设就是原来的目录，老数据原地不动。目录名只接受 `[a-zA-Z0-9_-]`，非法字符直接报错而不是静默清洗——它要拼进文件系统路径。

隔离的是 `auth.json`（登录态）、`sessions.db`（会话日志）、`keys.json`、`attachments/`。不隔离的是服务端：两个实例连的是同一个 Supabase 和同一个网关，这正是要测的东西。

## 登录必须一个一个来

`mrotto://auth-callback` 这个 scheme，macOS 只会交给一个实例。两个 dev 用的是同一个 Electron bundle，交给谁不由我们定。所以：

1. 只开实例 A（`npm run dev`），登账号 1，**退出**
2. 只开实例 B（`OTTO_PROFILE=b npm run dev`），登账号 2，**退出**
3. 两个一起开——各自从自己的 `auth.json` 恢复登录态，不再需要深链

只有 OAuth 那一步碰深链，恢复不碰。稳态并行没问题。

## 之后

两个号互加好友（邮箱精确搜索），一个建桌另一个入座，就能开牌了。注意好友门是**对在座每一个人**，不是只对建桌人。

## 已知边界

- 两个实例的 vite dev server 端口会自动错开，不用管。
- 两个实例的**通知/焦点抢夺**没做隔离，深链回调成功后会 `app.focus({steal:true})`——但按上面的顺序登录不会触发这条路径。
- 一个人开两个号打牌，两边都是你自己的钱包桶。输赢在你自己两个账号之间流转，净额守恒（ADR-0022），不会凭空多出或消失。
