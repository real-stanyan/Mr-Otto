// 「手机」栏目 —— 手机端远程投影的配对入口(ADR-0094/0095/0139)。
//
// 这一页真正要人做的只有一件事:**让手机扫这张码**。
//
// 按账号配对与 E2E 天然打架:公钥从 Supabase 下发,掌握库的人就能发一把假的。
// 所以目录只负责"有哪几台设备",而"这把公钥是不是真的"不能问目录。二维码是
// 一条带外通道:手机直接读到桌面的公钥(中间人换不掉),码里那把一次性 secret
// 又让桌面认得出扫码的是谁 —— 一次动作,两个方向都认证了(ADR-0139)。
//
// 6 位安全码那条路留着当**降级路径**(手机没给摄像头权限时)。它要人在两台设备上
// 各按一次,而文案必须把"为什么要核对"说清楚,否则用户会当成没有意义的确认点掉。
//
// 不进 useChat store:只有这一个栏目读它,别处没有订阅方(同 MemorySettings 的判断)。

import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PairingQr } from "./PairingQr.js";
import { PAIRING_TTL_MS } from "../../../shared/remote/pairing.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { useChat } from "../store.js";
import type { RemoteRejection, RemoteStatus } from "../../../shared/shellBridge.js";

const OFF_TEXT: Record<"no-secure-storage" | "unavailable", { title: string; hint: string }> = {
  unavailable: {
    title: "读不到远程功能的状态",
    hint: "跟主进程这一问没问到。重开 Mr Otto 再看看。",
  },
  "no-secure-storage": {
    title: "这台机器没有可用的系统安全存储",
    hint: "身份私钥必须放进钥匙串,不会退而求其次写成明文文件。先解锁钥匙串再重开 Mr Otto。",
  },
};

/** 被挡下的握手,两种 reason 两套文案(issue #485)。
    合并成一条会把告警稀释成例行提示 —— 而 identity-mismatch 的另一半可能性
    是"有人在中间换了公钥",这句话必须出现在用户眼前 */
const REJECTED_TEXT: Record<RemoteRejection["reason"], { title: string; hint: string }> = {
  unpaired: {
    title: "有一台手机连过来,但还没配对",
    hint: "在上面开一张二维码,让它扫一下就好。扫不了码就核对 6 位安全码 —— 对不上就不要配。",
  },
  "identity-mismatch": {
    title: "有一台手机连不上来:身份对不上",
    hint:
      "它的身份跟这台桌面已配对的那把公钥不一致。你刚在手机上重装或重新登录过,就在下面重新核对安全码再配一次;" +
      "如果没有,那说明中间有人换掉了公钥 —— 这时候不要配。",
  },
};

export function RemoteDevicesSettings() {
  const closeSettings = useChat((s) => s.closeSettings);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 屏幕上那张码。null = 没开 */
  const [qr, setQr] = useState<{ qr: string; expiresAt: number } | null>(null);
  /** 倒计时那一行的秒数(重算靠这个 state 触发,不靠 qr 本身) */
  const [left, setLeft] = useState(0);
  /** 刚扫成功的那台。显示一句"配好了"而不是让码默默消失 */
  const [justPaired, setJustPaired] = useState<string | null>(null);
  /** 开码那一刻已经配好的是哪几台 —— 多出来的那台就是刚扫进来的 */
  const pinnedBefore = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    window.otter
      .remoteStatus()
      .then(setStatus)
      .catch(() => setStatus({ on: false, reason: "unavailable" }));
  }, []);

  useEffect(refresh, [refresh]);

  const stopPairing = useCallback((): void => {
    setQr(null);
    void window.otter.remoteCancelPairing();
  }, []);

  // 码开着的时候盯两件事:秒数走完了自己收掉,以及有没有新的一台配进来。
  // 用轮询而不是加一条推送通道:这个面板的生命周期以"人站在屏幕前"计,
  // 两秒一问的成本可以忽略,而多一条 IPC 推送要多一处生命周期要管
  useEffect(() => {
    if (!qr) return;
    const tick = (): void => {
      const secs = Math.max(0, Math.ceil((qr.expiresAt - Date.now()) / 1000));
      setLeft(secs);
      if (secs === 0) stopPairing();
    };
    tick();
    const timer = window.setInterval(tick, 500);
    const poll = window.setInterval(() => {
      window.otter
        .remoteStatus()
        .then((next) => {
          setStatus(next);
          if (!next.on) return;
          const fresh = next.peers.find((p) => p.pinned && !pinnedBefore.current.has(p.deviceId));
          if (!fresh) return;
          setJustPaired(fresh.label || fresh.deviceId);
          setQr(null); // 码在主进程那边已经用掉了,这儿只是把图收起来
        })
        .catch(() => {});
    }, 2000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(poll);
    };
  }, [qr, stopPairing]);

  // 离开这一页就把码撤掉 —— 码不该在没人看着的时候还活着
  useEffect(() => () => void window.otter.remoteCancelPairing(), []);

  const startPairing = async (): Promise<void> => {
    setJustPaired(null);
    pinnedBefore.current = new Set(
      status?.on ? status.peers.filter((p) => p.pinned).map((p) => p.deviceId) : []
    );
    const started = await window.otter.remoteStartPairing();
    if (started) setQr(started);
  };

  const pair = async (deviceId: string): Promise<void> => {
    setBusy(deviceId);
    try {
      await window.otter.remotePairDevice(deviceId);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  // "已配对"那个标记同时是解除配对的入口。做成 ghost 按钮而不是另起一个红色的
  // "解除":这一屏的主动作是配对,解除是回头路,不该在视觉上跟它平起平坐
  const unpair = async (deviceId: string, label: string): Promise<void> => {
    if (!window.confirm(`解除和「${label}」的配对？它就连不上这台电脑了，之后可以重新核对安全码再配。`)) return;
    setBusy(deviceId);
    try {
      await window.otter.remoteUnpairDevice(deviceId);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  // 确认放在渲染层(同 MemorySettings 删项目记忆的那条)。**已配对的那台要多说一句**:
  // 删它会连着解除配对,而列表上"已配对"三个字不会让人预期到这一层
  const forget = async (deviceId: string, label: string, pinned: boolean): Promise<void> => {
    const extra = pinned ? "，配对会一起解除" : "";
    if (!window.confirm(`把「${label}」从目录里删掉${extra}？装着 Mr Otto 的设备下次打开会重新出现。`)) return;
    setBusy(deviceId);
    try {
      await window.otter.remoteForgetDevice(deviceId);
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
            {status.rejected ? (
              /* 告警用 destructive,例行提示用普通边框:这两条的紧急程度不一样 */
              <div
                className={`rounded-lg border p-4 ${
                  status.rejected.reason === "identity-mismatch"
                    ? "border-destructive/60 bg-destructive/5"
                    : "border-border"
                }`}
              >
                <p className="font-[650]">{REJECTED_TEXT[status.rejected.reason].title}</p>
                <p className={`${HINT} mt-1`}>{REJECTED_TEXT[status.rejected.reason].hint}</p>
                <p className={`${HINT} mt-1`}>
                  设备 <code className="font-mono">{status.rejected.deviceId}</code> ·{" "}
                  {new Date(status.rejected.at).toLocaleString()}
                </p>
              </div>
            ) : null}

            <div className="rounded-lg border border-border p-4">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-[650]">用手机扫一下就配好</p>
                  <p className={`${HINT} mt-1`}>
                    在手机上打开 Mr Otto,点「扫码配对」,对准这张码。
                    <b>只需要在手机上动一次</b> —— 这台电脑不用再确认第二遍。
                  </p>
                  <p className={`${HINT} mt-1`}>
                    码是<b>一次性</b>的,{Math.round(PAIRING_TTL_MS / 60_000)} 分钟内有效,配好一台就作废。
                    再配一台就再开一张。
                  </p>
                  {justPaired ? (
                    <p className="mt-2 font-[650] text-foreground">配好了：{justPaired}</p>
                  ) : null}
                </div>
                {qr ? (
                  <div className="flex shrink-0 flex-col items-center gap-2">
                    <PairingQr text={qr.qr} />
                    <p className={HINT}>
                      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后失效
                    </p>
                    <Button variant="ghost" size="sm" onClick={stopPairing}>
                      收起
                    </Button>
                  </div>
                ) : (
                  <Button className="shrink-0" onClick={() => void startPairing()}>
                    <QrCode className="size-4" />
                    显示二维码
                  </Button>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border p-4">
              <p className="font-[650]">扫不了码的话:核对 6 位安全码</p>
              <p className={`${HINT} mt-1`}>
                手机没给摄像头权限时走这条。<b>两台设备上各按一次</b>,
                比扫码多一步 —— 而多出来的那一步正是扫码替你做掉的那半边认证。
              </p>
              <p className={`${HINT} mt-1`}>
                手机上会显示同样的 6 位数。<b>对不上就不要配</b> —— 那说明中间有人换掉了公钥。
                可以配<b>多台</b>,换手机不用先解除旧的,<b>也能同时连着</b> ——
                各看各的会话,互不打断。同一个审批谁先按谁算,晚按的那次没有效果。
              </p>
              <p className={`${HINT} mt-1`}>
                同一台手机<b>换一个安装</b>(Expo Go / 正式 app / 重装)会是<b>新的一行</b> ——
                身份私钥在各自的钥匙串里,新安装读不到旧的,只能重新生成。用不上的行在右边删掉。
              </p>
            </div>

            {/* 重名的行才显 id。**同名是这张表的常态**(同一台手机的两份安装、两台同型号
                的手机),而 id 是一串随机 base64 —— 每行都挂着它,人反而更难扫。
                只在真的分不清时才拿出来 */}
            {status.peers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <Smartphone className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 font-[650]">还没有手机登记到这个账号</p>
                <p className={`${HINT} mt-1`}>在手机上用同一个账号登录 Mr Otto,这里就会出现。</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {status.peers.map((p, _i, all) => (
                  <li
                    key={p.deviceId}
                    className="flex items-center gap-4 rounded-lg border border-border p-4"
                  >
                    <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-[650]">{p.label || p.deviceId}</p>
                      <p className={HINT}>
                        最后在线 {new Date(p.lastSeen).toLocaleString()}
                        {all.filter((q) => q.label === p.label).length > 1 ? (
                          <> · <code className="font-mono">{p.deviceId.slice(0, 6)}</code></>
                        ) : null}
                      </p>
                    </div>
                    {/* 等宽 + 拉开字距:这串数字是拿来跟另一块屏幕逐位比对的 */}
                    <code className="font-mono text-lg tracking-[0.2em] tabular-nums">{p.code}</code>
                    {p.pinned ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        disabled={busy === p.deviceId}
                        onClick={() => void unpair(p.deviceId, p.label || p.deviceId)}
                      >
                        {busy === p.deviceId ? "解除中…" : "已配对"}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busy === p.deviceId} onClick={() => void pair(p.deviceId)}>
                        {busy === p.deviceId ? "配对中…" : "安全码一致，配对"}
                      </Button>
                    )}
                    {/* 删除是这一行的次要动作:图标按钮、不占位置,hover 才显红。
                        做成并排的第二个实体按钮会跟"配对"抢主次 —— 而配对才是这一屏要人做的事 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="从目录里删掉"
                      aria-label={`把 ${p.label || p.deviceId} 从目录里删掉`}
                      disabled={busy === p.deviceId}
                      onClick={() => void forget(p.deviceId, p.label || p.deviceId, p.pinned)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
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
