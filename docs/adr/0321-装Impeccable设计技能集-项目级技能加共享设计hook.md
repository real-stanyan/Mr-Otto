# ADR-0321：装 Impeccable 设计技能集——项目级技能 + 共享设计 hook + PRODUCT.md / DESIGN.md

- 日期：2026-09-27
- 状态：已采纳
- 关联：#1375；上游 `pbakaus/impeccable`（npm `impeccable` 4.1.0，技能包 `skill-v4.3.1`）；ADR-0010（Tailwind + shadcn/ui）/ 0022（AGENTS.md 单一事实源）/ 0149（worktree 一次性）/ 0264（图标底座中性）/ 0316（像素脸）

## 背景

维护者要把 Impeccable 装到项目级、技能文件跟仓库一起提交，再跑它的初始化，写出 `PRODUCT.md`（产品事实）和 `DESIGN.md`（现有视觉系统）；过程中产品面向谁、要什么风格，一律问维护者，不自己编，也不改现有代码。Impeccable 是给 AI 编码 agent 用的设计技能：一个 `/impeccable` 技能带二十几个子命令（`audit` / `critique` / `polish` / `document`…），外加一个不靠模型的设计反模式检测器。

## 决定

1. **装在哪**：`.claude/skills/impeccable/`（SKILL.md + `reference/` + `scripts/`）和 `.claude/agents/impeccable-*.md`（它派的 4 个子 agent），只装 Claude Code 这一家（`--providers=claude --scope=project`）。必须显式点名：仓库根下有 `.github/`，自动检测会把 GitHub Copilot 也算进来，写出 `.github/skills/` 和一份提交后就生效的 Copilot hook。
2. **设计 hook 进共享的 `.claude/settings.json`**（维护者 2026-09-27 选的）：PostToolUse（`Edit|Write`，超时 5 秒）在改完 UI 文件后跑检测器，Stop（超时 30 秒）收尾时把本会话碰过的文件深扫一遍；发现以 `additionalContext` 塞回对话，退出码恒为 0、不拦截。官方默认写 `.claude/settings.local.json`，可那个文件被全局 gitignore、只在当前 checkout 生效，而本仓的 worktree 用完即弃（ADR-0149），装在那儿等于只在一个要扔掉的目录里生效。命令自带守卫：技能目录不在（比如还没合进 main 的旧 worktree）时是空操作。挪过来时去掉了清单顶上的 `description` 键（那不是 settings 的字段）。上游安装器判「hook 已装」时 `settings.local.json` 与 `settings.json` 两处都认（`crates/skills/src/hook_manifest.rs` 的 `hook_installed_for_provider`），所以以后 `update` 不会再往本机文件写一份重复的。
3. **引擎二进制不进仓库**：安装器把本机平台的引擎（darwin-arm64，约 12MB）放进 `scripts/bin/`。它是平台专属的，Linux 的 CI 和 VPS 用不了；没有它时启动器 `scripts/impeccable` 按 `scripts/VERSION` 把钉住的版本下到 `~/.impeccable/bin/` 并校验 sha256，拿不到校验文件就拒绝。`.gitignore` 因此忽略 `.claude/skills/impeccable/scripts/bin/`。
4. **`.gitignore` 加上游 README 给的忽略块**（带 `impeccable-ignore-start/end` 标记，以后照上游刷新）：截图、hook 缓存、实时模式的会话状态、本机配置不进仓库；`config.json`、`design.json`、`surfaces/*.md`、`critique/*.md` 这些共享产物故意不忽略。
5. **`PRODUCT.md` 与 `DESIGN.md` 放仓库根**，`.impeccable/design.json` 是 DESIGN.md 的边车（色阶、阴影、动效、组件片段、叙述）。它们**描述**产品与设计，不是 agent 的工作规矩；规矩仍然只在 AGENTS.md（ADR-0022）。两份的内容来自维护者三轮作答加代码里的证据，出处写在各条后面。PRODUCT.md 的 Platform 记 `web`（桌面渲染层）；手机端同等重要，但设计语言是原生 iOS，要让 Impeccable 在 `mobile/` 下按 iOS 给建议，得另写一份 `mobile/PRODUCT.md`（本次没写）。
6. **跳过实时模式（`/impeccable live`）**：它要往 `src/renderer/index.html` 注入脚本、可能还要改 CSP，这是改现有代码；而且渲染层离开 Electron 的 preload 在普通浏览器里跑不起来。出图优先（comp-first）也没配：Claude Code 没有原生出图，`impeccable context` 也没报可用的出图接口，只剩 code-first，不写 `.impeccable/config.json`。

## 安装方式：为什么不是一条命令

维护者给的两条路都没走通。记下来是因为 `npx impeccable update` 会撞同一堵墙。

- **`npx impeccable skills install`**（4.1.0）：远程路径写死 `https://impeccable.style/api/download/bundle/universal`，它 302 到 `skill-v4.4.0/universal.zip`，可这个 release 在 GitHub 上还不存在（最新是 `skill-v4.3.1`）。签名文件 404，安装器照规矩失败关门，什么都没装。
- **`npx skills add pbakaus/impeccable`**（vercel-labs/skills 1.7.0）：装进 `.claude/skills/impeccable/` 的是上游仓库里 **Codex 那一份**（与 `.agents/skills/impeccable` 逐字节相同）：命令写成 `$impeccable`，69 处路径指向 `.agents/skills/...`，子 agent 是 Codex 的 `.toml`。在 Claude Code 里会跑错路径。这一次只在临时目录里试装，没进项目。
- **实际做法**：`gh release download skill-v4.3.1 -R pbakaus/impeccable` 取 `universal.zip` 和 `universal.zip.sig.json`，照上游 `crates/skills/src/bundle_signature.rs` 同一套算法手工验 Ed25519 签名（公钥取上游 `scripts/bundle-signing-keys.json`，key `release-2026-09`；签名、大小、sha256 都对；篡改版本号的对照组失败），再用 `IMPECCABLE_BUNDLE_PATH=<那个 zip> npx impeccable@4.1.0 skills install --providers=claude --scope=project --yes` 让官方安装器装。`IMPECCABLE_BUNDLE_PATH` 这条路安装器本身不验签，所以手工补上那一步。
- **以后更新**：上游发布 `skill-v4.4.0` 之后，`npx impeccable update` 就能直接用；在那之前照上面的办法换成新的已签名包。更新会重写技能文件，更新完核一眼 `git status`，别把 `scripts/bin/` 以外的意外改动带进提交。

## 否决

- **只装技能、不装 hook**：提过这条，维护者选了共享 hook。
- **hook 留在 `settings.local.json`**：见决定 2。
- **把引擎二进制提交进仓库**：见决定 3。
- **用 `npx skills add` 装的那份**：是 Codex 版，见上。
- **从上游仓库 HEAD 直接拷 `.claude/`（4.4.0）**：没有发布、没有签名；4.3.1 是最新的已签名版本。

## 已知代价

1. **每个 agent、每台机器改 UI 文件都会触发检测器**：一次 PostToolUse 最多 5 秒、Stop 最多 30 秒。没发现问题时也会塞一句「扫过了、没有确定性问题」进对话（同一会话里去重）。嫌吵的话：`IMPECCABLE_HOOK_QUIET=1` 只留发现，`IMPECCABLE_HOOK_DISABLED=1` 整个关掉，或者用 `/impeccable hooks` 管。
2. **hook 跑的是下载来的二进制，不经工具审批**：Claude Code 的命令型 hook 本来就不走模型的工具审批。信任链是上游 GitHub release 的 sha256（启动器校验）加上这次手工验过签的技能包。
3. **每台机器第一次触发 hook 要联网下载约 12MB 的引擎**（到 `~/.impeccable/bin/`）；离线时 hook 是空操作。
4. **检测器按 web 规则扫 `mobile/` 的 React Native 文件**：PRODUCT.md 的 Platform 是 `web`。有了 `mobile/PRODUCT.md`（Platform `ios`）之后，hook 会跳过手机端文件。
5. **技能加子 agent 约 2MB 跟着仓库走**（字体索引 1.1MB、实时模式的浏览器脚本 0.5MB）。
6. **DESIGN.md 会和代码漂**：它记的是 2026-09-27 的现状，`app.css` 或 `mobile/src/theme.ts` 改了令牌要跟着 `/impeccable document` 刷新。两端令牌已经有一处分叉（手机浅色的 `secondary` 是 `#e5e1d3`，桌面是 `#8fabd4`），写在 DESIGN.md 里待维护者定。

## 推翻前提

- 真用起来 hook 的噪音大于收益（agent 被它牵着去改不该改的东西）→ 关掉 hook，退回只装技能。
- 上游改成拦截式（非零退出或 `decision: block`）→ 重判要不要留在共享设置里。
