# 工作区 Git：拆掉「绑一个仓库」，换成凭据 + 三把刀

- 日期：2026-09-08
- 状态：已与维护者逐段确认，待落实现计划
- 起因：维护者对着「文件」tab 底部那一节说「下面这些不要，如果有 git 仓库，让用户自己去决定放到哪个路径去」
- 关联：ADR-0199 / ADR-0200（clone 那一整套的来处）/ ADR-0231（`sandbox_approval`）/ ADR-0234（仓库配置搬进工作区设置）/ ADR-0243（读不到 ≠ 关着；这一轮只能收紧）/ ADR-0251（「文件」tab 的定义与两道路径闸）/ ADR-0258（部署跟着发版走）

---

## 1. 问题

今天「一个工作区绑一个仓库」：owner 在设置页填地址 + PAT，`ensure()` 建容器时把它 clone 进 `/work` **根**。

这个形状有三处不对：

1. **它把「文件」页重新变成两件事。** 那一页 ADR-0251 刚定义成「水獭在哪儿干活」，底下压着一张仓库配置表单，非程序员读到的第一个词就跟自己无关。
2. **路径不是用户的。** 仓库只能落在 `/work` 根，于是「clone 两个仓库」「代码放 `./src`、素材放 `./assets`」都表达不了。
3. **它逼出了一张 677 行测试的决策表。** clone 打在根上就可能清空水獭之前的产出（#832 真踩过，且本期不许 push = 没有远程备份），于是有了 `probeWorkState` 四态 + `decideCloneAction` 四分支。**那张表的复杂度全部来自「目标是根目录」这个前提。**

### 一条验过的前提

**从来没有一个工作区配过仓库**：VPS 上 `/var/lib/otto-runtime/workspace-config.json` 一个都不存在（2026-09-08 实测）。所以这次改动**没有存量数据要迁移**，也没有任何用户会因为拆掉绑定而失去什么。

（同 ADR-0242 那次「Lite 订阅一条都没有过」——先查真库，别按最坏情况设计一个不存在的迁移。）

---

## 2. 不变量：凭据不进水獭那台容器

ADR-0200 决策②花了一轮复审确立的东西，这次**原样保留**：

- PAT 只经 **stdin** 喂给 `git credential approve`；不进 argv（容器里跑着水獭自己的 bash，`ps aux` 会把它摆在水獭面前）
- clone 跑在一台**一次性旁路容器**里（挂同一个卷），PAT 只活在那台的可写层，容器一删就没
- 三层脱敏：`redactPat` / `safeRepoLabel`（地址里可能用 userinfo 藏凭据，**输出侧**脱敏——输入校验被绕过三次：全角 ＠、11 层嵌套 percent 编码）/ `sanitizeCloneText`

### 被否掉的方案：往水獭容器里装 credential helper

想法是让水獭照常自己跑 `git clone/pull/push`，凭据按需流过去不落盘。

**不成立**：helper 装在水獭那台容器里，水獭自己就能跑 `git credential fill` 把 token 打印出来。凡是 git 在那台容器里跑，token 就必然到过那台容器。

**推论：跑 git 的进程必须在旁路容器里 ⇒ 私有仓库那条路必须是一把工具，不能是 bash。** 公开仓库不受这条约束（容器镜像里 git 2.39.5 在、HTTPS 通，实测）。

---

## 3. 决策

### 决策 1：凭据按「工作区 + 主机」

```
workspaceId → { hosts: { "github.com": { token, addedAt, addedBy } } }
```

否掉的两个：**一个工作区一把 token 不分主机**（git 按 host 匹配 credential，猜错就是一次静默认证失败）、**个人 + 主机**（「凭据跟着人走」的好处在单人/小团队还兑现不了，却要多一张表和一套 per-user RLS）。

### 决策 2：存在 runtime 自己那份，不搬 Supabase

沿用 `workspaceConfigStore`（VPS 上的 JSON 文件），只换形状。

理由是这条不变量：**token 从不下行**。今天 `welcome.repo` 只回 `hasPat`。放进 Supabase 就要么给 `authenticated` 开 select（token 到了每个成员的客户端），要么搞列级授权 + 只让 service key 读——后者能做，但为一个已经工作的东西付一次 migration + RLS 的复杂度，换不到任何东西。

**已知代价**：这份数据只活在那台 VPS 的一个文件里，没有备份，机器没了要重填。今天也是如此，不是本次新增。

### 决策 3：权限三条

- **写 / 删：只有 owner**。判据与 `sandbox_approval` 逐字相同（ADR-0243：它花的是 owner 的额度、动的是共用的卷）
- **读：任何在籍成员**，回的是 `{ host, addedBy, addedAt }` —— **没有 token**
- 非 owner 看到同一份清单、没有 ＋ 和 [删除]。**不是把整组藏起来**——那会让人以为这个工作区没配过（同 ADR-0243 对非 owner 的处置）

### 决策 4：UI 落在「连接器」tab，分两组

```
MCP 服务
  ▸ ……（不动）

代码仓库
  ▸ github.com     由 stan_test 添加 · 9/8     [删除]
  ＋ 添加主机                                ← owner 才画
```

否掉「文件」tab（那一页刚定义成「水獭在哪儿干活」，塞一格凭据又变两件事）和新开一个 tab（为一两行内容把 7 个 tab 变 8 个）。

「连接器」这个词本来就在回答「这个工作区能够到外面的什么」，Git 主机是其中一种。代价（MCP 与 Git 走完全不同的执行路径）用一个分节标题承担。

token 输入框**存完即清**，纪律照抄 `ProviderKeyDialog` 的原话：「输入框存完即清，渲染层不留 key 的任何副本；状态只有布尔」。

### 决策 5：三把刀，全部 `requiresApproval: true`

`policyApprover` 的免批判据是 `tool === bashTool || tool === writeFileTool` ——**按工具身份比，不按名字**（ADR-0231）。所以「工作区开着 `auto` 也管不到这三把刀」是**由构造保证**的，不用记得去排除。

给所有 agent，不像 `create_agent` 那样只给管理员：真正的闸是审批门，再叠一层没有理由。三把刀的**任何**输出（成功和失败）都过 `sanitizeCloneText`。

**只在云会话里挂**（`services/runtime/`），本机会话不给：本机水獭动的是用户自己的文件夹，那儿有他自己的 git 和自己的凭据，`bash` 已经够了；把这三把刀搬到本机等于给一个不存在的问题造一套凭据存储。

#### `clone_repo(url, dest)`

- `url` 过 `validateRepoUrl`（今天就有，结构化白名单，两端共用）
- `dest` 过 `normalizeWorkPath`（ADR-0251：`..` 与绝对路径一律拒，**不解释成上跳一级**）
- 旁路容器 → 按 host 取 token → `git credential approve`(stdin) → `git clone` 进 `/work/<dest>` → 删容器
- **这条路走 `ensure()`，会建容器**——与 `readWork` 刻意不建（ADR-0251：翻一眼文件不该触发一次可能十分钟的 clone）**方向相反而理由一致**：判据是「这个动作要不要往卷里写」。clone 本来就是写
- 审批卡：仓库（`safeRepoLabel`）/ 落到哪个路径 / 用不用凭据
- 成功回：路径 + 分支 + 短 sha

#### `git_push(dest, branch, message)`

实际做的是「把 `<dest>` 的改动提交并推到 `<branch>`」，不只是 push。

1. **「没有改动」分两态**：branch 远端已存在 → 跳过并说清楚（不是失败）；branch 还不存在 → **照推**，把当前 HEAD 推上去建这条分支（「这个分支还没有」和「没什么可提交的」是两件事，合成一句会让人以为推成功了而远端什么都没有）
2. **author 取点火的那个人**：`名字 <uid@users.noreply.mrotto.app>`。不用真邮箱——我们手上没有，编一个更糟；这个地址诚实：指认得出人，又不假装是他的信箱。查不到发起人就拒绝，不伪造（同 ADR-0224）
3. 现查远端默认分支（`git ls-remote --symref origin HEAD`）；`branch` 等于它 → 拒绝。**查不到也拒绝**（ADR-0243：没有任何输入能让这一轮比它开始时更松）
4. `git push origin <branch>`，**没有 `--force`，也没有 `--force-with-lease`**（后者听着安全，仍然是「用我的历史覆盖远端」）
5. 远端已有同名分支且不是快进 → 拒绝，让人换个分支名
6. 审批卡：仓库 / 分支 / 几个文件 `+N −M` / commit message 全文 / author 是谁

#### `create_repo(name, private)`

**只做 GitHub**，别家明说 `unsupported`（provider API 各不相同，做抽象层是在没有第二个消费方时先付抽象的钱；凭据模型按 host 分派，以后加一家不用改形状）。

`POST /user/repos`，用工作区存的 `github.com` 那把 token。**不顺手 clone**——建完回 https 地址。

**必须在卡上说出口的一条语义**：

> 仓库建在**这把 token 的主人**名下，不是点火那个人名下。建之前先 `GET /user` 拿 login，卡上写「将在 **@某某** 名下创建」。

不说的话，一个成员点了「批准」，仓库长在 owner 的 GitHub 账号里，他自己都不知道。

token scope 不够时照 `humanizeMcpError` 的规矩**只翻认得出的**，认不出的原样留、原文进日志。

### 决策 6：dest 非空一律拒绝，任何分支都不删文件

`decideCloneAction` 收缩成：

```
cloneTargetState(探测结果) → "empty" | "same-repo" | "occupied"
```

`empty` → clone；`same-repo`（`git remote get-url origin` 相等）→ 跳过并回「已经在了」；`occupied` → 拒绝，说清楚里面已经有东西。

**没有第四条分支，也没有任何一条会删文件。** #832 的教训是：清空是无声的，而它清掉的东西没有任何备份。「换个路径」对用户是一秒钟的事。

否掉「同 dest 换仓库时清空重来，走审批」——那会让这套东西里出现第一条会删用户文件的分支。

---

## 4. 协议 13 → 14

`frameHandler.ts:207` 是 `v !== CS_PROTOCOL_VERSION`——**精确相等**。进位那一刻**所有已装桌面立刻开不了云会话**，直到升级。

| 帧 | 处置 |
|---|---|
| `config` / `config_result` | **整个删掉**（ADR-0233 已拿走 `model`，repo 再走就空了） |
| `welcome.repo` | 删 |
| `workspace_state.repo` | 换成 `gitHosts: CsGitHost[] \| null` |
| `CsRepoState` | 删 |
| 新增上行 `git_credential{workspaceId, host, token}` | `token: ""` = 删除这台主机；owner 才受理 |
| 新增下行 `git_credential_result` | 形状同 `archive_result` |

`CsGitHost = { host, addedBy, addedAt }` —— **没有 `hasToken`**：在这张清单里就等于有 token，一个恒为 true 的字段只会让人猜它什么时候是 false。

---

## 5. 拆掉的 / 留着的

### 拆

- `sandbox.ts`：`WorkspaceRepoConfig` / `CloneOutcome` / `cloneOutcomeText` / `WorkState` / `parseWorkState` / `sameRepo` / `decideCloneAction` / `probeWorkState` / `ensureRepoCloned` / `invalidateClone`，以及 `createSandbox` 的 `repoConfig`、`onCloneOutcome` 两个 dep
- `daemon.ts`：`onCloneOutcome` 那段通报、`setCloneState`
- 桌面：`lib/cloudRepoStatus.ts`、`lib/cloudRepoUrl.ts` 两个文件整个；`WorkspaceFilesTab` 的 `RepoSection`；store 的 `workspaceRepoState` / `workspaceRepoConfig`
- 测试：`parseWorkState / decideCloneAction / sameRepo` 那 87 行，以及 677 行里属于决策表的那部分

### 留（**这是重点**）

`withCloneContainer` / `performClone` / `redactPat` / `safeRepoLabel` / `sanitizeCloneText` / `safeHostOf` / `CLONE_LABEL` / `CREDENTIAL_USERNAME` / `validateRepoUrl`——**这些不是旧代码，它们就是三把新刀的执行引擎**。跟着留的还有测试里 56 行 `safeRepoLabel`、237 行端到端脱敏，以及 677 行里覆盖「PAT 走 stdin、Cmd 数组不含 PAT、旁路容器跑完就删」的那些用例。

**拆的是「工作区绑一个仓库」这个概念和它那张决策表，不是凭据那条链。**

---

## 6. 交付顺序

关键约束不是「PR 要多大」，是**「已装桌面全断」这个窗口只能开一次**。main 上可以停留在「协议已改、还没部署」的状态——CI 全绿、桌面用旧的 out/、VPS 还是 13。

| 片 | 内容 | 单独合得进 main |
|---|---|---|
| 1 | 拆绑定 + 协议 13→14 | ✅ |
| 2 | 凭据存储 + `git_credential` 帧 + `workspace_state.gitHosts` | ✅ |
| 3 | 连接器 tab 的「代码仓库」组 | ✅ |
| 4 | 三把刀 | ✅ |
| — | **部署 runtime + 发版桌面** | 最后一次，不可拆 |

每片一条 issue，2/3/4 各写 `Blocked by: #<片1>`。

---

## 7. 测试面

### 门禁里跑得到

| 测什么 | 怎么测 |
|---|---|
| `cloneTargetState` 三态 | 纯函数 |
| 凭据表形状、owner-only、`token:""` = 删 | 纯函数 + 帧编解码 |
| 三把刀的执行 | 现成 `makeFakeDocker` + `withCloneExec`——断言 **PAT 不在 Cmd 数组里**、旁路容器跑完被删、拒绝路径不 exec 任何 git 写命令 |
| push 的默认分支闸 | 假 `git ls-remote --symref` 输出；**含「查不到 → 拒绝」** |
| `create_repo` | HTTP 层打假（不打真 GitHub）；含 scope 不够时的文案 |
| 连接器 tab 新那一组 | **真渲染**（#1099 的纪律：纯逻辑钉不到「有没有被画出来」）；含非 owner 只读那一态 |

### 门禁里跑不到，必须真机

这套东西一次都没在真机上跑过，而它动的是别人的 GitHub。

1. 存一把 token → 连接器 tab 列出 `github.com`
2. `clone_repo` 一个**私有**仓库到 `./x` → 文件树里出得来
3. 同一个 dest 再 clone 一次 → 回「已经在了」，**文件没被动过**
4. 换个仓库 clone 到同一个 dest → **拒绝**，文件没被动过
5. 改一个文件 → `git_push` 到 `otto/test` → 卡上四样都在 → 远端出得来
6. `git_push` 到默认分支 → **拒绝**
7. `create_repo` → 卡上写着「将在 @某某 名下创建」
8. 工作区开着**免审批**时，这三把刀**照样弹卡**
9. 旁路容器跑完 `docker ps -a` 里没有残骸
10. 整条链任何一处的输出里 **grep 不到那把 token** ← 写成脚本不靠肉眼；它是这套东西存在的全部理由

---

## 8. 已知代价

1. **协议进位有一个「已装桌面全断」的窗口**（精确相等的版本检查）。今天用户只有维护者和几个测试号，可接受
2. **凭据只活在 VPS 一个文件里，没有备份**（今天也是）
3. **`create_repo` 只支持 GitHub**，别家明说 unsupported
4. **push 不支持 force、不支持推默认分支**。要推主干只能人自己去 PR
5. **仓库建在 token 主人名下**，不是发起人名下——只能靠审批卡说出口，机制上挡不住
6. **公开仓库有两条路**（bash 直接 clone / `clone_repo`），水獭可能选任意一条。不统一是有意的：bash 那条不花凭据也不弹卡，拦它没有收益
