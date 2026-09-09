# ADR-0265：界面上「工作区」改名「团队」；二次确认从 window.confirm 换成 AlertDialog

- 状态：已接受
- 日期：2026-09-09
- issue：#1126（改名）、#1127（确认弹窗）；#1125 被 PR #1128 抢先修了，见末节撞车记录
- 相关：ADR-0259（#1087 把这一栏抬成第三档时已经改过切换器那一格）、
  ADR-0264（它写下的「保留 `confirm()`……不新造 AlertDialog 视觉语言」被这条推翻）、
  ADR-0217/0218（这一族界面的来历）、ADR-0070（CONTEXT.md 分两节）

## 背景

维护者对着真机点出来的两件事，各自独立成立。

**① 名字只改了一格。** #1087（ADR-0259）把云端协作组抬成侧栏切换器的第三档时，
顺手把那一格的字从「工作区」改成了「团队」——但**只改了那一格**。于是设置抽屉左上角
的返回按钮写着「← 工作区」，而它回去的那一栏叫「团队」：同一个东西在相邻两个像素上
有两个名字。维护者的口径是「这个命名已经改了，所有地方都要改」。

**② 二次确认还是原生 `confirm()`。** 「解散工作区」弹出来的是操作系统那张灰框：
写着 Electron 的应用名、按钮永远是英文的 OK / Cancel、问题与后果挤成一整块文字。
维护者点名 <https://ui.shadcn.com/docs/components/base/alert-dialog>，并且说
「其他类似跳出来的弹窗，都应该用这个 UI」。

## 决策 1：改名只动界面文案，不动代码标识符 / DB / 既有 ADR

**仓库里「工作区」是两个不同的东西**，这是这条改名唯一的难点：

- **团队** = `workspaces` 表那一行：一群人 + 他们贡献的连接器 + 云会话 + agent 名册
- **工作区** = 水獭在哪儿干活的那个文件夹：本机会话的 cwd（`ExecutionWorld` 的围栏、
  内置 Default、工作区检查点 / 锁 / 协作记录 / 在场），以及云端每个团队那一个共用工作
  目录（一容器一卷，ADR-0232）

`WorkspaceSettings.tsx` 里那句「工作区就是水獭干活的文件夹」说的是后者。一次全局
`sed` 会把它改成「团队就是水獭干活的文件夹」——一句人读得懂的假话，而且不报错。

所以铺开的方式是**逐文件判概念**：云端义的文件整份换，混住两种概念的文件
（`App.tsx` / `store.ts` / `shellBridge.ts` / `deriveMessages.ts`）逐行换。判据是
「这段话旁边有没有成员 / 连接器 / 云会话」。

范围划在**用户可见文案**（含模型可见的那几段：群聊 system 提示词、工具描述、
runtime 的错误消息）。三样明确不动：

- **代码标识符、组件名、DB 表名**：`workspaces` 表、`workspace_agents`、
  `WorkspacePage`、`useChat` 里那一串 action 名。改了会断账（`usage_event.agent_id`
  记 id 不记名是同一条纪律，ADR-0221），也会让所有历史 issue / ADR 里的引用失效。
- **`docs/adr/` 的既有文件**：ADR 是决策发生那一刻的记录，不是当前状态的文档。改它
  等于篡改历史；这一条自己就是历史里的新一层。
- **`src/` 里那 567 处注释**：以本机「文件夹」义为主，混着云端义。无差别铺开会把
  本机那批改错，而逐条判 567 行的收益是零——注释不上屏。真正管用的是把两个词的分工
  写进 `CONTEXT.md`（已加一条），让下一个读到 `workspace` 这个符号的人先问一句
  「这是一群人还是一个文件夹」。

## 决策 2：`window.confirm` 全换成 `useConfirm()`，provider 缺席时抛错

ADR-0264 写过「保留 `confirm()` 二次确认（……不新造一套 AlertDialog 视觉语言）」。
**那条理由本来就站不住**：视觉语言早就在仓库里——`ui/alert-dialog.tsx` 连同
`ForgotPasswordDialog` / `SetPasswordDialog` / `ConfirmEmailDialog` 三个消费方一直
在用。保留原生的代价倒是实的（系统脸、英文按钮、问题与后果不分家）。

形状是**一个 Promise 不是二十一段 JSX**：21 个调用点都长成
`if (!confirm(…)) return;`，给每处各挂一段 JSX + 一个 open state 就是把一件事抄
二十一遍。`useConfirm()` 回 `(opts) => Promise<boolean>`，调用点只多一个 `await`。

四条判断：

1. **provider 缺席时 `useConfirm` 抛错**（同 `useNav`），不回落到 `window.confirm`。
   那种回落会让「忘了挂 provider」表现成「弹窗长得不对」——而那正是这条 ADR 要修的
   事。这条纪律当场兑现：八个测试文件因为缺 provider 在渲染那一刻红，各自包上一层。
2. **结算只有一个出口：`onOpenChange(false)`。** 按钮 `onClick` 只**记下**答案。
   两处都 settle 的话一次点击摘两个——Radix 在跑完调用方的 onClick 之后自己会关闭，
   于是 settle 连着跑两遍，排在后面那个问题连问都没问就被答成了「取消」（写这条时
   真踩了，回归用例在 `tests/renderer/confirmDialog.test.tsx`）。
3. **排队，不丢**。modal 挡着，用户点不出第二个；但程序路径可以。被丢掉的那个
   promise 永远不 resolve = 调用点永远 `await` 下去，是个不会报错的死等。卸载时把
   没答的一律按「取消」收口，同理。
4. **摘队列的副作用不写在 `setState` 的 updater 里**（ADR-0264 同一条）：StrictMode
   会把 updater 跑两遍，`resolve` 跟着跑两遍。真相在 `queueRef`，state 只驱动渲染。

顺带把每处文案拆成**标题（问的是什么）+ 说明（后果是什么）**两格，危险动作的确认钮
写出动词（「删除」「解散」「移出」）并画成 `destructive`；焦点落在取消上（Radix 的
AlertDialog 默认行为）——一个不可逆的动作不该按回车就发生。

进出场动画一个字没写：`app.css` 里 `.dialog-overlay` / `.dialog-content` 那四行本来
就管着（200ms 进 / 140ms 出，退场比进场快；`prefers-reduced-motion` 下只剩淡入淡出）。

## 撞车记录：NavStack 那个 bug 两条 lane 各修了一遍（#1125）

这一轮开工时先修的是「点第一行没反应、点第二行才把第一页放出来」：`applyLayout`
闭包捕获了 `rendered`，而 `push()` 里的 `kick()` 在 `setStack` 之后、重渲之前调，
rAF 里跑的是**推入前**那一版栈。修法是让循环从 `renderedRef` 读栈。

合并前 re-fetch 时发现 **PR #1128 已经落地了同一个修复**（同根因、同修法、同样
closes #1125），于是 `nav-stack.tsx` 与 `navStack.test.tsx` 两个文件整份取 main 的、
丢掉这边那份 —— 先到先得（AGENTS.md：已经做了就别重做）。它的用例还比这边多两处：
`cancelAnimationFrame` 按 id 摘回调、以及「趁桩还在位先 `cleanup()`」（撤桩之后
组件卸载那次 `cancelAnimationFrame` 会打到 jsdom 真身上）。

**为什么两条 lane 会撞**：这个 bug 是维护者在真机上报的，两条 lane 各自从同一句
话出发。start-of-shift 的碰撞检查（ADR-0148 / `npm run lane`）搜的是**开工那一刻**
的 issue 与分支 —— 而 #1128 的 issue 与分支都是在这条 lane 开工**之后**才出现的，
那道闸结构上盖不住它。真正接住的是合并前的 re-fetch（项目 ADR-0074 为 ADR 撞号写的
那条规矩，这次撞的是代码）。代价只是一份白写的实现，没有更坏的结局 —— 因为两边的
判据一致。

## 代价与已知未做

1. **`services/` 那半要重新部署 VPS 才生效**（同 ADR-0250 末段）：runtime 的错误
   消息、工具描述、群聊 system 提示词都在里面。部署前云端说的还是「工作区」。
2. **567 处注释仍写着「工作区」**，其中一部分是云端义。判据在 CONTEXT.md，不在代码里。
3. **代码里团队仍叫 `workspace`**：读代码的人要在符号与界面词之间做一次翻译。这是
   为「不断账、不断历史引用」付的价，明写在 CONTEXT.md 那一条里。
4. **`useConfirm` 的失败模式是运行时的不是编译期的**：忘挂 provider 要等渲染到那棵
   子树才红。比 `window.confirm` 强（那是静默的），比「编译不过」弱。
5. **`MemorySettings` 那处是弹窗套弹窗**（受控 Dialog 上叠 AlertDialog）：Radix 的
   FocusScope / DismissableLayer 栈应该管得住，但真机没点过。
6. **确认卡固定 `size="sm"`（320px）**：目前最长那句是「解散团队「X」？」+ 三行说明，
   装得下；哪天有更长的文案要重判。
7. **真机一次都没跑过**（同 ADR-0264 末条）。
