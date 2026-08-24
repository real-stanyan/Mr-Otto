import { describe, it, expect, vi } from "vitest";
import { createUpdater, type UpdaterDeps } from "../../src/main/updater.js";
import { LATEST_RELEASE_API, UPDATE_ASSET_SUFFIX } from "../../src/main/updaterCore.js";
import type { UpdaterState } from "../../src/shared/shellBridge.js";

const ZIP_NAME = "Mr.Otto-1.1.0-arm64-mac.zip";
const EXE_NAME = "Mr.Otto-1.1.0-win-x64-setup.exe";
const ASSET_SHA = "aa".repeat(32);

/** releases/latest 的最小可用响应（mac + win 资产都带） */
function releaseJson(over: object = {}) {
  return JSON.stringify({
    tag_name: "v1.1.0",
    html_url: "https://page",
    assets: [
      { name: ZIP_NAME, browser_download_url: "https://dl/zip" },
      { name: EXE_NAME, browser_download_url: "https://dl/exe" },
      { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
    ],
    ...over,
  });
}

const SUMS = `${ASSET_SHA}  ${ZIP_NAME}\n${ASSET_SHA}  ${EXE_NAME}\n`;

/** 全绿路径的假依赖（mac 席位形状）；单测按需拧坏其中一颗螺丝 */
function makeDeps(over: Partial<UpdaterDeps> = {}) {
  const states: UpdaterState[] = [];
  const deps: UpdaterDeps = {
    currentVersion: "1.0.0",
    assetSuffix: UPDATE_ASSET_SUFFIX.darwin,
    updatesDir: "/tmp/updates",
    fetchText: vi.fn(async (url: string) => {
      if (url === LATEST_RELEASE_API) return releaseJson();
      if (url === "https://dl/sums") return SUMS;
      throw new Error(`unexpected fetch ${url}`);
    }),
    downloadFile: vi.fn(async (_u, _d, onProgress) => {
      onProgress(50, 100);
      onProgress(100, 100);
    }),
    fileSha256: vi.fn(async () => ASSET_SHA),
    resetDir: vi.fn(async () => {}),
    preflight: vi.fn(() => null),
    stage: vi.fn(async () => "/tmp/updates/extracted/Mr Otto.app"),
    installAndQuit: vi.fn(),
    openExternal: vi.fn(async () => {}),
    onState: (s) => states.push(s),
    ...over,
  };
  return { deps, states };
}

describe("updater 状态机", () => {
  it("全绿路径：检查停在 available，点了才下载（issue #316），装的是暂存物", async () => {
    const { deps, states } = makeDeps();
    const u = createUpdater(deps);
    const found = await u.checkNow();
    expect(found.phase).toBe("available");
    expect(deps.downloadFile).not.toHaveBeenCalled(); // 没点之前一个字节都不下

    const final = await u.startDownload();
    expect(final.phase).toBe("ready");
    expect(states.map((s) => s.phase)).toEqual([
      "checking",
      "available",
      "downloading", // download() 起步的 0 字节帧
      "downloading",
      "downloading",
      "ready",
    ]);
    const dl = states[3] as Extract<UpdaterState, { phase: "downloading" }>;
    expect(dl.received).toBe(50);
    expect(dl.total).toBe(100);
    expect(deps.stage).toHaveBeenCalledWith(`/tmp/updates/${ZIP_NAME}`);

    await u.installAndRestart();
    expect(deps.installAndQuit).toHaveBeenCalledWith("/tmp/updates/extracted/Mr Otto.app");
  });

  it("非 available 时 startDownload 是空操作", async () => {
    const { deps } = makeDeps();
    const u = createUpdater(deps);
    expect((await u.startDownload()).phase).toBe("idle"); // 还没检查过
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("win 席位：按 exe 后缀认资产、免解包暂存、装的是安装器（issue #314）", async () => {
    const { deps } = makeDeps({
      assetSuffix: UPDATE_ASSET_SUFFIX.win32,
      stage: vi.fn(async (p: string) => p), // win 的 stage 是恒等：产物即安装器
    });
    const u = createUpdater(deps);
    expect((await u.checkNow()).phase).toBe("available");
    expect((await u.startDownload()).phase).toBe("ready");
    expect(deps.downloadFile).toHaveBeenCalledWith(
      "https://dl/exe",
      `/tmp/updates/${EXE_NAME}`,
      expect.any(Function),
    );
    await u.installAndRestart();
    expect(deps.installAndQuit).toHaveBeenCalledWith(`/tmp/updates/${EXE_NAME}`);
  });

  it("Release 缺自家平台资产 → idle 当没有新版（win 端遇到 mac-only 的老 Release）", async () => {
    const { deps } = makeDeps({
      assetSuffix: UPDATE_ASSET_SUFFIX.win32,
      fetchText: vi.fn(async (url: string) => {
        if (url === LATEST_RELEASE_API)
          return releaseJson({
            assets: [
              { name: ZIP_NAME, browser_download_url: "https://dl/zip" },
              { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
            ],
          });
        throw new Error("unexpected");
      }),
    });
    expect((await createUpdater(deps).checkNow()).phase).toBe("idle");
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("远端不比本地新 → 回 idle，不下载", async () => {
    const { deps } = makeDeps({ currentVersion: "1.1.0" });
    const u = createUpdater(deps);
    expect((await u.checkNow()).phase).toBe("idle");
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("preflight 回 reason → manual，不下载", async () => {
    const { deps } = makeDeps({
      preflight: vi.fn(() => "app 运行在受限路径（App Translocation），只能手动更新"),
    });
    const u = createUpdater(deps);
    const s = await u.checkNow();
    expect(s.phase).toBe("manual");
    expect((s as Extract<UpdaterState, { phase: "manual" }>).reason).toContain("Translocation");
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("stage 丢异常（zip 里没 .app）→ error", async () => {
    const { deps } = makeDeps({
      stage: vi.fn(async () => {
        throw new Error("zip 解开后没找到 .app——发布产物形状不对");
      }),
    });
    const u = createUpdater(deps);
    await u.checkNow();
    expect((await u.startDownload()).phase).toBe("error");
  });

  it("SHA256 不匹配 → error 且清掉下载目录；Release 缺 SHA256SUMS → error 拒下", async () => {
    const bad = makeDeps({ fileSha256: vi.fn(async () => "ff".repeat(32)) });
    const u1 = createUpdater(bad.deps);
    await u1.checkNow();
    expect((await u1.startDownload()).phase).toBe("error");
    expect(bad.deps.resetDir).toHaveBeenCalledTimes(2); // 下载前建目录 + 校验失败清理

    const noSums = makeDeps({
      fetchText: vi.fn(async (url: string) => {
        if (url === LATEST_RELEASE_API)
          return releaseJson({ assets: [{ name: ZIP_NAME, browser_download_url: "https://dl/zip" }] });
        throw new Error("unexpected");
      }),
    });
    const u2 = createUpdater(noSums.deps);
    await u2.checkNow(); // 缺 SHA256SUMS 仍能识别出新版 → available
    expect((await u2.startDownload()).phase).toBe("error");
    expect(noSums.deps.downloadFile).not.toHaveBeenCalled();
  });

  it("网络炸了 → error；下一次 checkNow 还能重来", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      fetchText: vi.fn(async (url: string) => {
        calls++;
        if (calls === 1) throw new Error("offline");
        if (url === LATEST_RELEASE_API) return releaseJson();
        return SUMS;
      }),
    });
    const u = createUpdater(deps);
    expect((await u.checkNow()).phase).toBe("error");
    expect((await u.checkNow()).phase).toBe("available");
  });

  it("checkNow 重入互斥：进行中再点只共享同一轮", async () => {
    let resolveFetch: (v: string) => void;
    const { deps } = makeDeps({
      fetchText: vi.fn(
        (url: string) =>
          new Promise<string>((res) => {
            if (url === LATEST_RELEASE_API) resolveFetch = res;
            else res(SUMS);
          }),
      ),
    });
    const u = createUpdater(deps);
    const p1 = u.checkNow();
    const p2 = u.checkNow();
    resolveFetch!(releaseJson());
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(deps.fetchText).toHaveBeenCalledTimes(1); // API 只查一次，没有第二轮（sums 在下载阶段才拉）
  });

  it("ready 后再检查同一版本：不打回 available 也不重下，状态保持 ready", async () => {
    const { deps } = makeDeps();
    const u = createUpdater(deps);
    await u.checkNow();
    await u.startDownload();
    const again = await u.checkNow();
    expect(again.phase).toBe("ready");
    expect(deps.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("非 ready 时 installAndRestart 是空操作", async () => {
    const { deps } = makeDeps();
    const u = createUpdater(deps);
    await u.installAndRestart();
    expect(deps.installAndQuit).not.toHaveBeenCalled();
  });
});
