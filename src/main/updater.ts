// OTA 更新器的编排半边（ADR-0075）：状态机 + 检查/下载/校验/解包/换包的流程。
// 所有 IO 走注入的 UpdaterDeps —— vitest 用假依赖测全部分支；真实现在 updaterHost.ts。
//
// 状态机：idle → checking → downloading → ready → (installAndRestart 退出)
//                    ↘ manual（Translocation/不可写：查得到装不了）
//                    ↘ error（下个周期重试）
// 换包时机永远在用户点了「重启更新」之后——静默下载、绝不打断正在跑的会话。

import type { UpdaterState } from "../shared/shellBridge.js";
import {
  LATEST_RELEASE_API,
  RELEASES_PAGE_URL,
  appBundlePathFromExe,
  isNewerVersion,
  isTranslocated,
  parseLatestRelease,
  parseShasums,
  type ReleaseInfo,
} from "./updaterCore.js";

export interface UpdaterDeps {
  currentVersion: string;
  /** process.execPath —— Translocation 判定 + .app 根定位都从它出发 */
  exePath: string;
  /** 下载与解包的工作目录（userData/updates）。每轮下载前整个重建 */
  updatesDir: string;
  fetchText(url: string): Promise<string>;
  /** 下载到目标路径。onProgress 以字节计；total 未知时报 0 */
  downloadFile(
    url: string,
    dest: string,
    onProgress: (received: number, total: number) => void,
  ): Promise<void>;
  fileSha256(path: string): Promise<string>;
  /** 必须保符号链接和执行位（真实现用 ditto -xk——Node 解压库会把 .app 拆坏） */
  extractZip(zipPath: string, destDir: string): Promise<void>;
  /** 解包目录里找 *.app（zip 根上就一个）。找不到回 null */
  findAppBundle(dir: string): Promise<string | null>;
  /** rm -rf + mkdir -p */
  resetDir(dir: string): Promise<void>;
  /** 目标目录（.app 的父目录）当前进程可写？ */
  canWrite(dir: string): boolean;
  /** 写换包脚本、detached spawn、app.quit()。脚本等本进程退干净再动文件 */
  spawnSwapAndQuit(appBundlePath: string, newAppPath: string): void;
  openExternal(url: string): Promise<void>;
  /** 状态出口——每次变更推一份给渲染层 */
  onState(state: UpdaterState): void;
}

export interface Updater {
  getState(): UpdaterState;
  checkNow(): Promise<UpdaterState>;
  installAndRestart(): Promise<void>;
  openReleasePage(): Promise<void>;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  let state: UpdaterState = { phase: "idle", currentVersion: deps.currentVersion };
  /** ready 后换包脚本要用的解包产物路径（状态里不带——渲染层用不着） */
  let stagedAppPath: string | null = null;
  /** 查询/下载进行中的互斥：定时器和手动按钮撞上时只跑一轮 */
  let inFlight: Promise<UpdaterState> | null = null;

  function setState(next: UpdaterState) {
    state = next;
    deps.onState(next);
  }

  async function runCheck(): Promise<UpdaterState> {
    const prev = state;
    setState({ phase: "checking", currentVersion: deps.currentVersion });
    try {
      const release = parseLatestRelease(JSON.parse(await deps.fetchText(LATEST_RELEASE_API)));
      if (release === null || !isNewerVersion(release.version, deps.currentVersion)) {
        setState({ phase: "idle", currentVersion: deps.currentVersion });
        return state;
      }
      // 有新版。先判本机能不能自动换包，不能就别浪费流量下载
      const bundle = appBundlePathFromExe(deps.exePath);
      if (bundle === null || isTranslocated(deps.exePath)) {
        setState({
          phase: "manual",
          currentVersion: deps.currentVersion,
          version: release.version,
          reason: "app 运行在受限路径（App Translocation），只能手动更新",
        });
        return state;
      }
      const parentDir = bundle.slice(0, bundle.lastIndexOf("/")) || "/";
      if (!deps.canWrite(parentDir)) {
        setState({
          phase: "manual",
          currentVersion: deps.currentVersion,
          version: release.version,
          reason: `${parentDir} 不可写，只能手动更新`,
        });
        return state;
      }
      // 上一轮已就绪的同一版本：解包产物还在就不重下
      if (prev.phase === "ready" && prev.version === release.version && stagedAppPath !== null) {
        setState(prev);
        return state;
      }
      await download(release);
      return state;
    } catch (e) {
      setState({
        phase: "error",
        currentVersion: deps.currentVersion,
        message: e instanceof Error ? e.message : String(e),
      });
      return state;
    }
  }

  async function download(release: ReleaseInfo): Promise<void> {
    if (release.shasumsUrl === null) {
      throw new Error("Release 缺 SHA256SUMS 资产，拒绝无校验下载");
    }
    await deps.resetDir(deps.updatesDir);
    const zipPath = `${deps.updatesDir}/${release.zipName}`;
    setState({
      phase: "downloading",
      currentVersion: deps.currentVersion,
      version: release.version,
      received: 0,
      total: 0,
    });
    await deps.downloadFile(release.zipUrl, zipPath, (received, total) => {
      setState({
        phase: "downloading",
        currentVersion: deps.currentVersion,
        version: release.version,
        received,
        total,
      });
    });

    const shasums = parseShasums(await deps.fetchText(release.shasumsUrl));
    const expected = shasums.get(release.zipName);
    if (expected === undefined) {
      throw new Error(`SHA256SUMS 里没有 ${release.zipName} 的条目`);
    }
    const actual = await deps.fileSha256(zipPath);
    if (actual.toLowerCase() !== expected) {
      await deps.resetDir(deps.updatesDir); // 坏文件别留着等下一轮误用
      throw new Error("下载的 zip SHA256 校验不过（可能下载损坏），已丢弃");
    }

    const extractDir = `${deps.updatesDir}/extracted`;
    await deps.extractZip(zipPath, extractDir);
    const appPath = await deps.findAppBundle(extractDir);
    if (appPath === null) {
      throw new Error("zip 解开后没找到 .app——发布产物形状不对");
    }
    stagedAppPath = appPath;
    setState({ phase: "ready", currentVersion: deps.currentVersion, version: release.version });
  }

  return {
    getState: () => state,
    checkNow() {
      if (inFlight === null) {
        inFlight = runCheck().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    async installAndRestart() {
      if (state.phase !== "ready" || stagedAppPath === null) return;
      const bundle = appBundlePathFromExe(deps.exePath);
      if (bundle === null) return; // checkNow 已挡过；防御性再挡一次
      deps.spawnSwapAndQuit(bundle, stagedAppPath);
    },
    async openReleasePage() {
      await deps.openExternal(RELEASES_PAGE_URL);
    },
  };
}
