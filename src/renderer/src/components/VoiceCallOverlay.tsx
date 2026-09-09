// VoiceCallOverlay —— 语音通话的全屏视图（#1185，ADR-0278）：点通话栏展开，照 FaceTime / 微信群语音
// 那一屏——深色、正中一排头像、在说的那个亮环随声浪、每人一个状态词、底下字幕与控制条。
//
// 画的都是 voiceCallView 算出来的东西（谁在场、谁在说 / 在想 / 在听）；这个组件只管排版与动效。
// 控制条那几颗与通话栏是同一批回调（加人 / 麦 / 静音 / 结束）——两处不许各有一套语义。
// 头像里有**人**（维护者点名）：发起人 + 自己；别的成员有没有在听这台机器不知道（ADR-0271），不画。
//
// 全屏是 app 窗口内的全屏（Radix Dialog 铺满 inset-0），不是系统全屏；Esc / 收起都关掉，通话本身照旧。

import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronDown, Mic, MicOff, Phone, PhoneOff, UserPlus, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { VoicePickerPopover } from "./VoicePickerPopover.js";
import { callStatusText, callTiles, type CallTile, type CallViewInput } from "../lib/voiceCallView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { VoiceCallState } from "../../../shared/voiceCall.js";
import type { CloudAck } from "../../../shared/shellBridge.js";
import type { VoiceListenState } from "../store.js";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STATE_WORD: Record<CallTile["state"], string> = {
  speaking: "在说话",
  thinking: "在想…",
  listening: "在听",
  idle: "没在听",
};

/** 一格：头像 + 外圈（在说的那个按 level 撑开）+ 名字 + 状态词 */
function Tile({ t }: { t: CallTile }) {
  const speaking = t.state === "speaking";
  // 声浪：自己按麦克风能量撑外圈（0..1 → 4..22px），agent 在说时 level 是 1、靠 animate-pulse 呼吸
  const glow = speaking ? 4 + Math.round(t.level * 18) : 0;
  return (
    <figure
      className="flex w-28 flex-col items-center gap-2"
      data-tile={t.kind}
      data-state={t.state}
      data-self={t.self ? "true" : "false"}
      aria-label={`${t.name}${t.self ? "（你）" : ""} · ${STATE_WORD[t.state]}`}
    >
      <div
        className={cn("rounded-full transition-[box-shadow] duration-150", speaking && t.kind === "agent" && "animate-pulse")}
        style={glow > 0 ? { boxShadow: `0 0 0 ${glow}px color-mix(in srgb, var(--brand) 35%, transparent)` } : undefined}
      >
        <Avatar className={cn("size-20 ring-2", speaking ? "ring-[var(--brand)]" : t.state === "thinking" ? "ring-white/40" : "ring-white/10", t.state === "idle" && "opacity-50")}>
          {t.avatarSrc !== "" && <AvatarImage src={t.avatarSrc} alt="" />}
          <AvatarFallback className="bg-white/10 text-lg text-white">{t.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
      </div>
      <figcaption className="flex flex-col items-center leading-tight">
        <span className="max-w-28 truncate text-[13px] font-medium">{t.name}{t.self ? "（你）" : ""}</span>
        <span className={cn("text-[11px]", speaking ? "text-[var(--brand)]" : "text-white/50")}>{STATE_WORD[t.state]}</span>
      </figcaption>
    </figure>
  );
}

export function VoiceCallOverlay({
  open,
  onOpenChange,
  ws,
  call,
  voice,
  view,
  available,
  ready,
  onJoin,
  onMic,
  onMute,
  onUpdate,
  onEnd,
  trafficInset = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ws: WorkspaceSnapshot;
  call: VoiceCallState;
  voice: VoiceListenState | null;
  /** 谁在场、谁欠回答（页面算好递进来，与通话栏共用同一份判据） */
  view: Pick<CallViewInput, "selfUid" | "starterUid" | "openAgentIds">;
  available: boolean;
  ready: boolean;
  onJoin: () => void;
  onMic: (on: boolean) => void;
  onMute: (muted: boolean) => void;
  onUpdate: (ids: string[]) => Promise<CloudAck>;
  /** 结束通话（全组）。二次确认在调用方 */
  onEnd: () => Promise<CloudAck>;
  /** mac 窗口模式（hiddenInset）红绿灯叠在左上角：头部给它让位（同 App.tsx 侧栏头部的 pl-[74px]，#1198） */
  trafficInset?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  const tiles = callTiles({ ws, call, voice, ...view });
  const status = callStatusText(tiles, voice);
  const micOn = voice !== null && voice.mic.status !== "off" && voice.mic.status !== "denied";
  const speakingTile = tiles.find((t) => t.kind === "agent" && t.state === "speaking") ?? null;
  const error = voice?.error ?? voice?.mic.error ?? endError;

  const end = async (): Promise<void> => {
    setEnding(true);
    setEndError(null);
    const r = await onEnd();
    setEnding(false);
    if (!r.ok) setEndError(r.message);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          aria-label="语音通话"
          data-slot="voice-call-overlay"
          className="fixed inset-0 z-50 flex flex-col bg-[#0d0e12] text-white outline-none"
        >
          <DialogPrimitive.Title className="sr-only">语音通话</DialogPrimitive.Title>

          {/* 头部是这一屏唯一的窗口拖拽区（原生标题栏藏着，同 app.css 的 drag-region；钮由那条后代选择器标回 no-drag） */}
          <header className={cn("drag-region flex items-center gap-2 px-5 pt-4 text-[13px]", trafficInset && "pl-[74px]")}>
            <Phone className="size-4 text-[var(--brand)]" aria-hidden />
            <span className="font-medium">语音通话中</span>
            <span className="tabular-nums text-white/60">{fmtElapsed(now - call.sinceTs)}</span>
            <Button variant="ghost" size="xs" className="ml-auto text-white/70 hover:bg-white/10 hover:text-white" aria-label="收起" onClick={() => onOpenChange(false)}>
              <ChevronDown className="size-4" aria-hidden />
              收起
            </Button>
          </header>

          {/* 顶上那句状态既是给人看的，也是这扇 dialog 的 description（Radix 要一句；不另写一份 sr-only，
              同一句话两份会让读屏念两遍、测试也会撞见两个同文元素） */}
          <DialogPrimitive.Description className="px-5 pt-1 text-[12px] text-white/60" aria-live="polite" data-status>
            {status}
          </DialogPrimitive.Description>

          <div className="flex flex-1 flex-wrap content-center items-start justify-center gap-x-6 gap-y-8 px-6 py-6" aria-label="通话成员">
            {tiles.map((t) => <Tile key={t.key} t={t} />)}
          </div>

          {/* 字幕：agent 正在读的那句 + 你正在说的这句。两行定高——有没有话都占着位，控制条不跳 */}
          <div className="min-h-14 px-6 text-center text-[14px] leading-snug">
            {speakingTile && voice?.text && (
              <p className="line-clamp-2 text-white/85" data-caption="agent">
                <span className="text-white/50">{speakingTile.name}：</span>{voice.text}
              </p>
            )}
            {voice && voice.mic.transcript !== "" && (
              <p className="line-clamp-2 text-[var(--brand)]" data-caption="self" aria-live="polite">
                <span className="opacity-70">你：</span>{voice.mic.transcript}
              </p>
            )}
            {error && <p className="text-[12px] text-err">{error}</p>}
          </div>

          <footer className="flex items-center justify-center gap-3 px-6 pb-8 pt-2">
            <VoicePickerPopover ws={ws} current={call.participants.map((p) => p.agentId)} ready={ready} onSubmit={onUpdate}>
              <Button variant="ghost" size="lg" className="size-14 rounded-full bg-white/10 text-white hover:bg-white/20" disabled={!ready} aria-label="加人" title="加人 / 移出">
                <UserPlus className="size-5" aria-hidden />
              </Button>
            </VoicePickerPopover>
            {voice ? (
              <>
                <Button
                  variant="ghost"
                  size="lg"
                  className={cn("size-14 rounded-full text-white", micOn ? "bg-white/10 hover:bg-white/20" : "bg-white text-black hover:bg-white/90")}
                  aria-label={micOn ? "关麦" : "开麦"}
                  onClick={() => onMic(!micOn)}
                >
                  {micOn ? <Mic className="size-5" aria-hidden /> : <MicOff className="size-5" aria-hidden />}
                </Button>
                <Button
                  variant="ghost"
                  size="lg"
                  className={cn("size-14 rounded-full text-white", voice.muted ? "bg-white text-black hover:bg-white/90" : "bg-white/10 hover:bg-white/20")}
                  aria-label={voice.muted ? "取消静音" : "静音"}
                  onClick={() => onMute(!voice.muted)}
                >
                  {voice.muted ? <VolumeX className="size-5" aria-hidden /> : <Volume2 className="size-5" aria-hidden />}
                </Button>
              </>
            ) : available ? (
              <Button size="lg" className="h-14 rounded-full px-6" onClick={onJoin}>
                加入
              </Button>
            ) : (
              <span className="text-[12px] text-white/60">语音要订阅 Mr Otto</span>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="size-14 rounded-full bg-err text-white hover:bg-err/90"
              aria-label="结束通话"
              title="结束通话（全组）"
              disabled={!ready || ending}
              onClick={() => void end()}
            >
              <PhoneOff className="size-5" aria-hidden />
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
