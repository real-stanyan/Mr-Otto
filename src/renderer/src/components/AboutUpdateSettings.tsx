// 「关于与更新」栏目（ADR-0075）：当前版本 + OTA 更新状态卡。
// 状态一律从主进程来：首帧 updaterGetState 拉快照，此后 onUpdaterState 订阅推送
// ——后台定时检查在设置页没开时也在走，开页那刻要能直接看到 ready。
// 「重启更新」是唯一会打断当前会话的动作，所以必须是用户亲手点的。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import type { UpdaterState } from "../../../shared/shellBridge.js";

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** 状态一句话。downloading 带进度，total 未知（服务器没报长度）时只报已收 */
function describe(state: UpdaterState): string {
  switch (state.phase) {
    case "idle":
      return "已是最新版本";
    case "checking":
      return "正在检查更新…";
    case "available":
      return `发现新版 v${state.version}，即将开始下载…`;
    case "downloading": {
      const got = formatMb(state.received);
      return state.total > 0
        ? `正在下载 v${state.version}：${got} / ${formatMb(state.total)} MB`
        : `正在下载 v${state.version}：${got} MB`;
    }
    case "ready":
      return `新版 v${state.version} 已就绪，重启后生效`;
    case "manual":
      return `发现新版 v${state.version}，但${state.reason}`;
    case "error":
      return `更新出错：${state.message}`;
    case "disabled":
      return state.reason;
  }
}

export function AboutUpdateSettings() {
  // null = 首帧快照还没回来（按钮全禁用，同 AutoCompactSettings 的 loaded 模式）
  const [state, setState] = useState<UpdaterState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .updaterGetState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(bridgeErrorMessage(e));
      });
    const unsub = window.otter.onUpdaterState((s) => setState(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const call = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  const busy = state === null || state.phase === "checking" || state.phase === "downloading";

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="about" className="flex-1" />
      </header>
      <section className={SETTINGS_BODY}>
        <div className="flex flex-col gap-4 rounded-[10px] border border-border px-[14px] py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">
                Mr Otto {state !== null && `v${state.currentVersion}`}
              </span>
              <p className={HINT}>{state === null ? "读取更新状态…" : describe(state)}</p>
            </div>
            {state?.phase === "ready" ? (
              <Button
                size="sm"
                className="active:scale-[0.97]"
                onClick={() => call(window.otter.updaterInstallAndRestart())}
              >
                重启更新
              </Button>
            ) : state?.phase === "available" ? (
              <Button
                size="sm"
                className="active:scale-[0.97]"
                onClick={() => call(window.otter.updaterStartDownload())}
              >
                下载
              </Button>
            ) : state?.phase === "manual" ? (
              <Button
                size="sm"
                variant="outline"
                className="active:scale-[0.97]"
                onClick={() => call(window.otter.updaterOpenReleasePage())}
              >
                去下载页
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="active:scale-[0.97]"
                disabled={busy || state?.phase === "disabled"}
                onClick={() => call(window.otter.updaterCheckNow())}
              >
                检查更新
              </Button>
            )}
          </div>
          <p className={`${HINT} border-t border-border pt-3`}>
            发现新版会自动下载并在侧栏出卡片（带进度）；点「重启更新」才换新版，
            全程不打断任何会话。更新源是本项目的 GitHub Releases。
          </p>
        </div>
        {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
      </section>
    </div>
  );
}
