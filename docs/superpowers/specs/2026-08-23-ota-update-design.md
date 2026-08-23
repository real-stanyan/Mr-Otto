# OTA 更新（自研换包）设计

日期：2026-08-23
状态：已由 stanyan 口头批准（会话内）

## 背景与约束

- 无 Apple Developer 账号（ADR-0026）：ad-hoc 签名、无公证。`electron-updater`/Squirrel.Mac 在 macOS 上强制校验正式签名，标准自动更新路线被封死。
- 仓库 public（real-stanyan/Mr-Otto），GitHub Releases 可当免费更新源，无需鉴权。
- 现状：版本号手动升，无更新检查代码，发布 = 本地 `npm run dist:mac` 后人肉传播 dmg。

## 决策（已确认）

1. **自研换包更新**：app 内检查 GitHub Releases → 下载 zip → 校验 → 自己替换 .app → 重启。绕开签名校验（自己下载的文件无 quarantine 标记）。
2. **UX：提示 + 一键更新**：发现新版后静默下载就绪，设置页提示「新版已就绪」，用户点「重启更新」才换包重启。不打断正在跑的 agent 会话。
3. **发布管线：本地脚本**：`npm run release -- patch|minor|major` 一条龙（升版本、build、传 Release）。

## 组件

### 1. 更新源与产物

- `electron-builder.yml` mac target 加 `zip`（arm64）。dmg 留给首次安装，zip 供换包。
- 每个 GitHub Release 三个资产：`Mr Otto-<v>-arm64.dmg`、`Mr Otto-<v>-arm64-mac.zip`、`SHA256SUMS`。

### 2. 主进程 `src/main/updater.ts`

状态机：`idle → checking → downloading → ready → installing`；任一步失败进 `error`（带 message），状态变化推送渲染层。

- **检查**：启动后延迟 30s 查一次 + 每 6h 定时。`GET https://api.github.com/repos/real-stanyan/Mr-Otto/releases/latest`，取 `tag_name`（`v` 前缀）与 `app.getVersion()` 做 semver 比较。
- **下载**：新版 zip 下到 `userData/updates/<version>/`，下载完按 `SHA256SUMS` 校验 SHA256。校验只防损坏；同源发布防不了篡改，信任边界 = HTTPS + GitHub 账号，接受。
- **解包**：`ditto -xk`（系统自带）。Node 解压库会破坏 .app 内符号链接与执行位，禁用。
- **换包**（用户点击才触发）：spawn detached shell 脚本 → app 退出 → 脚本轮询等 pid 消失 → 现役 .app 改名为 `<name>.app.bak`（覆盖上一份备份）→ 新 .app 移入原路径 → `open` 拉起新版。备份留一份，坏了可手动回滚。
- **保护栏**：
  - `app.isPackaged === false` 时整个 updater 不启用。
  - App Translocation 检测（`app.getPath('exe')` 含 `/AppTranslocation/`）或 .app 所在目录不可写 → 降级为「提示新版 + 打开 Release 页」，不做自动换包。
  - 下载/校验失败：清理残留文件，进 `error`，下个周期重试。

### 3. ShellBridge + 渲染层

- `ShellBridge` 增加 `updater.getState()` / `updater.checkNow()` / `updater.installAndRestart()` + 状态推送事件（遵守硬规则：渲染层不碰 Node）。
- 设置页新增「关于与更新」卡：当前版本、手动检查按钮、下载进度、`ready` 时出「重启更新」按钮、error 时显示原因。

### 4. 发布脚本 `scripts/release.mjs`

`npm run release -- patch|minor|major`：

1. 工作区必须 clean，当前分支必须 main（防从半成品分支发版）。
2. `npm version <bump>`（升 package.json + commit + tag `v<version>`）。
3. `npm run dist:mac`（产出 dmg + zip）。
4. 对两个产物生成 `SHA256SUMS`。
5. `gh release create v<version>` 上传三个资产。
6. push commit + tag。

### 5. 测试与文档

- vitest（`tests/main/updater*.test.ts`）：semver 比较、release JSON 解析、SHA256SUMS 解析与校验、状态机流转、Translocation/不可写降级判定。网络与 fs 以注入 mock。
- 换包 shell 脚本真机手动验收（走验收欠账 issue 惯例）。
- 新 ADR：OTA 自研换包决策（无签名约束下的路线选择与信任边界）。
- `docs/distribution-macos.md` 补「OTA 更新」一节，「已知边界」里手动升版一条改为指向 release 脚本。

## 明确不做

- 差量更新（delta）——zip 全量够用。
- 更新弹窗打断——只在设置页提示。
- 多渠道（beta/stable）——单一 latest。
- Intel 包——继续只出 arm64。
