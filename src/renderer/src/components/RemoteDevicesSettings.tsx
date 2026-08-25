// 「手机」栏目 —— 手机端远程投影的配对入口(ADR-0094/0095)。
//
// 这一页真正要人做的只有一件事:**核对 6 位安全码**。
//
// 按账号配对与 E2E 天然打架:公钥从 Supabase 下发,掌握库的人就能发一把假的。
// 所以目录只负责"有哪几台设备",而"这把公钥是不是真的"由人判断 —— 两端各自
// 用两把公钥算出同一个 6 位数,对上了才 pin。文案必须把这件事说清楚,
// 否则用户会把它当成一个没有意义的确认按钮直接点掉。
//
// 不进 useChat store:只有这一个栏目读它,别处没有订阅方(同 MemorySettings 的判断)。

import { useCallback, useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { useChat } from "../store.js";
import type { RemoteStatus } from "../../../shared/shellBridge.js";

const OFF_TEXT: Record<"disabled" | "no-secure-storage", { title: string; hint: string }> = {
  disabled: {
    title: "远程功能没有开启",
    hint: "这一版还在灰度:用 OTTO_REMOTE=1 启动才会开。配对流程稳定之后会去掉这个开关。",
  },
  "no-secure-storage": {
    title: "这台机器没有可用的系统安全存储",
    hint: "身份私钥必须放进钥匙串,不会退而求其次写成明文文件。先解锁钥匙串再重开 Mr Otto。",
  },
};

export function RemoteDevicesSettings() {
  const closeSettings = useChat((s) => s.closeSettings);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.otter
      .remoteStatus()
      .then(setStatus)
      .catch(() => setStatus({ on: false, reason: "disabled" }));
  }, []);

  useEffect(refresh, [refresh]);

  const pair = async (deviceId: string): Promise<void> => {
    setBusy(deviceId);
    try {
      await window.otter.remotePairDevice(deviceId);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="remote" />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void closeSettings()}>
          关闭
        </Button>
      </header>

      <div className={SETTINGS_BODY}>
        {status === null ? (
          <p className={HINT}>读取中…</p>
        ) : !status.on ? (
          <div className="rounded-lg border border-border p-4">
            <p className="font-[650]">{OFF_TEXT[status.reason].title}</p>
            <p className={`${HINT} mt-1`}>{OFF_TEXT[status.reason].hint}</p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border p-4">
              <p className="font-[650]">配对前先核对安全码</p>
              <p className={`${HINT} mt-1`}>
                手机上会显示同样的 6 位数。<b>对不上就不要配</b> —— 那说明中间有人换掉了公钥。
                配对之后这台桌面只认这一台手机,换手机要在这里重新配一次。
              </p>
            </div>

            {status.peers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <Smartphone className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 font-[650]">还没有手机登记到这个账号</p>
                <p className={`${HINT} mt-1`}>在手机上用同一个账号登录 Mr Otto,这里就会出现。</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {status.peers.map((p) => (
                  <li
                    key={p.deviceId}
                    className="flex items-center gap-4 rounded-lg border border-border p-4"
                  >
                    <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-[650]">{p.label || p.deviceId}</p>
                      <p className={HINT}>最后在线 {new Date(p.lastSeen).toLocaleString()}</p>
                    </div>
                    {/* 等宽 + 拉开字距:这串数字是拿来跟另一块屏幕逐位比对的 */}
                    <code className="font-mono text-lg tracking-[0.2em] tabular-nums">{p.code}</code>
                    {p.pinned ? (
                      <span className="text-[13px] text-muted-foreground">已配对</span>
                    ) : (
                      <Button size="sm" disabled={busy === p.deviceId} onClick={() => void pair(p.deviceId)}>
                        {busy === p.deviceId ? "配对中…" : "安全码一致，配对"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
