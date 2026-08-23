// OTA 更新器的纯逻辑半边（ADR-0075）：版本比较、GitHub Release 解析、SHA256SUMS
// 解析、路径判定。零 IO、零 Electron —— vitest 直接喂数据测。
// 有副作用的另一半（下载/校验/解包/换包）在 updater.ts，真实依赖在 updaterHost.ts。

/** 更新源钉死在本仓的 GitHub Releases。public 仓库，API 无需鉴权 */
export const UPDATE_REPO = "real-stanyan/Mr-Otto";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;

/** 一次发布里换包要用的三样东西。shasumsUrl 可空——老 Release 没传校验文件时
    仍能识别出新版（但下载会因无从校验而拒绝，见 updater.ts） */
export interface ReleaseInfo {
  /** 去掉 v 前缀的版本号（tag v1.2.3 → 1.2.3） */
  version: string;
  zipUrl: string;
  /** zip 资产在 Release 里的文件名——SHA256SUMS 里按它查行 */
  zipName: string;
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

/** releases/latest 的响应 → ReleaseInfo。形状不对/缺 zip 资产回 null。
    资产按后缀认（-arm64-mac.zip），不硬编码 productName——改名不炸更新 */
export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const rel = json as Record<string, unknown>;
  const tag = rel["tag_name"];
  if (typeof tag !== "string" || !parseVersion(tag)) return null;
  const assets = rel["assets"];
  if (!Array.isArray(assets)) return null;

  let zipUrl: string | null = null;
  let zipName: string | null = null;
  let shasumsUrl: string | null = null;
  for (const a of assets) {
    if (typeof a !== "object" || a === null) continue;
    const asset = a as Record<string, unknown>;
    const name = asset["name"];
    const url = asset["browser_download_url"];
    if (typeof name !== "string" || typeof url !== "string") continue;
    if (name.endsWith("-arm64-mac.zip")) {
      zipUrl = url;
      zipName = name;
    } else if (name === "SHA256SUMS") {
      shasumsUrl = url;
    }
  }
  if (zipUrl === null || zipName === null) return null;

  const pageUrl = typeof rel["html_url"] === "string" ? rel["html_url"] : RELEASES_PAGE_URL;
  return { version: tag.replace(/^v/, ""), zipUrl, zipName, shasumsUrl, pageUrl };
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
