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
