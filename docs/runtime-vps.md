# 云 runtime：VPS 部署与真机手验清单

（ADR-0199）云 runtime（`services/runtime/`）是工作区群聊云会话的执行面：跑在 VPS 上的
daemon，装配现有 agent 核心 + DockerWorld，权威 EventStore 落 VPS 本地 SQLite。本文档三件事：
① 首次部署怎么做，② 部署完怎么用真机验一遍关键面（DockerWorld / 审批 / 踢人 / 沙箱生命周期
/ 计量），③ 出问题怎么回滚。

内容与 `services/runtime/src/config.ts`、`scripts/runtime-deploy.mjs`、
`deploy/otto-runtime.env.example`、`deploy/otto-runtime.service` 逐项对齐——改了这几个文件
记得回来同步这份文档，不要让手验清单和代码现状脱节。

## 1. 首次部署

### 1.1 env 文件：`/etc/otto-runtime.env`

`services/runtime/src/config.ts` 的 `REQUIRED_KEYS` 缺一个，daemon 启动就打印缺了哪几个
并 `exit(1)`（fail fast——不会带着半份配置悄悄跑起来）。`deploy/otto-runtime.env.example`
是这份清单的模板，拷到 VPS 的 `/etc/otto-runtime.env` 再填真值（真值不进本仓，只有键名 +
占位符进 git）：

| env | 从哪取值 |
|---|---|
| `RUNTIME_SECRET` | 与 edge worker 的 `RUNTIME_SECRET` **同一个值**：先在 `services/edge/` 跑 `npx wrangler secret put RUNTIME_SECRET` 生成/记下这个值，再原样填进这里。这是 runtime 向 edge 自证「平台身份」的共享密钥（`services/edge/src/worker.ts` 的 `RUNTIME_SECRET` 字段），px 三道闸的执行调用与 relay 连接数豁免（见下方手验条目⑧）都靠它 |
| `SUPABASE_JWT_SECRET` | Supabase Dashboard → Settings → API → JWT Settings 里的 **legacy JWT secret**（HS256）。与 edge worker 用的是同一个值（`services/edge/README.md`「部署」一节写明了这条）——项目的签名 key 必须停在 legacy HS256 那把，否则 runtime 验不出桌面/手机发来的登录 JWT |
| `SUPABASE_URL` | Supabase 项目后台 → Settings → API |
| `SUPABASE_SERVICE_KEY` | 同上页面的 service role key——查 `workspace_members` 在籍、写 `usage_ledger` 都要绕过 RLS，必须用 service key 不是 anon key |
| `EDGE_BASE` | edge worker 部署后的根地址，不带尾斜杠。好友代理云端执行面 `/px/v1/*`（runtime 打 px call 时用平台身份自证）走这个根 |
| `RELAY_BASE` | edge worker 部署后的中继根地址，不带尾斜杠。cs 帧（云会话协议）走的那条 WebSocket |
| `DATA_DIR`（可选） | 本地状态（EventStore、`orphans.json`、workspace-config.json）落盘目录，缺省 `/var/lib/otto-runtime`（`config.ts` 的 `DEFAULT_DATA_DIR`），一般不用填 |

**一共 6 个必需变量**（逐字数 `REQUIRED_KEYS` 得出，不是估的数），`DATA_DIR` 是唯一有默认值
的可选项。

**模型 key 不在这份清单里**（issue #844，推翻 ADR-0199 决策⑥）：它跟着工作区走，由每个
工作区的所有者在客户端里配自己那把（云会话页右上角「配置模型 / 仓库…」），落在 VPS 的
`<DATA_DIR>/workspace-config.json`（0600，与仓库 PAT 同一份文件）。这台 runtime **不持有
任何模型 key，也不做 env 兜底**——有兜底就等于「忘了配的工作区默默烧维护者的钱」。没配
模型的工作区能建会话、能聊天，但 @Agent 起不了 turn，会回一条看得见的话。

### 1.2 systemd unit

```bash
sudo cp deploy/otto-runtime.service /etc/systemd/system/
sudo systemctl enable otto-runtime
```

`deploy/otto-runtime.service` 的 `EnvironmentFile=/etc/otto-runtime.env` 指向上一步那份文件；
`ExecStart=/usr/bin/node /opt/otto-runtime/runtime.mjs` 指向下一步部署脚本会推上去的 bundle
路径；`Restart=on-failure` + `RestartSec=5` 是崩溃自愈。

### 1.3 部署

```bash
RUNTIME_SSH=user@host npm run runtime:deploy
```

`RUNTIME_SSH` 是唯一必需的 env（形如 `user@host`，脚本按 `-p 2222` 连）——没有目标地址
`scripts/runtime-deploy.mjs` 直接打印用法退出 2，不往下走半步：这是一次会真的连真机、真的
重启线上服务的操作。脚本做四件事：

1. **esbuild 打包**：把 `services/runtime/src/daemon.ts` 打成单文件 ESM bundle
   （`services/runtime/dist/runtime.mjs`）。`better-sqlite3` / `dockerode` 两个原生绑定
   external 出去——本机 arm64 打出来的二进制在 VPS x86_64 上跑不了，靠远端 `npm install`
   装它们自己的原生件。
2. **生成瘦身 `deploy-package.json`**：只含这两个原生件，版本从根 `package.json` 现读，不在
   这再手抄一遍（根 package.json 升级依赖版本时这份清单自动跟着对）。
3. **三次分开 rsync**：`dist/` 带尾斜杠推到 `/opt/otto-runtime/`（bundle 落在根目录，不是
   `dist/` 子目录，因为 `ExecStart` 写死 `/opt/otto-runtime/runtime.mjs`）；
   `deploy-package.json` 落地时**改名**成 `package.json`（npm 只认这个文件名）；`Dockerfile`
   落进 `/opt/otto-runtime/sandbox/` 子目录（远端 `docker build ./sandbox` 找的就是这里；
   先 `ssh mkdir -p` 确保子目录存在，旧版 rsync 不会自动建父目录）。
4. **远端命令**：`cd /opt/otto-runtime && npm install --omit=dev && docker build -t
   otto-sandbox ./sandbox && sudo systemctl restart otto-runtime`。

## 2. 手验清单（DockerWorld / 沙箱真机面）

自动化测试盖不到「真 docker daemon + 真 VPS + 真两台设备」这个组合，以下十四条要真机走一遍。
②③④⑤⑥⑦对应 spec §8「DockerWorld 走 VPS 真机手验清单」列的六个场景，①是新增的部署链路
本身验证，⑧是连接豁免验证，⑨⑩来自 ADR-0200（clone 那条链路），⑪⑫⑬来自 ADR-0201
（限流 / 归档 / 连接计数按人分桶），⑭来自 ADR-0202（模型 key 跟着工作区走）：

1. **首次部署本身是这条链路的第一次真机验证**——`scripts/runtime-deploy.mjs` 交付时（T11）
   按指示没有真的连过 VPS：esbuild 打包与 `deploy-package.json` 生成逻辑在仓外独立验证过，
   但 rsync 的三条命令行参数拼接（尤其 `deploy-package.json → package.json` 改名、
   `sandbox/Dockerfile` 的目标路径）只经过人工推演，没有真实 rsync 二进制验证过参数形状
   是否被正确解析（T11 report 原话：「下一次真的有一台 VPS 可用时，第一次 `npm run
   runtime:deploy` 本身就是最终验证」）。第一次跑要盯着完整输出：`mkdir -p` 有没有权限问题、
   三条 rsync 有没有非 0 退出、远端 `npm install --omit=dev` 有没有因为原生绑定版本对不上而
   失败、`docker build` 有没有卡在拉基础镜像、`systemctl restart` 之后 `systemctl status
   otto-runtime` 是不是 `active (running)` 而不是 `activating`/`failed`。任何一步非 0
   退出码都说明这条链路还没打通，不能因为「脚本写完了、类型检查过了」就认为部署一定成功。
2. **建云会话 → 容器起来**：桌面在工作区页点「新建云会话」，VPS 上 `docker ps` 应该看到一个
   新容器 `otto-ws-<workspaceId>`（`services/runtime/src/sandbox.ts` 的 `containerName`
   命名约定）。
3. **工具执行 → 审批 → 回复**：云会话里 @Agent 让它 `echo hi > /work/a.txt`，审批卡应该
   出现在**发起人**桌面（不是随便哪个在场成员——ADR-0199 决策④「发起人审批」），批准后工具
   执行、agent 的回复要出现在时间线上。
4. **第二台账号进同一会话**：用 `docs/dev-two-accounts.md` 的 profile 法
   （`OTTO_PROFILE=b npm run dev` 起第二个实例、登另一个账号）加入同一工作区的同一条云会话，
   应该看到第 3 步的直播事件与发言注入——两端投影一致。
5. **踢人 60 秒内生效**：owner 把某个成员踢出工作区后，60 秒内（`membershipCache.ts` 的
   60s TTL）该成员再发 `say` 应该收到 `denied` / `not_member`，而不是静默无响应或继续得到
   回复。
6. **空闲自动停、再用自动起**：云会话空闲 31 分钟（超过 `sandbox.ts` 的 `DEFAULT_IDLE_MS`
   = 30 分钟）后，VPS 上 `docker ps` 应该看不到那个容器（`docker ps -a` 里还在，只是
   State 变成 stopped）；这之后再发一条消息，容器应该自动 `start` 回来，不需要人工干预。
7. **计量落账**：一轮 turn 跑完后，Supabase `usage_ledger` 表（migration 0016）里应该出现
   对应这一轮的一行（`uid` = 发起人、`workspace_id`、`session_id`、`model`、
   `prompt_tokens`/`completion_tokens`）。`daemon.ts` 先落权威的 `model_usage` 事件再异步
   镜像写这张表，镜像写失败只打日志不阻塞 turn——正常路径下应该能看到这一行，看不到不代表
   turn 失败了，要去 VPS 日志里确认是不是镜像写那步报了错。
   注意这张表的 `uid` 记的是**发起人**（「谁动的手」）；订阅制那本账（`usage_event`）
   记的是**工作区所有者**（「谁付的钱」，ADR-0217）——同一轮 turn 在两张表里的 uid
   本来就可以不一样，不是哪一边写错了。
8. **`MAX_CONNS_PER_USER` 豁免**（只能在真 workerd 上验）：`src/shared/remote/wire.ts` 的
   `MAX_CONNS_PER_USER = 16` 限的是普通用户账号的并发连接数；runtime 以平台身份
   （`svc-runtime`，`RUNTIME_SECRET` 验出）连 relay 时**不受**这条上限约束
   （`services/edge/src/worker.ts`：`if (!isSvcRuntime && existing.length >=
   MAX_CONNS_PER_USER)` ——豁免的判据是 `svc=1` 查询参数 + `RUNTIME_SECRET` 验证通过，
   不是身份本身）。这条验的不是「云会话能不能跑起来」，是「多台 VPS 同时用同一枚 runtime
   账号连 relay 会不会被 503 拒掉」——`services/edge/checks/relay.mjs` 已有一条基础检查
   （用 `RUNTIME_SECRET` 连 relay 能收到 `:cid`），但没有覆盖「已经有 16 条占线时还能不能
   连上」这个豁免场景，单测里的假 DO 也覆盖不到 `acceptWebSocket` 的连接计数语义（见
   `services/edge/README.md`「运行时那一层怎么验」）。手验做法：起够 16 条以上的普通用户
   连接占满上限，确认带 `svc=1` 参数 + `RUNTIME_SECRET` 子协议的连接仍能正常接上（不是
   503），而第 17 条普通用户连接应该被拒。

9. **配仓库 → clone → 状态可见**（ADR-0200）：owner 在云会话页配一个 https 仓库（私有仓
   填 PAT），点保存应该等到**服务端回执**才显示「已保存」（不是本地一发就变）；这之后
   @Agent 让它跑一条工具命令，clone 在那一刻才发生（惰性），聊天流里会出现一条系统消息说
   克隆结果，而**页头那一格**（所有成员都看得见，不只是 owner）应该从「待克隆」变成
   「已克隆」。VPS 上验三件事：`docker ps -a` 里**没有**残留的 `otto-clone-*` 容器（旁路
   容器跑完即删）；`docker exec otto-ws-<id> cat /root/.git-credentials` 应该**不存在**
   （凭据从不进水獭那台容器）；`docker exec otto-ws-<id> git -C /work remote get-url origin`
   是刚配的那个地址。
10. **换仓库 / 拒绝清空**（ADR-0200 的决策表，两条都要走）：
    - 换一个**不同的**仓库地址再保存，下一次工具调用应该看到「已切换仓库：旧 → 新」，
      `/work` 里换成新仓库的内容；
    - 先让水獭在 `/work` 里改一个文件不提交（或者 `git commit` 但不推），再换仓库地址——
      这次应该看到**拒绝**（「有未提交的改动」/「有还没推送出去的提交」），`/work` 原样
      不动。这条是这次改动的核心：默认值从「删」翻成「不删」，删错不可逆。

11. **限流三档**（ADR-0201 第二节，#819）：连着发 30 条以上普通消息，第 31 条起应该在页面上
    看到「发得太快了」那句话（**看得见**，不是消息凭空消失）；连着 @Agent 十来次，同样应该
    看到「@Agent 的频率超了」。VPS 日志里对同一个人**一分钟只有一行** `限流生效`（不是每帧
    一行——日志本身不该成为第二个能被刷爆的东西）。桶按 uid 分：换一个成员发言应该照常放行。
    再验建会话那一档：连着建 6 条云会话，第 6 条起应该被拒（不是白等满 15 秒超时）。
12. **归档**（ADR-0201 第三节，#822）：owner 或建这条会话的人点页头的「归档」→ 确认，
    群里**每个人**都应该看到一条系统消息「XX 归档了这条会话」，页面随即退回工作区，清单里
    那条沉到底部并标成已归档。VPS 上验两件事：Supabase `workspace_sessions` 那行的
    `archived` 变成 `true`；重启 `otto-runtime` 之后这条会话**不再**被开出房间
    （`journalctl` 里没有它的恢复日志，桌面 join 它会拿到 `no_session`）。既不是 owner
    也不是建的人：页头**看不到**那颗按钮，且就算改客户端硬发一帧也会被服务端拒。
13. **连接计数按人分桶**（ADR-0201 第一节，#824；接着 ⑧ 一起验）：用**同一个**账号占满 16 条
    连进 `cs-ctl`，第 17 条应该 503；此时换**另一个**账号连同一个房间应该**照常连得上**
    （改之前它会一起被拒——这正是这条修的东西）。

14. **模型 key 跟着工作区走**（ADR-0202，#844）：新建一个工作区、建一条云会话，
    **先别配模型**就 @Agent —— 应该在群里看到一条「这个工作区还没配模型」的话（不是一个
    401 堆栈，也不是静默卡住）。然后 owner 点右上角配一把自己的 key（https 的 base URL +
    型号 id + key），再 @Agent，这次应该真的跑起来。VPS 上验两件事：
    `cat <DATA_DIR>/workspace-config.json` 里那把 key 在、文件权限是 `0600`；
    `systemctl show otto-runtime -p Environment` 里**没有**任何 `MODEL_*`。
    非 owner 的成员：页头看得见「模型：<型号>」这一格，但**没有**那颗配置按钮。

## 3. 回滚

```bash
sudo systemctl stop otto-runtime
```

数据不随服务停止而丢：EventStore、孤儿标记表、工作区云配置都在 `/var/lib/otto-runtime/`
（或部署时 `DATA_DIR` 指定的目录），停服务不删这个目录。

真要连数据一起清（谨慎，不可逆）：

```bash
sudo rm -rf /var/lib/otto-runtime
```

删容器不删卷——容器可以重建，卷里是 agent 直接写入的工作区文件（当前版本 git clone 尚未
接线，见 `daemon.ts:73-78` 的已知限制），误删代价更大：

```bash
docker rm -f otto-ws-<workspaceId>
```

单独删某个工作区的卷（容器已经不在、且确认真的不再需要这份工作区数据时才做）：

```bash
docker volume rm otto-ws-<workspaceId>
```
