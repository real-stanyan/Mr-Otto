// OTA 更新器的编排半边（ADR-0075，平台席位化见 ADR-0081 / issue #314）：
// 状态机 + 检查/下载/校验/暂存的流程。平台差异（mac 换 .app / win 静默重装）
// 全部收进注入的 UpdaterDeps 三个席位：preflight / stage / installAndQuit。
// 所有 IO 走注入依赖 —— vitest 用假依赖测全部分支；真实现在 updaterHost.ts。
//
// 状态机：idle → checking → downloading → ready → (installAndRestart 退出)
//                    ↘ manual（preflight 判定查得到装不了）
//                    ↘ error（下个周期重试）
// 换包时机永远在用户点了「重启更新」之后——静默下载、绝不打断正在跑的会话。

import type { UpdaterState } from "../shared/shellBridge.js";
import {
  LATEST_RELEASE_API,
  RELEASES_PAGE_URL,
  isNewerVersion,
  parseLatestRelease,
  parseShasums,
  type ReleaseInfo,
} from "./updaterCore.js";

export interface UpdaterDeps {
  currentVersion: string;
  /** 平台认更新资产的后缀（UPDATE_ASSET_SUFFIX） */
  assetSuffix: string;
  /** 下载与暂存的工作目录（userData/updates）。每轮下载前整个重建 */
  updatesDir: string;
  fetchText(url: string): Promise<string>;
  /** 下载到目标路径。onProgress 以字节计；total 未知时报 0 */
  downloadFile(
    url: string,
    dest: string,
    onProgress: (received: number, total: number) => void,
  ): Promise<void>;
  fileSha256(path: string): Promise<string>;
  /** rm -rf + mkdir -p */
  resetDir(dir: string): Promise<void>;
  /** 下载前预检：本机能不能自动换包。回 null = 能；回字符串 = manual 的 reason。
      mac 查 Translocation + .app 父目录可写；win 没有对应限制，恒 null */
  preflight(): string | null;
  /** 校验过的下载产物 → 可安装的暂存物路径。mac 解 zip 找 .app（形状不对丢异常）；
      win 下载产物本身就是 NSIS 安装器，原样返回 */
  stage(downloadedPath: string): Promise<string>;
  /** detached 起换包流程 + app.quit()。mac 是 swap 脚本换 .app 再 open；
      win 是批处理等本进程退干净、跑安装器 /S 静默重装、再拉起 exe */
  installAndQuit(stagedPath: string): void;
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
  /** ready 后换包要用的暂存产物路径（状态里不带——渲染层用不着） */
  let stagedPath: string | null = null;
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
      const release = parseLatestRelease(
        JSON.parse(await deps.fetchText(LATEST_RELEASE_API)),
        deps.assetSuffix,
      );
      if (release === null || !isNewerVersion(release.version, deps.currentVersion)) {
        setState({ phase: "idle", currentVersion: deps.currentVersion });
        return state;
      }
      // 有新版。先判本机能不能自动换包，不能就别浪费流量下载
      const blocked = deps.preflight();
      if (blocked !== null) {
        setState({
          phase: "manual",
          currentVersion: deps.currentVersion,
          version: release.version,
          reason: blocked,
        });
        return state;
      }
      // 上一轮已就绪的同一版本：暂存产物还在就不重下
      if (prev.phase === "ready" && prev.version === release.version && stagedPath !== null) {
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
    const downloadPath = `${deps.updatesDir}/${release.assetName}`;
    setState({
      phase: "downloading",
      currentVersion: deps.currentVersion,
      version: release.version,
      received: 0,
      total: 0,
    });
    await deps.downloadFile(release.assetUrl, downloadPath, (received, total) => {
      setState({
        phase: "downloading",
        currentVersion: deps.currentVersion,
        version: release.version,
        received,
        total,
      });
    });

    const shasums = parseShasums(await deps.fetchText(release.shasumsUrl));
    const expected = shasums.get(release.assetName);
    if (expected === undefined) {
      throw new Error(`SHA256SUMS 里没有 ${release.assetName} 的条目`);
    }
    const actual = await deps.fileSha256(downloadPath);
    if (actual.toLowerCase() !== expected) {
      await deps.resetDir(deps.updatesDir); // 坏文件别留着等下一轮误用
      throw new Error("下载的更新包 SHA256 校验不过（可能下载损坏），已丢弃");
    }

    stagedPath = await deps.stage(downloadPath);
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
      if (state.phase !== "ready" || stagedPath === null) return;
      deps.installAndQuit(stagedPath);
    },
    async openReleasePage() {
      await deps.openExternal(RELEASES_PAGE_URL);
    },
  };
}
