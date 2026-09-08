# 片 1：拆掉「工作区绑一个仓库」+ 协议进位 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一个工作区绑一个仓库」这个概念连同它那张决策表从产品里拿掉，**保留凭据执行链**（它是片 4 三把刀的地基）。

**Architecture:** 自上而下删四层——桌面 UI → 桌面主进程 RPC → 线上协议 → runtime（帧处理 / sandbox / daemon）。每一层单独一个 task，各自可编译、可跑门禁。`workspace` / `workspace_state` 这对帧**不删**：它还驮着 `modelRoute`（ADR-0246 那句「起不了 turn」），只是不再带 `repo`。

**Tech Stack:** TypeScript strict / vitest / Electron 渲染层 React + Zustand / services/runtime（Node + dockerode）

**Spec:** `docs/superpowers/specs/2026-09-08-workspace-git-credentials-design.md`

**Issue:** #1102（总 #1101；#1103 / #1104 / #1105 都 `Blocked by: #1102`）

## Global Constraints

- **不部署、不发版。** 本片合进 main 之后 VPS 仍跑协议 13。部署与发版是四片全完之后的一次性动作（`frameHandler.ts` 的版本检查是 `v !== CS_PROTOCOL_VERSION`，精确相等，一次进位 = 一个「已装桌面全断」的窗口，只能开一次）。
- **删测试的动机按 ADR-0020 写进 commit message**：跟着被删的产品代码走 = L2 常规开发，不是「删了求变绿」。
- **`sanitizeCloneText` / `safeRepoLabel` / `redactPat` / `safeHostOf` / `withCloneContainer` / `performClone` / `CLONE_LABEL` / `CREDENTIAL_USERNAME` / `validateRepoUrl` 一个都不许删** —— 它们是片 4 的执行引擎。覆盖它们的测试（`safeRepoLabel` 那 56 行、端到端脱敏那 237 行、以及「PAT 走 stdin / Cmd 数组不含 PAT / 旁路容器跑完就删」那些用例）同样留着。
- 门禁：`npm test`（= `tsc --noEmit` ×3 + `vitest run`）。每个 task 收尾必须全绿。
- 每个 task 一个 commit，message 说清**为什么**。

---

### Task 1: 协议层——摘掉 repo，版本 13→14

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`
- Test: `tests/shared/remote/cloudSession.test.ts`

**Interfaces:**
- Consumes: 无（这是最底层）
- Produces: `CS_PROTOCOL_VERSION = 14`；`CsUp` 不再有 `{t:"config"}`；`CsDown` 不再有 `{t:"config_result"}`；`{t:"welcome"}` 不再有 `repo`；`{t:"workspace_state"}` 收成 `{ t:"workspace_state"; workspaceId: string; modelRoute: CsModelRoute | null }`；`CsRepoState`、`isCsRepoState`、`normalizeRepoState` 全部消失。**`validateRepoUrl` 保留**（片 4 要用）。

- [ ] **Step 1: 先改测试，让它表达新契约**

在 `tests/shared/remote/cloudSession.test.ts` 里删掉所有针对 `config` / `config_result` / `CsRepoState` / `normalizeRepoState` 的用例，并新增这三条：

```ts
it("协议号进位到 14 —— repo 那一组字段整个走了（#1102）", () => {
  expect(CS_PROTOCOL_VERSION).toBe(14);
});

it("config 帧不再被认得 —— 旧客户端发过来一律解不出", () => {
  expect(decodeCsUp(JSON.stringify({ t: "config", workspaceId: "w1", repoUrl: "https://x/y.git" }))).toBeNull();
});

it("workspace_state 只剩 modelRoute —— repo 那一格没了", () => {
  const raw = JSON.stringify({ t: "workspace_state", workspaceId: "w1", modelRoute: null, repo: { url: "https://x/y.git", hasPat: true } });
  const got = decodeCs(raw);
  expect(got).toEqual({ t: "workspace_state", workspaceId: "w1", modelRoute: null });
});
```

> 第三条要的是「多出来的 `repo` 键被丢掉」，不是「解析失败」——老服务端还会发它，桌面该忽略而不是断线。

- [ ] **Step 2: 跑测试确认它红**

```bash
npx vitest run tests/shared/remote/cloudSession.test.ts
```
预期：三条全红（`CS_PROTOCOL_VERSION` 是 13、`config` 还解得出、`workspace_state` 还带 `repo`）。

- [ ] **Step 3: 改协议文件**

1. `CS_PROTOCOL_VERSION` 改 14，并在文件头那段版本沿革里加一行：
   `14（issue #1102）：repo 那一组整个走了——config / config_result 两条帧删除，welcome.repo 与 workspace_state.repo 删除，CsRepoState 删除。工作区不再绑一个仓库，改由片 4 的 clone_repo 让用户自己决定路径。`
2. 删 `CsRepoState` 接口、`isCsRepoState`、`normalizeRepoState`
3. `CsUp` 删 `{t:"config"}` 那一支；`decodeCsUp` 里对应的 `case "config"` 整段删
4. `CsDown` 删 `{t:"config_result"}` 那一支；`decodeCs` 里对应的 case 删
5. `{t:"welcome"}` 删 `repo` 字段；其 decode 处的 `repo: normalizeRepoState(obj.repo)` 删
6. `{t:"workspace_state"}` 删 `repo` 字段；其 decode 处同上
7. `validateRepoUrl` **原样保留**，并在它的文档注释末尾加一句：
   `片 1（#1102）拆掉工作区绑定之后，这个函数的消费方从 config 帧换成片 4 的 clone_repo 工具——校验的对象没变，还是「用户给的一个仓库地址」。`

- [ ] **Step 4: 跑测试确认它绿**

```bash
npx vitest run tests/shared/remote/cloudSession.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/shared/remote/cloudSession.ts tests/shared/remote/cloudSession.test.ts
git commit -m "$(cat <<'EOF'
feat(protocol): 协议 13→14，repo 那一组字段整个走了（#1102）

config / config_result 两条帧删掉——ADR-0233 已经把 model 拿走，repo 再走
就空了。welcome.repo 与 workspace_state.repo 一并删除，CsRepoState 跟着走。

workspace / workspace_state 这对帧**不删**：它还驮着 modelRoute（ADR-0246
那句「起不了 turn」是这一页唯一的落点）。

validateRepoUrl 保留——它的消费方从 config 帧换成片 4 的 clone_repo 工具，
校验的对象没变，还是「用户给的一个仓库地址」。

删的三条测试跟着被删的产品代码走（ADR-0020：L2 常规开发，不是删了求变绿）。

进位之后**先不部署**：版本检查是精确相等，一次进位 = 一个「已装桌面全断」
的窗口，四片全完之后一次性开。
EOF
)"
```

---

### Task 2: runtime 帧处理——删 applyConfig

**Files:**
- Modify: `services/runtime/src/frameHandler.ts`（`applyConfig` 在 308-370 附近；`config` 分支在 400、483、792 三处）
- Test: `tests/runtime/frameHandler.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CsUp` / `CsDown`
- Produces: `FrameHandlerDeps` 不再有 `repoState` 里的 repo 部分；`workspace` 读帧的答复只带 `modelRoute`

- [ ] **Step 1: 先改测试**

删掉 `tests/runtime/frameHandler.test.ts` 里所有 `config` / `config_result` 用例，新增一条：

```ts
it("config 帧在协议 14 里已经不存在 —— 会话房和控制房都当作不认识（#1102）", async () => {
  // decodeCsUp 解不出来 = 帧处理层根本收不到，所以这里断言的是「没有任何回执」
  const sent: unknown[] = [];
  const h = makeHandler({ send: (_cid, raw) => sent.push(JSON.parse(raw)) });
  await h.onFrame(CTL_CID, JSON.stringify({ t: "config", workspaceId: "w1", repoUrl: "https://x/y.git" }));
  expect(sent.filter((f) => (f as { t: string }).t === "config_result")).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认它红**

```bash
npx vitest run tests/runtime/frameHandler.test.ts
```

- [ ] **Step 3: 删代码**

1. `applyConfig` 整个函数删（含它对 `validateRepoUrl` 的调用与 `config_result` 的两处回执）
2. 第 400 行那条「控制房专属帧」的白名单里把 `msg.t !== "config"` 去掉
3. 第 483 行 `if (msg.t === "config")` 分支删
4. 第 792 行附近 `case "config":` 删
5. `workspace` 读帧（413-420）的答复去掉 `repo` 那一格
6. 顶部 `import { validateRepoUrl }` 删（本文件不再用它，但**不许删它在 cloudSession.ts 里的定义**）
7. `FrameHandlerDeps` 里 `repoState` 的返回类型去掉 repo

- [ ] **Step 4: 跑测试确认它绿**

```bash
npx vitest run tests/runtime/frameHandler.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/frameHandler.ts tests/runtime/frameHandler.test.ts
git commit -m "$(cat <<'EOF'
fix(runtime): 帧处理层删掉 applyConfig 与 config 分支（#1102）

协议 14 里 config / config_result 已经不存在，decodeCsUp 解不出来，所以这
一层根本收不到——留着就是一段跑不到的代码（ADR-0249）。

workspace 读帧保留，只是答复不再带 repo：它驮着的 modelRoute 是 ADR-0246
那句「起不了 turn」在设置页的唯一落点。

本文件不再 import validateRepoUrl，但那个函数本身留在 cloudSession.ts 里
——片 4 的 clone_repo 要用它校验用户给的地址。
EOF
)"
```

---

### Task 3: runtime sandbox——删决策表与自动 clone，留执行引擎

**Files:**
- Modify: `services/runtime/src/sandbox.ts`
- Test: `tests/runtime/sandbox.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `createSandbox(docker, opts)` 的 `opts` 不再有 `repoConfig` / `onCloneOutcome`；`Sandbox` 接口不再有 `invalidateClone`。**导出仍然保留**：`withCloneContainer`、`performClone`、`safeRepoLabel`、`sanitizeCloneText`、`redactPat`、`safeHostOf`、`CLONE_LABEL`、`CREDENTIAL_USERNAME`。

> **这个 task 最容易做错的一件事**：`performClone` 与 `withCloneContainer` 此刻会变成**没有调用方**（片 4 才接回去）。**不许因此删掉它们**，也不许删它们的测试。在 `performClone` 的文档注释顶上补一句：
> `片 1（#1102）拆掉「工作区绑一个仓库」之后，这个函数暂时没有调用方——片 4（#1105）的 clone_repo 工具会接回来。它连同 withCloneContainer / 三层脱敏是这条链上唯一守住「凭据不进水獭那台容器」的东西（ADR-0200 决策②），拆绑定不等于拆它。`

- [ ] **Step 1: 先改测试**

1. 删掉 `describe("parseWorkState / decideCloneAction / sameRepo…")` 整段（87 行）
2. 在 `describe("createSandbox — git clone…")`（677 行）里，删掉断言「ensure() 会不会自动 clone / 决策表走哪条分支 / invalidateClone 的效力」的那些用例；**保留**断言「PAT 只走 stdin」「Cmd 数组里不含 PAT」「旁路容器跑完被删」「reconcile 按 CLONE_LABEL 收残骸」的那些——把它们改成直接调 `performClone` / `withCloneContainer`，不再经由 `ensure()`
3. `describe("safeRepoLabel…")`（56 行）与 `describe("createSandbox — clone 结果的端到端脱敏…")`（237 行）**一行不动**
4. 新增一条守住这次拆除的边界：

```ts
it("ensure() 不再自己 clone —— 建容器就是建容器（#1102）", async () => {
  const { docker, calls } = makeFakeDocker([]);
  const sandbox = createSandbox(docker);
  await sandbox.ensure("ws1");
  // 一条 git 都不该跑：clone 从「建容器的副作用」变成片 4 那把要人批的刀
  expect(calls.filter((c) => c.includes("git"))).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认它红**

```bash
npx vitest run tests/runtime/sandbox.test.ts
```
预期：新增那条红（今天 `ensure()` 里有 `ensureRepoCloned`）；被删用例引用的符号还在，所以不会因为编译失败而全红。

- [ ] **Step 3: 删代码**

按名字删这些顶层声明：`WorkspaceRepoConfig`、`CloneOutcome`、`cloneOutcomeText`、`WorkState`、`parseWorkState`、`sameRepo`、`decideCloneAction`、`probeWorkState`。

在 `createSandbox` 内部删：`ensureRepoCloned`、`invalidateClone`、`cloneAttempts` 那张缓存表、`opts.repoConfig` 与 `opts.onCloneOutcome` 两个参数，以及 `ensure()` 末尾那句 `await ensureRepoCloned(workspaceId, container)`。`Sandbox` 接口里 `invalidateClone` 那一行删。

文件头那段「git clone 设计要点」的 7 条**保留**，但在它上面加一句：

```
// 片 1（#1102）之后，这一段描述的不再是 ensure() 的一个副作用，而是片 4
// 的 clone_repo 工具的执行契约。七条一条没变——变的只是谁来调它。
```

- [ ] **Step 4: 跑测试确认它绿**

```bash
npx vitest run tests/runtime/sandbox.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/sandbox.ts tests/runtime/sandbox.test.ts
git commit -m "$(cat <<'EOF'
fix(runtime): sandbox 不再自己 clone —— 拆掉决策表，留住执行引擎（#1102）

删的是「工作区绑一个仓库」这个概念和它逼出来的那张决策表：
WorkspaceRepoConfig / CloneOutcome / cloneOutcomeText / WorkState /
parseWorkState / sameRepo / decideCloneAction / probeWorkState /
ensureRepoCloned / invalidateClone，以及 createSandbox 的 repoConfig 与
onCloneOutcome 两个 dep。

那张表 677 行测试的复杂度全部来自一个前提——clone 打在 /work 根上，所以可
能清空水獭之前的产出（#832 真踩过）。片 4 之后目标是用户指名的子目录，这
个前提没了，判断收缩成 empty / same-repo / occupied 三态且任何一条都不删
文件。

**留着的是执行引擎**：withCloneContainer / performClone / redactPat /
safeRepoLabel / sanitizeCloneText / safeHostOf / CLONE_LABEL /
CREDENTIAL_USERNAME。它们此刻没有调用方，片 4（#1105）接回去——它们是唯一
守住「凭据不进水獭那台容器」的东西（ADR-0200 决策②），拆绑定不等于拆它。
覆盖它们的测试（safeRepoLabel 56 行、端到端脱敏 237 行、PAT 走 stdin 那几
条）同样一行没删，只是改成直接调而不再经由 ensure()。

删掉的用例跟着被删的产品代码走（ADR-0020：L2，不是删了求变绿）。
EOF
)"
```

---

### Task 4: runtime daemon——摘掉接线与配置存储

**Files:**
- Modify: `services/runtime/src/daemon.ts`（`WorkspaceConfigRecord` 与 `createWorkspaceConfigStore` 在 119-200 附近；接线在 224、449-460、889）

**Interfaces:**
- Consumes: Task 2 的 `FrameHandlerDeps`、Task 3 的 `createSandbox`
- Produces: daemon 不再有 `workspaceConfigStore`。片 2（#1103）会在同一个位置新建 `gitCredentialStore`，形状 `workspaceId → { hosts: { host: {token, addedAt, addedBy} } }`。

- [ ] **Step 1: 删代码**

1. `WorkspaceConfigRecord` 接口、`createWorkspaceConfigStore` 整个函数删
2. 第 224 行 `const workspaceConfigStore = createWorkspaceConfigStore(...)` 删
3. 449-460：`repoConfig` 与 `onCloneOutcome` 两个 dep 删（连同 `cloneOutcomeText` 的 import）
4. 889 行 `repoState` 的实现去掉 repo 那一格，只回 `modelRoute`
5. `runReconcile` 里 `workspaceConfigStore.remove(...)` 那一行删
6. 顶部相关 import（`CsCloneKind`、`chmodSync` 如果没有别的消费方）清掉

**在 daemon.ts 留一句路标**，就写在原来 `createWorkspaceConfigStore` 的位置：

```ts
// 这儿原来住着 workspaceConfigStore（一个工作区绑一个仓库 + 一把 PAT，#834）。
// #1102 拆掉绑定之后它没有消费方了。片 2（#1103）会在这个位置新建
// gitCredentialStore：形状从「一个仓库 + 一把 token」换成「host → token」，
// 落盘纪律（0600 + 已有文件再 chmod 一刀）照抄它——那条纪律来自
// src/main/mcpAuthStore.ts:89-90，不是这里发明的。
```

- [ ] **Step 2: 跑门禁**

```bash
npm test
```
预期：全绿。daemon.ts 没有直接的单测，靠 `tsc` 与 `tests/runtime/*` 兜。

- [ ] **Step 3: 提交**

```bash
git add services/runtime/src/daemon.ts
git commit -m "$(cat <<'EOF'
fix(runtime): daemon 摘掉仓库配置存储与 clone 通报接线（#1102）

workspaceConfigStore 的两个消费方（sandbox 的 repoConfig、config 帧）都在
前两个 commit 里走了，它自己跟着走。原地留一句路标：片 2（#1103）会在同一
个位置新建 gitCredentialStore，形状从「一个仓库 + 一把 PAT」换成「host →
token」，落盘纪律（0600 + 已有文件再 chmod 一刀，来自 mcpAuthStore.ts:89-90）
照抄。

repoState 只剩 modelRoute——那一格是 ADR-0246 那句「起不了 turn」在设置页
的唯一落点，不能跟着一起删。

注意 VPS 上 workspace-config.json 一个都不存在（2026-09-08 实测），所以这
次删除没有任何存量数据要迁移。
EOF
)"
```

---

### Task 5: 桌面——拆掉「文件」tab 底下那一节

**Files:**
- Modify: `src/renderer/src/components/WorkspaceFilesTab.tsx`（`WorkspaceFilesTab` 55-140、`RepoForm` 413-512）
- Delete: `src/renderer/src/lib/cloudRepoStatus.ts`、`src/renderer/src/lib/cloudRepoUrl.ts`
- Delete: `tests/renderer/cloudRepoStatus.test.ts`、`tests/renderer/cloudRepoUrl.test.ts`
- Modify: `src/renderer/src/store.ts`（1045、1055-1058、2548、2557）、`src/shared/shellBridge.ts`（504、1173、1190）
- Test: `tests/renderer/workspaceFilesTree.test.tsx`

**Interfaces:**
- Consumes: Task 1 的协议类型
- Produces: store 只剩一个动作 `workspaceCloudState(workspaceId): Promise<FriendsResult<CloudWorkspaceState>>`（原 `workspaceRepoState` 改名——它回的东西早就不只是 repo）；`workspaceRepoConfig` 整个删；`CloudWorkspaceState` 收成 `{ modelRoute: CsModelRoute | null }`。

- [ ] **Step 1: 先改测试**

在 `tests/renderer/workspaceFilesTree.test.tsx` 的 `seed()` 里把 `workspaceRepoState` 改成 `workspaceCloudState`、删掉 `workspaceRepoConfig`，并新增一条：

```ts
it("这一页只剩文件 —— 仓库那一节整个走了（#1102）", async () => {
  seed(async () => ({ ok: true, value: { kind: "dir", entries: [file("a.txt", 1)], truncated: false } }));
  show();
  await screen.findByText("a.txt");
  expect(screen.queryByText(/从 Git 仓库带一份代码进来/)).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/Personal Access Token/)).not.toBeInTheDocument();
  expect(screen.queryByText("保存")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认它红**

```bash
npx vitest run tests/renderer/workspaceFilesTree.test.tsx
```

- [ ] **Step 3: 删代码**

1. `WorkspaceFilesTab` 里 `<section>` 那一整块（「从 Git 仓库带一份代码进来（可选）」到 `</section>`）删；`RepoForm` 整个函数删；`repo` / `repoStatus` 两个局部变量删
2. `modelStatus` 那一段**留着**，`load` 改名 `workspaceCloudState`，`save` 那一行删
3. 删两个 lib 文件与它们的测试
4. `store.ts`：`workspaceRepoState` 改名 `workspaceCloudState`，`workspaceRepoConfig` 声明与实现都删
5. `shellBridge.ts`：`CloudWorkspaceState` 收成只有 `modelRoute`；`workspaceCloudState` 保留，第二个（1190 那条 config 的）删
6. 顶部 import 清理：`repoStatusText`、`EMBEDDED_CREDENTIAL_MESSAGE`、`repoUrlHasEmbeddedCredential`、`Button`（若无别的消费方）

- [ ] **Step 4: 跑测试确认它绿**

```bash
npx vitest run tests/renderer/workspaceFilesTree.test.tsx
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): 「文件」tab 拆掉底下那一节仓库配置（#1102）

维护者对着那一节说「下面这些不要，如果有 git 仓库，让用户自己去决定放到哪
个路径去」。这一页 ADR-0251 刚定义成「水獭在哪儿干活」，底下压着一张仓库
配置表单，非程序员读到的第一个词就跟自己无关。

store 那两个动作：workspaceRepoConfig 整个删；workspaceRepoState 改名
workspaceCloudState —— 它回的东西早就不只是 repo，而 modelRoute 那一格必须
留（ADR-0246 那句「起不了 turn」在这一页是它唯一的落点）。

cloudRepoStatus.ts / cloudRepoUrl.ts 两个文件连同它们的测试整个删：唯一的
消费方就是刚拆掉的那一节（ADR-0249：留着跑不到的代码，下一个人会以为它还
在被谁读）。删测试的动机同上，跟着产品代码走（ADR-0020，L2）。
EOF
)"
```

---

### Task 6: 主进程——删 config RPC

**Files:**
- Modify: `src/main/cloudSessionClient.ts`（`ctlRequest` 的 config 那一路、`pendingConfig`、`WorkspaceCloudState` 别名）
- Test: `tests/main/cloudSessionClient.test.ts`

**Interfaces:**
- Consumes: Task 1 的协议、Task 5 的 `CloudWorkspaceState`
- Produces: 主进程只剩 `workspaceCloudState` 一条控制房 RPC（原 `workspace` 帧那条），config 那条没了

- [ ] **Step 1: 先改测试**

删掉 `tests/main/cloudSessionClient.test.ts` 里所有 config RPC 用例，新增：

```ts
it("控制房只剩 workspace 一条读 RPC —— config 那条走了（#1102）", async () => {
  const sent: { t: string }[] = [];
  const c = makeClient({ send: (raw) => sent.push(JSON.parse(raw)) });
  await c.workspaceCloudState("w1").catch(() => {});
  expect(sent.map((f) => f.t)).not.toContain("config");
});
```

- [ ] **Step 2: 跑测试确认它红**

```bash
npx vitest run tests/main/cloudSessionClient.test.ts
```

- [ ] **Step 3: 删代码**，跑 **Step 4** 确认绿，**Step 5** 提交

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(main): 主进程删掉 config 那条控制房 RPC（#1102）

协议 14 里这条帧不存在了。ctlRequest 那副骨架留着——workspace 与 create
两条还在用它（#829「没发出去当场失败不白等超时」与终审 C1「JWT 只发第一个
host 通告」各留一份，不再各写一遍）。
EOF
)"
```

---

### Task 7: 收尾——全门禁 + 确认没有孤儿

**Files:** 无新增

- [ ] **Step 1: 全门禁**

```bash
npm test
```
预期：`tsc --noEmit` ×3 通过 + vitest 全绿。

- [ ] **Step 2: 确认该留的一个都没少**

```bash
grep -c "withCloneContainer\|performClone\|safeRepoLabel\|sanitizeCloneText\|redactPat\|safeHostOf\|CREDENTIAL_USERNAME" services/runtime/src/sandbox.ts
grep -c "validateRepoUrl" src/shared/remote/cloudSession.ts
```
预期：两条都 > 0。**任何一条是 0 就是把片 4 的地基拆了，必须回滚这个 task。**

- [ ] **Step 3: 确认该走的一个都没剩**

```bash
grep -rn "decideCloneAction\|parseWorkState\|ensureRepoCloned\|invalidateClone\|CsRepoState\|repoStatusText\|workspaceRepoConfig" src services tests | grep -v "docs/"
```
预期：**零行**。

- [ ] **Step 4: 开 PR、等 CI、合并**

PR body 必须写明：**本片合并后不部署**。四片全完之后一次性部署 + 发版。

---

## 自查

**Spec 覆盖**：本计划对应 spec 第 5 节「拆」那一栏与第 4 节协议表的删除部分。spec 第 4 节新增的 `git_credential` / `gitHosts` 属于片 2，本计划**不**涉及——这是有意的边界，不是遗漏。

**类型一致**：`workspaceCloudState` 这个名字在 Task 5（store / shellBridge）与 Task 6（主进程）里必须逐字相同；`CloudWorkspaceState` 收成只有 `modelRoute` 之后，Task 5 与 Task 6 读的是同一个类型。

**没有占位符**：每个 task 的删除对象都点了名，新增的测试都给了可跑的代码。
