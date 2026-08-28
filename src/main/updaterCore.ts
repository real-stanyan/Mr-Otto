// OTA 更新器的纯逻辑半边（ADR-0075）：版本比较、GitHub Release 解析、SHA256SUMS
// 解析、路径判定。零 IO、零 Electron —— vitest 直接喂数据测。
// 有副作用的另一半（下载/校验/解包/换包）在 updater.ts，真实依赖在 updaterHost.ts。

/** 更新源钉死在本仓的 GitHub Releases。public 仓库，API 无需鉴权 */
export const UPDATE_REPO = "real-stanyan/Mr-Otto";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;

/** 各平台认自家更新资产的后缀（issue #314）：mac 是 OTA 换包用的 zip，
    win 是 NSIS 安装器本身。后缀是更新器与发布产物之间的契约，动了就断更新 */
export const UPDATE_ASSET_SUFFIX = {
  darwin: "-arm64-mac.zip",
  win32: "-win-x64-setup.exe",
} as const;

/** 一次发布里换包要用的三样东西。shasumsUrl 可空——老 Release 没传校验文件时
    仍能识别出新版（但下载会因无从校验而拒绝，见 updater.ts） */
export interface ReleaseInfo {
  /** 去掉 v 前缀的版本号（tag v1.2.3 → 1.2.3） */
  version: string;
  assetUrl: string;
  /** 更新资产在 Release 里的文件名——SHA256SUMS 里按它查行 */
  assetName: string;
  shasumsUrl: string | null;
  /** Release 网页（manual 降级时开给用户） */
  pageUrl: string;
}

/** 严格 major.minor.patch。解析不了（预发布后缀、缺段、非数字）回 null——
    识别不了的 tag 宁可当"没有新版"也不能当"有" */
export function parseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewerVersion(remote: string, current: string): boolean {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  if (!r || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i]! !== c[i]!) return r[i]! > c[i]!;
  }
  return false;
}

/** releases/latest 的响应 → ReleaseInfo。形状不对/缺更新资产回 null。
    资产按平台后缀认（UPDATE_ASSET_SUFFIX），不硬编码 productName——改名不炸更新 */
export function parseLatestRelease(json: unknown, assetSuffix: string): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const rel = json as Record<string, unknown>;
  const tag = rel["tag_name"];
  if (typeof tag !== "string" || !parseVersion(tag)) return null;
  const assets = rel["assets"];
  if (!Array.isArray(assets)) return null;

  let assetUrl: string | null = null;
  let assetName: string | null = null;
  let shasumsUrl: string | null = null;
  for (const a of assets) {
    if (typeof a !== "object" || a === null) continue;
    const asset = a as Record<string, unknown>;
    const name = asset["name"];
    const url = asset["browser_download_url"];
    if (typeof name !== "string" || typeof url !== "string") continue;
    if (name.endsWith(assetSuffix)) {
      assetUrl = url;
      assetName = name;
    } else if (name === "SHA256SUMS") {
      shasumsUrl = url;
    }
  }
  if (assetUrl === null || assetName === null) return null;

  const pageUrl = typeof rel["html_url"] === "string" ? rel["html_url"] : RELEASES_PAGE_URL;
  return { version: tag.replace(/^v/, ""), assetUrl, assetName, shasumsUrl, pageUrl };
}

/** win 换包要跑的东西（issue #662）：NSIS 安装器**本身**，不经 cmd.exe。
    `/S` 静默重装到注册表里记着的原安装目录，`--force-run` 装完拉起新版；
    「等旧进程退干净」不用我们操心 —— 安装器本来就得处理「装的时候 app 在跑」。

    为什么不能再套一层批处理（原来那版的做法）：detached spawn 在 Windows 上是
    `DETACHED_PROCESS`，新进程**不继承也不新建**控制台（`windowsHide` 在这个组合下
    被 CreateProcess 忽略，MSDN 明写）。于是批处理里 `tasklist` / `find` / `ping`
    这些控制台程序启动时找不到可继承的控制台，Windows 就一人给建一个 ——
    等待循环每秒弹三个黑框，标题就是命令行（用户看到的 `find "<pid>"`）。
    安装器是 GUI 子系统程序，detached 起它压根没有控制台这回事。

    附带好处：命令行上只剩安装器路径一个参数，绕开了 `cmd /c` 那套引号剥离规则
    （`cmd /?` 规则 2：引号超过两个就剥首引号 + 删最后一个引号）—— 而本机路径
    `…\Mr Otto\updates\…` 与 `…\Mr Otto\Mr Otto.exe` 全都带空格。 */
export function winSwapSpawn(setupPath: string): { cmd: string; args: string[] } {
  return { cmd: setupPath, args: ["/S", "--force-run"] };
}

/** `shasum -a 256` 输出格式：`<hex>  <filename>`（两个空格，二进制模式是 ` *`）。
    大小写不敏感，文件名保留原样 */
export function parseShasums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

/** App Translocation：带 quarantine 标记的 app 被 macOS 拷去只读路径运行，
    原地换包无从谈起。路径特征是唯一可靠信号 */
export function isTranslocated(exePath: string): boolean {
  return exePath.includes("/AppTranslocation/");
}

/** 从 process.execPath 找 .app bundle 根。
    `/Applications/Mr Otto.app/Contents/MacOS/Mr Otto` → `/Applications/Mr Otto.app`。
    没有 .app 段（开发模式跑 Electron.app 之外的怪路径）回 null */
export function appBundlePathFromExe(exePath: string): string | null {
  const parts = exePath.split("/");
  const idx = parts.findIndex((p) => p.endsWith(".app"));
  if (idx <= 0) return null;
  return parts.slice(0, idx + 1).join("/");
}
