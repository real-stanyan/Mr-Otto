# 分发 macOS 安装包

## 出包

```bash
npm run dist:mac
```

产物在 `dist/`：

- `Mr Otto-<version>-arm64.dmg` —— 给别人的就是这个
- `mac-arm64/Mr Otto.app` —— 未打包的 app，本机调试用

只出 **Apple Silicon（arm64）**。Intel Mac 跑不了这个包。

## 收件人怎么装

1. 双击 `.dmg`，把 `Mr Otto` 拖进 `Applications`
2. **第一次打开会被拦下来**，提示「无法打开，因为无法验证开发者」或「已损坏」

第 2 步不是包坏了，是这个 app 没有经过 Apple 公证（notarize）—— 那需要 99 USD/年的开发者账号，见 ADR-0026。放行办法二选一：

**办法 A（推荐，一条命令）**

```bash
xattr -dr com.apple.quarantine "/Applications/Mr Otto.app"
```

`com.apple.quarantine` 是 macOS 给"从网上下载的文件"打的标记，删掉它就按本地程序对待。

**办法 B（点鼠标）**

在 `Applications` 里**右键**点 `Mr Otto` → 打开 → 在弹窗里再点一次「打开」。左键双击不行，必须右键——这是 macOS 有意设计的摩擦。

放行一次之后正常双击即可。

## 为什么要这么麻烦

app 做了 ad-hoc 签名（`codesign --verify --deep --strict` 能过），但没有公证。Gatekeeper 认的是公证，不是签名。要去掉这一步，只能买开发者账号并接上公证流程 —— 到那天，把这份文档的「收件人怎么装」第 2 步整段删掉即可。

## 灵动岛 helper

灵动岛（`native/MrOttoIsland/`，ADR-0061）是随主 app 一起打包的原生 Swift 二进制，出包时多两步：

1. `scripts/build-island.mjs`（`dist:mac` 前置跑）：`swift build -c release --package-path native/MrOttoIsland`，编出 arm64 release 二进制。
2. `electron-builder.yml` 的 `afterPack` 钩子（`scripts/afterPack.cjs`）：把 `native/MrOttoIsland/.build/release/MrOttoIsland` 拷进 `<app>/Contents/Resources/MrOttoIsland`，再 `codesign --force --sign -`（ad-hoc）签这个二进制——跟主 app 同一套签名策略，**不走独立公证流程**。

`afterPack.cjs` 在拷贝前检查 release 二进制是否存在，缺失就直接抛错、整个 `dist:mac` 失败——这是打包链路上的硬失败，逼着 `build-island.mjs` 必须先跑成功。

运行时是另一条路径，行为不同：主进程启动时用 `resolveIslandBinPath()`（`src/main/islandBinPath.ts`）在 `process.resourcesPath` 下找这个二进制；打包完整（上面两步都跑过）就能找到。**找不到（非 mac、Swift 未装、build-island 没跑过、或二进制被后续步骤删掉）时，`resolveIslandBinPath()` 返回 `null`，岛静默不启动**——不弹错误、不拖死启动链、主窗和其余功能照常跑，只是没有灵动岛。

## OTA 更新（ADR-0075）

装过一次之后，后续版本 app 自己更新：打包版启动 30s 后（此后每 6h）查本仓
GitHub Releases，发现新版就静默下载 zip、SHA256 校验、`ditto -xk` 解包待命，
设置页「关于与更新」出现「重启更新」按钮——点了才换包重启，不打断正在跑的会话。
自己下载的文件没有 quarantine 标记，所以 OTA 换上的新版**不需要**再走上面的放行步骤。

App 跑在只读路径（App Translocation）或 `.app` 所在目录不可写时降级：只提示
新版 + 打开 Release 页，用户手动装。换包前旧版留作 `Mr Otto.app.bak`，新版起
不来可手动改名回滚。

发版：

```bash
npm run release -- patch
```

（`scripts/release.mjs`：强制 main + clean → 升版本打 tag → `dist:mac` 出
dmg+zip → 生成 `SHA256SUMS` → `gh release create` 传三个资产 → push。
更新器认 `-arm64-mac.zip` 后缀 + `SHA256SUMS` 这两个资产名，改产物命名前先看
`src/main/updaterCore.ts`。）

## 已知边界

- **版本号**由 `npm run release` 自动升（`npm version`）；绕开脚本手动发包的话，记得先手动升版，否则两个内容不同的包会同名。
- **深链** `mrotto://auth-callback` 靠 Info.plist 的 `CFBundleURLTypes` 注册（`electron-builder.yml` 的 `protocols`）。同一台机器上装了多份 Mr Otto 时，macOS 把 scheme 交给哪一份是它自己定的，登录可能回到你没在用的那份。
