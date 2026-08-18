# ADR-0026：打包用 electron-builder，ad-hoc 签名、不公证

- 状态：已接受
- 日期：2026-08-19
- 关联：issue #73，`electron-builder.yml`，`docs/distribution-macos.md`，ADR-0001（Electron）

## 背景

在此之前仓库没有任何可分发的产物。`npm run build` 出的是 `out/`（electron-vite 的三个 bundle），要跑起来仍然需要 Node + `npm install` + `npm run dev`。这挡住的不只是"别人试用"——德州（#48）要 ≥2 人才玩得起来，而第二个人得先能把 app 跑起来。

新增打包工具属于 Tech stack 变更 = L1，依据维护者会话内原话「出一个苹果芯片macos的安装包」（单人仓库该路径有效，ADR-0034/0042），同 gsap 那次（#64 / ADR-0024）的先例。

## 决策

**electron-builder**（26.x），配置在 `electron-builder.yml`，产物 macOS arm64 `.dmg`。选它而不是 electron-forge：与 electron-vite 的 `out/` 产物结构直接对得上（`files` 指过去就行），不需要再引一层 Forge 的插件体系。

四个不显然的配置项，每个都对应一个"不这么写就炸"：

- **`asarUnpack: "**/*.node"`** —— `dlopen` 读不了 asar 里的文件，原生模块必须解出来。
- **`protocols: [mrotto]`** —— 开发期 `app.setAsDefaultProtocolClient("mrotto")` 就够了，打包后 macOS 靠 Info.plist 的 `CFBundleURLTypes` 决定把 scheme 交给谁。少了它，OAuth 登录会卡在浏览器那步回不来 —— 而登录是所有联网功能的入口。
- **`identity: "-"`（ad-hoc 签名）** —— 不是 `null`。`null` 是完全跳过签名，而 Apple Silicon 上未签名的 bundle 起不来。ad-hoc 让签名主体是 `com.stanyan.mrotto` 且封印覆盖整个 bundle 内容（`codesign --verify --deep --strict` 通过）。
- **`hardenedRuntime: false`** —— ad-hoc 签名 + hardened runtime 会撞上 library validation：`better-sqlite3` 的 `.node` 不是同一主体签的，加载即被拒。hardened runtime 的唯一用途是过公证，而我们公证不了，留着它只是留一个必炸的组合。

**不公证**（notarize）。公证需要 Apple Developer 账号（99 USD/年）。代价明确：从网上下载的包带 quarantine 标记，收件人首次打开要手动放行，步骤写在 `docs/distribution-macos.md`。

**只做 arm64**。Intel / Windows / Linux 不在范围内，等真有人要再说。

## 后果

- 分发链路变成"给一个 .dmg + 一句放行说明"，而不是"clone 仓库装 Node"。非技术型用户可达。
- 每个收件人首次打开都要过一道手动放行。这是不买开发者账号的直接代价，不是可以绕过的配置问题。
- 产物 136 MB（Electron 运行时占大头），`dist/` 已进 `.gitignore` —— 二进制不进仓库。
- 版本号取 `package.json` 的 `version`，目前 `1.0.0` 且没有自动升版流程。发第二个包之前得先决定怎么升，否则两个不同内容的包会同名。
- 顺带删掉了 `package.json` 根级的 `directories: {doc: docs}`：那是 npm 的元数据字段，但 electron-builder 把根级 `directories` 当成自己的配置读，冲突时直接报错退出。
- 前提若不成立就该推翻：有了 Apple Developer 账号，就该改成正式签名 + 公证，`identity` 换成证书名、`hardenedRuntime` 打开并补 entitlements，放行说明整段删掉。
