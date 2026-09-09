// VoiceCallBar —— 云会话头部之下那条「语音通话中」（#1163），照微信群语音那条浮条。
//
// 画的是**团队事实**（日志里的通话名单，`voiceCallOf`）：没订阅的成员也看得见谁在通话
// 里——他只是听不了（「加入」那颗换成一句话，不画一颗点了必然失败的钮，#722 纪律）。
// 「我在听」是本机状态（store.voice）：正在说话的那只外圈亮一道品牌色环 + 呼吸——群里
// 靠这个分谁在说。
//
// 两颗动作的语义（维护者拍板 ⑥）：**「结束通话」= 全组**（一条空名单事件，所有人的栏都
// 消失，所以要二次确认——确认框由调用方包，这个组件不碰 ConfirmProvider）；**「静音」=
// 本机**（只是我这台不播，通话照旧）。「加人」与输入框那颗语音钮是同一个弹层。
// 计时从这一场第一条非空名单事件的 ts 起（`sinceTs`），每秒一跳、作用域圈在这条栏里。

import { useEffect, useState } from "react";
import { Phone, PhoneOff, UserPlus, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import { agentNameOf } from "../lib/workspaceView.js";
import { VoicePickerPopover } from "./VoicePickerPopover.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { VoiceCallState } from "../../../shared/voiceCall.js";
import type { CloudAck } from "../../../shared/shellBridge.js";
import type { VoiceListenState } from "../store.js";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceCallBar({
  ws,
  call,
  voice,
  available,
  ready,
  onJoin,
  onMute,
  onUpdate,
  onEnd,
}: {
  ws: WorkspaceSnapshot;
  call: VoiceCallState;
  /** 我这台在不在听（null = 没加入） */
  voice: VoiceListenState | null;
  /** 语音对我可不可用（订阅 + 网关供语音）——决定「加入」画钮还是画一句话 */
  available: boolean;
  ready: boolean;
  onJoin: () => void;
  onMute: (muted: boolean) => void;
  onUpdate: (ids: string[]) => Promise<CloudAck>;
  /** 结束通话（全组）。二次确认在调用方；回 ok:false 时那句话画在栏下 */
  onEnd: () => Promise<CloudAck>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  // 名字现查名单，查不到（那只后来被删了）退回事件里的快照——同 voiceCallLineText
  const nameOf = (p: { agentId: string; name: string }): string =>
    ws.agents.some((a) => a.agentId === p.agentId) ? agentNameOf(ws, p.agentId) : p.name;

  const end = async (): Promise<void> => {
    setEnding(true);
    setEndError(null);
    const r = await onEnd();
    setEnding(false);
    if (!r.ok) setEndError(r.message);
  };

  const error = voice?.error ?? endError;

  return (
    <div role="region" aria-label="语音通话" className="shrink-0 border-b border-border/60 px-4 py-1.5">
      <div className="flex items-center gap-2 text-[12px]">
        <Phone className="size-[13px] text-[var(--brand)]" aria-hidden />
        <span className="font-medium">语音通话中</span>
        <span className="tabular-nums text-muted-foreground">{fmtElapsed(now - call.sinceTs)}</span>
        <div className="flex items-center gap-1 pl-1" aria-label="通话成员">
          {call.participants.map((p) => {
            const speaking = voice?.speaking === p.agentId;
            const name = nameOf(p);
            return (
              <Avatar
                key={p.agentId}
                aria-label={name}
                title={name}
                data-speaking={speaking ? "true" : "false"}
                className={cn(
                  "size-6 ring-2 ring-transparent transition-[box-shadow] duration-150",
                  speaking && "ring-[var(--brand)] animate-pulse"
                )}
              >
                <AvatarImage src={agentAvatarSrc(ws, p.agentId)} alt="" />
                <AvatarFallback className="text-[9px]">{name.slice(0, 1)}</AvatarFallback>
              </Avatar>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <VoicePickerPopover ws={ws} current={call.participants.map((p) => p.agentId)} ready={ready} onSubmit={onUpdate}>
            <Button variant="ghost" size="xs" disabled={!ready} aria-label="加人" title="加人 / 移出">
              <UserPlus className="size-[13px]" aria-hidden />
            </Button>
          </VoicePickerPopover>
          {voice ? (
            <Button
              variant="ghost"
              size="xs"
              aria-label={voice.muted ? "取消静音" : "静音"}
              title={voice.muted ? "取消静音（只影响这台机器）" : "静音（只影响这台机器，通话照旧）"}
              onClick={() => onMute(!voice.muted)}
            >
              {voice.muted ? <VolumeX className="size-[13px]" aria-hidden /> : <Volume2 className="size-[13px]" aria-hidden />}
            </Button>
          ) : available ? (
            <Button size="xs" onClick={onJoin}>
              加入
            </Button>
          ) : (
            // 不画钮：点了必然拿到「要订阅」的钮是撒谎的勾。通话本身照样看得见
            <span className="text-[11px] text-muted-foreground">语音要订阅 Mr Otto</span>
          )}
          <Button variant="ghost" size="xs" className="text-err" disabled={!ready || ending} onClick={() => void end()}>
            <PhoneOff className="size-[13px]" aria-hidden />
            结束通话
          </Button>
        </div>
      </div>
      {error && <p className="pt-1 text-[11px] text-err">{error}</p>}
    </div>
  );
}
