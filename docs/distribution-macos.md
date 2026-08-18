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

## 已知边界

- **版本号**取自 `package.json` 的 `version`，目前没有自动升版。发第二个包前先手动升，否则两个内容不同的包会同名。
- **深链** `mrotto://auth-callback` 靠 Info.plist 的 `CFBundleURLTypes` 注册（`electron-builder.yml` 的 `protocols`）。同一台机器上装了多份 Mr Otto 时，macOS 把 scheme 交给哪一份是它自己定的，登录可能回到你没在用的那份。
