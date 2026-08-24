# ADR-0081: OTA 更新器平台席位化，win 走静默安装器换包

日期：2026-08-24
状态：已接受
关联：ADR-0075（自研换包更新）、issue #314

## 背景

ADR-0075 的 OTA 更新器是 mac 专属：资产认 `-arm64-mac.zip` 后缀、预检查 App
Translocation、ditto 解 zip、sh 脚本换 .app。v1.0.1 起有了 Windows 安装包
（NSIS，docs/distribution-windows.md），win 用户出新版只能手动重下。

## 决策

不引 electron-updater（没有签名证书，走不通，与 ADR-0075 同理由），把自研更新器
按平台席位化：

1. **状态机与流程（updater.ts）平台无关**：检查 → 预检 → 下载 → SHA256 校验 →
   暂存 → ready → 用户点了才装。mac 特有环节抽成注入的三个席位：
   - `preflight()`：下载前判本机能不能自动换包（回 manual 的 reason 或 null）
   - `stage(下载产物)`：产物 → 可安装的暂存物
   - `installAndQuit(暂存物)`：detached 起换包流程 + 退出
2. **资产按平台后缀认**（`UPDATE_ASSET_SUFFIX`）：darwin = `-arm64-mac.zip`，
   win32 = `-win-x64-setup.exe`。后缀是更新器与发布产物的契约。
3. **win 席位实现**（updaterHost.ts）：
   - preflight 恒 null：NSIS per-user 装机目录本用户可写，win 没有 Translocation 对应物
   - stage 恒等：下载产物本身就是 NSIS 安装器
   - installAndQuit：批处理脚本 tasklist 轮询等本进程退干净 → 跑 `安装器 /S`
     静默重装（文件替换与失败回滚交给 NSIS）→ 装成功才 `start` 拉起 exe
4. **release.mjs 每个版本必出三资产**（dmg + zip + exe）并全部进 SHA256SUMS：
   缺 exe 的 Release 对 win 端等于不存在（parseLatestRelease 回 null → idle，
   良性但版本白发）。

## 后果

- win 端更新体验 = mac 同款：静默下载、SHA256 校验、用户点「重启更新」才动手。
- win 更新要跑一遍完整 NSIS 安装（几秒），比 mac 的 mv 换包重；接受——差分更新
  （blockmap）是 electron-updater 的东西，不自研。
- 老 Release（mac-only）对 win 端自动降级为「没有新版」，无需迁移。
- 发版时长增加一次 dist:win；本机（macOS）交叉出包已验证可行（issue #305/#308）。

## 推翻条件

拿到代码签名证书、或差分更新成为刚需时，重新评估 electron-updater。
