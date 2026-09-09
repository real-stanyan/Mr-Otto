// 语音识别桥 —— 主进程 ↔ Swift helper（native/MrOttoSpeech）的 NDJSON 通道（#1176，ADR-0273）。
// 形状照 simInputBridge：spawn 注入，编解码 / 行缓冲 / 崩溃重启整套在普通 vitest 里跑，
// 不用真麦克风、真授权。
//
// 与那两座桥的根本不同：**不是请求-响应**。识别结果是 helper 自己冒出来的（partial /
// final / status…），没有哪一条命令在等它——所以 send 只回「写没写进管子」，事件一律
// 走 onEvent。helper 是懒起的：第一条命令才 spawn（没开过麦的 app 不该多一个占着
// 麦克风设备的子进程），崩了下一条命令再起，超过 MAX_RESTARTS 次不再起。
//
// 崩溃**要说出口**：helper 一死麦就掉了，而渲染层上一次听到的还是 listening:true——
// 不补一条事件，通话栏会一直画着「开麦」而没人在听（同 #913「失败无声」的教训）。

import type { SpeechAuth, SpeechEvent } from "../shared/shellBridge.js";

export type SpeechCommand =
  /** `hints`（#1196）：上下文词表——agent 名 / 成员名 / 开发常用英文词，helper 喂给识别器的 contextualStrings */
  | { type: "start"; locale: string; silenceMs?: number; hints?: string[] }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "status" }
  /** helper 侧播放（#1201）：字节已落成临时文件，命令只带路径 */
  | { type: "play"; id: string; path: string }
  | { type: "stopPlay" };

export interface SpeechChild {
  stdin: { write(s: string): void };
  stdout: { on(ev: "data", cb: (b: Buffer) => void): void };
  on(ev: "exit", cb: () => void): void;
  kill(): void;
}
export type SpeechSpawn = (binPath: string) => SpeechChild;

const MAX_RESTARTS = 3;
export const SPEECH_HELPER_EXITED = "语音识别 helper 退出了，重新开麦会再起一次";
export const SPEECH_HELPER_GAVE_UP = "语音识别 helper 反复退出，已停止重启——重开 app 再试";

export function encodeSpeechCommand(c: SpeechCommand): string {
  const wire =
    c.type === "start"
      ? { type: "start", locale: c.locale, ...(c.silenceMs !== undefined ? { silenceMs: c.silenceMs } : {}), ...(c.hints !== undefined ? { hints: c.hints } : {}) }
      : c.type === "play"
        ? { type: "play", id: c.id, path: c.path }
        : { type: c.type };
  return JSON.stringify(wire) + "\n";
}

const AUTH: ReadonlySet<string> = new Set<SpeechAuth>(["authorized", "denied", "restricted", "notDetermined"]);
const isAuth = (v: unknown): v is SpeechAuth => typeof v === "string" && AUTH.has(v);

/** helper 吐的一行 → 事件；形状不对一律 null（stderr 不走这条管子，坏行只可能是协议漂了） */
export function decodeSpeechEvent(line: string): SpeechEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  switch (e.type) {
    case "status":
      if (!isAuth(e.speech) || !isAuth(e.mic)) return null;
      return {
        type: "status",
        speech: e.speech,
        mic: e.mic,
        onDevice: typeof e.onDevice === "boolean" ? e.onDevice : null,
        locale: typeof e.locale === "string" ? e.locale : null,
        aec: typeof e.aec === "boolean" ? e.aec : null,
      };
    case "listening":
      return typeof e.on === "boolean" ? { type: "listening", on: e.on } : null;
    case "paused":
      return { type: "paused" };
    case "resumed":
      return { type: "resumed" };
    case "partial":
    case "final":
      return typeof e.text === "string" ? { type: e.type, text: e.text } : null;
    case "level":
      return typeof e.value === "number" && Number.isFinite(e.value)
        ? { type: "level", value: e.value, active: e.active === true }
        : null;
    case "played":
      return typeof e.id === "string" ? { type: "played", id: e.id } : null;
    case "playError":
      return typeof e.id === "string" && typeof e.message === "string" ? { type: "playError", id: e.id, message: e.message } : null;
    case "error":
      return typeof e.message === "string" ? { type: "error", message: e.message } : null;
    default:
      return null;
  }
}

export interface SpeechBridge {
  /** 写一条命令进 helper。回 false = 没写进去（桥已关 / helper 反复退出后不再起） */
  send(c: SpeechCommand): boolean;
  dispose(): void;
}

export function createSpeechBridge(opts: {
  binPath: string;
  spawn: SpeechSpawn;
  onEvent: (e: SpeechEvent) => void;
  log?: (m: string) => void;
}): SpeechBridge {
  const log = opts.log ?? (() => {});
  let child: SpeechChild | null = null;
  let restarts = 0;
  let disposed = false;

  const start = (): SpeechChild | null => {
    if (disposed) return null;
    if (restarts > MAX_RESTARTS) {
      opts.onEvent({ type: "error", message: SPEECH_HELPER_GAVE_UP });
      return null;
    }
    const c = opts.spawn(opts.binPath);
    child = c;
    // 每代一个局部行缓冲：上一代崩溃后的迟到字节不能混进新一代（同 islandBridge）
    let buf = "";
    c.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = decodeSpeechEvent(line);
        if (ev === null) {
          log(`语音识别桥:无法解析 ${line.slice(0, 120)}`);
          continue;
        }
        opts.onEvent(ev);
      }
    });
    c.on("exit", () => {
      if (disposed || child !== c) return;
      child = null;
      restarts += 1;
      opts.onEvent({ type: "error", message: SPEECH_HELPER_EXITED });
      opts.onEvent({ type: "listening", on: false });
    });
    return c;
  };

  return {
    send(c) {
      if (disposed) return false;
      const proc = child ?? start();
      if (!proc) return false;
      try {
        proc.stdin.write(encodeSpeechCommand(c));
        return true;
      } catch (e) {
        log(`语音识别桥:写 stdin 失败 ${String(e)}`);
        return false;
      }
    },
    dispose() {
      disposed = true;
      child?.kill();
      child = null;
    },
  };
}
