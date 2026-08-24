# 分发 Windows 安装包

## 出包

```bash
npm run dist:win
```

在 macOS 上交叉出包即可，产物在 `dist/`：

- `Mr.Otto-<version>-win-x64-setup.exe` —— NSIS 安装器，给别人的就是这个
  （名字用点不用空格：GitHub Release 会把空格改写成点，本地名与资产名保持一致，见 issue #306）

只出 **x64**。arm64 Windows 设备走 x64 模拟也能跑，暂不单独出包。

## 为什么 mac 上能交叉出 win 包

三个本来会挡路的东西都绕开了：

1. **Swift 灵动岛 helper（`native/MrOttoIsland/`）是 macOS 专属**，Windows 上没有对应物。
   打包链路三处守卫保证 win 包干净：
   - `scripts/build-island.mjs`：非 macOS 直接跳过（dist:win 根本不跑它）
   - `scripts/afterPack.cjs`：`electronPlatformName !== "darwin"` 直接 return，不拷二进制
   - 运行时 `resolveIslandBinPath()`（`src/main/islandBinPath.ts`）：找不到二进制返回
     `null`，岛静默不启动，主窗和其余功能照常
2. **原生模块不重编**。node-pty 和 better-sqlite3 都是 NAPI，包内自带
   `prebuilds/win32-x64` 预编译二进制，运行时按 `process.platform` 挑对应文件。
   另一类是 napi-rs 风格的平台包（如 `@firecrawl/anydoc`）：各平台二进制拆成
   optionalDependencies，mac 上 `npm install` 只装 darwin 那个——
   `scripts/ensure-win-bindings.mjs`（dist:win 前置）自动把缺的 win32-x64
   binding 包 `npm pack` 下来解进 node_modules（不动 package.json/lockfile）。
   少这一步 win 包启动即崩「Cannot find native binding」（v1.0.1 真机翻过车，
   issue #308）。electron-builder 两侧的 `files` 排除按平台裁剪这些包。
   `dist:win` 带 `--config.npmRebuild=false` 跳过 electron-builder 的重编步骤
   （交叉 node-gyp 本来就不可能，这一步不关就直接报
   `node-gyp does not support cross-compiling`）。
   `electron-builder.yml` 的 `win.files` 另外排掉了 `node-pty/build/**`——那是本机
   mac 编译产物，排掉逼 loader 走 prebuilds。
3. **NSIS 在 macOS 上出包不需要 wine**，electron-builder 自带工具链。

## 收件人怎么装

双击 `.exe` 走 NSIS 向导（可改安装目录）。没有代码签名证书，首次运行
SmartScreen 会拦：「更多信息」→「仍要运行」放行。与 mac 无公证是同一档待遇。

## 已知边界

- **未在真实 Windows 机器上验证过**。原生模块（终端 node-pty / SQLite）理论上
  prebuilds 就绪，但发布前应在一台真 Windows 上过一遍冒烟。
- **OTA 更新是 mac 专属**（ADR-0075，更新器只认 `-arm64-mac.zip` 资产），win 版
  不会自动更新，出新版要用户重新下载安装。
- **深链 `mrotto://auth-callback`**：NSIS 装完由注册表接管 scheme（electron-builder
  的 `protocols` 配置写入）。Windows 上深链不走 macOS 的 `open-url` 事件，而是以
  命令行参数启动第二个实例——主进程用 single instance lock + `second-instance`
  扫 argv 接住（issue #310，v1.0.1 真机翻过车：没接 argv 通道，登录回调回不来）。
- win 包里带着 darwin/linux 的 prebuilds（每平台几 MB），死重但无害，未来可用
  `files` 排除法瘦身。
