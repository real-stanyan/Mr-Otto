import { describe, it, expect, vi } from "vitest";
import { createUpdater, type UpdaterDeps } from "../../src/main/updater.js";
import { LATEST_RELEASE_API } from "../../src/main/updaterCore.js";
import type { UpdaterState } from "../../src/shared/shellBridge.js";

const ZIP_NAME = "Mr Otto-1.1.0-arm64-mac.zip";
const ZIP_SHA = "aa".repeat(32);

/** releases/latest 的最小可用响应 */
function releaseJson(over: object = {}) {
  return JSON.stringify({
    tag_name: "v1.1.0",
    html_url: "https://page",
    assets: [
      { name: ZIP_NAME, browser_download_url: "https://dl/zip" },
      { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
    ],
    ...over,
  });
}

/** 全绿路径的假依赖；单测按需拧坏其中一颗螺丝 */
function makeDeps(over: Partial<UpdaterDeps> = {}) {
  const states: UpdaterState[] = [];
  const deps: UpdaterDeps = {
    currentVersion: "1.0.0",
    exePath: "/Applications/Mr Otto.app/Contents/MacOS/Mr Otto",
    updatesDir: "/tmp/updates",
    fetchText: vi.fn(async (url: string) => {
      if (url === LATEST_RELEASE_API) return releaseJson();
      if (url === "https://dl/sums") return `${ZIP_SHA}  ${ZIP_NAME}\n`;
      throw new Error(`unexpected fetch ${url}`);
    }),
    downloadFile: vi.fn(async (_u, _d, onProgress) => {
      onProgress(50, 100);
      onProgress(100, 100);
    }),
    fileSha256: vi.fn(async () => ZIP_SHA),
    extractZip: vi.fn(async () => {}),
    findAppBundle: vi.fn(async () => "/tmp/updates/extracted/Mr Otto.app"),
    resetDir: vi.fn(async () => {}),
    canWrite: vi.fn(() => true),
    spawnSwapAndQuit: vi.fn(),
    openExternal: vi.fn(async () => {}),
    onState: (s) => states.push(s),
    ...over,
  };
  return { deps, states };
}

describe("updater 状态机", () => {
  it("全绿路径：checking → downloading（带进度）→ ready；installAndRestart 换包", async () => {
    const { deps, states } = makeDeps();
    const u = createUpdater(deps);
    const final = await u.checkNow();
    expect(final.phase).toBe("ready");
    expect(states.map((s) => s.phase)).toEqual([
      "checking",
      "downloading", // download() 起步的 0 字节帧
      "downloading",
      "downloading",
      "ready",
    ]);
    const dl = states[2] as Extract<UpdaterState, { phase: "downloading" }>;
    expect(dl.received).toBe(50);
    expect(dl.total).toBe(100);

    await u.installAndRestart();
    expect(deps.spawnSwapAndQuit).toHaveBeenCalledWith(
      "/Applications/Mr Otto.app",
      "/tmp/updates/extracted/Mr Otto.app",
    );
  });

  it("远端不比本地新 → 回 idle，不下载", async () => {
    const { deps } = makeDeps({ currentVersion: "1.1.0" });
    const u = createUpdater(deps);
    expect((await u.checkNow()).phase).toBe("idle");
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("Translocation → manual，不下载", async () => {
    const { deps } = makeDeps({
      exePath: "/private/var/folders/x/AppTranslocation/AB/d/Mr Otto.app/Contents/MacOS/Mr Otto",
    });
    const u = createUpdater(deps);
    const s = await u.checkNow();
    expect(s.phase).toBe("manual");
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it(".app 父目录不可写 → manual，reason 带路径", async () => {
    const { deps } = makeDeps({ canWrite: vi.fn(() => false) });
    const s = await createUpdater(deps).checkNow();
    expect(s.phase).toBe("manual");
    expect((s as Extract<UpdaterState, { phase: "manual" }>).reason).toContain("/Applications");
  });

  it("SHA256 不匹配 → error 且清掉下载目录；Release 缺 SHA256SUMS → error 拒下", async () => {
    const bad = makeDeps({ fileSha256: vi.fn(async () => "ff".repeat(32)) });
    const s1 = await createUpdater(bad.deps).checkNow();
    expect(s1.phase).toBe("error");
    expect(bad.deps.resetDir).toHaveBeenCalledTimes(2); // 下载前建目录 + 校验失败清理

    const noSums = makeDeps({
      fetchText: vi.fn(async (url: string) => {
        if (url === LATEST_RELEASE_API)
          return releaseJson({ assets: [{ name: ZIP_NAME, browser_download_url: "https://dl/zip" }] });
        throw new Error("unexpected");
      }),
    });
    const s2 = await createUpdater(noSums.deps).checkNow();
    expect(s2.phase).toBe("error");
    expect(noSums.deps.downloadFile).not.toHaveBeenCalled();
  });

  it("网络炸了 → error；下一次 checkNow 还能重来", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      fetchText: vi.fn(async (url: string) => {
        calls++;
        if (calls === 1) throw new Error("offline");
        if (url === LATEST_RELEASE_API) return releaseJson();
        return `${ZIP_SHA}  ${ZIP_NAME}\n`;
      }),
    });
    const u = createUpdater(deps);
    expect((await u.checkNow()).phase).toBe("error");
    expect((await u.checkNow()).phase).toBe("ready");
  });

  it("checkNow 重入互斥：进行中再点只共享同一轮", async () => {
    let resolveFetch: (v: string) => void;
    const { deps } = makeDeps({
      fetchText: vi.fn(
        (url: string) =>
          new Promise<string>((res) => {
            if (url === LATEST_RELEASE_API) resolveFetch = res;
            else res(`${ZIP_SHA}  ${ZIP_NAME}\n`);
          }),
      ),
    });
    const u = createUpdater(deps);
    const p1 = u.checkNow();
    const p2 = u.checkNow();
    resolveFetch!(releaseJson());
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(deps.fetchText).toHaveBeenCalledTimes(2); // API 一次 + sums 一次，没有第二轮
  });

  it("ready 后再检查同一版本：不重下，状态保持 ready", async () => {
    const { deps } = makeDeps();
    const u = createUpdater(deps);
    await u.checkNow();
    const again = await u.checkNow();
    expect(again.phase).toBe("ready");
    expect(deps.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("非 ready 时 installAndRestart 是空操作", async () => {
    const { deps } = makeDeps();
    const u = createUpdater(deps);
    await u.installAndRestart();
    expect(deps.spawnSwapAndQuit).not.toHaveBeenCalled();
  });
});
