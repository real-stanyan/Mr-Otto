// 语音通话在手机上的接线（#1356 A4，spec §5.7，ADR-0320）：编排在 shared 的 voiceSession（进 vitest），
// 这里只把它接到四样东西上——原生模块（识别 + 放音）、TTS 网关（createTtsClient）、聊天那条连接
// （chatStore 的钩子 + sayVoice / setVoiceCall）、App 前后台。
//
// · 原生模块只在开发版里有（Expo Go 里 OttoSpeech 为 null）：没有它就没有电话钮，别的照常。
// · 放音：一段字节先落成缓存目录里的一个文件（原生放音器只收路径），交给原生模块用识别那同一个
//   音频引擎放（ADR-0280：不被回声消除压低、是回声参考）；放完 / 放不了 / 停掉就删。
// · 订阅快照：电话钮画不画要知道「订阅活跃 + 网关供语音」。进聊天页拉一次，拉失败留着上一次的
//   （拿不到 ≠ 没订阅）；还没拉到时不画钮（说不清就不画）。
// · 切到后台 = 这台停听（停麦停放音），通话本身还在——回来那一格写「通话还开着」+「接着听」
//   （维护者 2026-09-26）。只认 background：下拉控制中心 / 来一条通知横幅是 inactive，那不是人离开了。
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
import { createHelperAudio, helperAudioEvent, type HelperAudioBridge } from "../../../src/shared/helperAudio.js";
import type { BillingSnapshotView, CloudAck } from "../../../src/shared/shellBridge.js";
import { speechEventOf } from "../../../src/shared/speechEvent.js";
import { createTtsClient } from "../../../src/shared/ttsClient.js";
import { ttsHostedOf } from "../../../src/shared/ttsRoute.js";
import { voiceCallAvailable } from "../../../src/shared/voiceFeed.js";
import { IOS_PERMISSION_HELP, SPEECH_LOCALE, speechHints } from "../../../src/shared/voiceMic.js";
import { createVoiceSession, type VoiceListen, type VoiceMicPort } from "../../../src/shared/voiceSession.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import { chatEvents, sayVoice, setChatActivity, setVoiceCall } from "../cloud/chatStore.js";
import { createStore } from "../externalStore.js";
import { fetchBilling } from "../home/billing.js";
import { homeSnapshot } from "../home/homeStore.js";
import { supabase } from "../supabase.js";

export interface VoiceStoreState {
  /** 这台在听的那一场；null = 没在听 */
  listen: VoiceListen | null;
  /** 电话钮要的订阅快照；null = 还没查到（不画钮） */
  billing: BillingSnapshotView | null;
}

const store = createStore<VoiceStoreState>({ listen: null, billing: null });

export function useVoice(): VoiceStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 这个 app 里有没有语音原生模块（开发版有、Expo Go 没有） */
export const nativeSpeech = OttoSpeech !== null;

/** 这台此刻打不打得了电话：有原生模块 + 订阅活跃 + 网关供语音 */
export function voiceUsable(s: VoiceStoreState): boolean {
  return nativeSpeech && voiceCallAvailable(s.billing);
}

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 home/billing.ts）
const EDGE_BASE = edgeBaseUrl({} as never);
const accessToken = async (): Promise<string | null> =>
  (await supabase.auth.getSession()).data.session?.access_token ?? null;

const tts = createTtsClient({
  // 手机没有桌面 hostedQuota 那份实时额度账：额度用完由网关的 429 当场说出口，两个记账口接空
  quota: { ttsInput: () => ttsHostedOf(store.get().billing), noteHeaders: () => {}, noteExhausted: () => {} },
  edgeBaseUrl: () => EDGE_BASE,
  accessToken,
});

const audioDir = new Directory(Paths.cache, "otto-voice");
const files = new Map<string, File>();
let audioSeq = 0;

function dropFile(id: string): void {
  const f = files.get(id);
  if (f === undefined) return;
  files.delete(id);
  try {
    f.delete();
  } catch {
    // 已经不在了（缓存被系统清过）：没什么要收拾的
  }
}

const nativeAudio: HelperAudioBridge = {
  async play(bytes) {
    if (OttoSpeech === null) return { error: "这个版本的 app 里没有语音模块" };
    const id = `v${++audioSeq}`;
    try {
      if (!audioDir.exists) audioDir.create({ idempotent: true, intermediates: true });
      const f = new File(audioDir, `${id}.mp3`);
      f.create({ overwrite: true });
      f.write(bytes);
      files.set(id, f);
      await OttoSpeech.play(id, f.uri);
      return { id };
    } catch (err) {
      dropFile(id);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  async stop() {
    await OttoSpeech?.stopPlay();
    for (const id of [...files.keys()]) dropFile(id);
  },
};

const mic: VoiceMicPort = {
  start: (hints) => void OttoSpeech?.start(SPEECH_LOCALE, hints),
  stop: () => void OttoSpeech?.stop(),
  pause: () => void OttoSpeech?.pause(),
  resume: () => void OttoSpeech?.resume(),
};

const session = createVoiceSession({
  speak: (text, voiceId) => tts.speak(text, voiceId),
  createAudio: (bytes) => createHelperAudio(bytes, nativeAudio),
  mic,
  say: (text) => sayVoice(text),
  events: (sessionId) => chatEvents(sessionId),
  // 音色按名册顺序解撞（agentVoiceIds）：同一只在桌面与手机上是同一个声音
  roster: () => homeSnapshot().home?.agents.map((a) => a.agentId) ?? [],
  hints: () => speechHints(homeSnapshot().home),
  permissionHelp: IOS_PERMISSION_HELP,
  onChange: (listen) => store.set({ listen }),
});

OttoSpeech?.addListener("onSpeech", (raw) => {
  const ev = speechEventOf(raw);
  if (ev === null) return;
  // 放音的回执：先删文件，再叫醒那一段（helperAudio 的登记）；这两种不是麦克风的事
  if (ev.type === "played" || ev.type === "playError") dropFile(ev.id);
  if (helperAudioEvent(ev)) return;
  session.onSpeech(ev);
});

setChatActivity({
  event: (e) => session.onEvent(e),
  delta: (d) => session.onDelta(d),
  room: (sessionId, prev, next) => session.onRoomState(sessionId, prev, next),
  closed: () => session.leave(),
});

AppState.addEventListener("change", (s) => {
  if (s === "background") session.leave();
});

/** 进聊天页拉一次订阅快照。拉失败留着上一次的（拿不到 ≠ 没订阅） */
export async function refreshVoiceBilling(): Promise<void> {
  const b = await fetchBilling();
  if (b !== null) store.set({ billing: b });
}

/** 开电话：改名单（call 帧）→ 回执 ok 之后这台开始听（发起的人自动加入，同桌面）。
    runtime 先广播那条 voice_call_changed 再回执，所以加入那一刻日志里已经有这场通话 */
export async function startCall(sessionId: string, agentIds: string[]): Promise<CloudAck> {
  const r = await setVoiceCall(agentIds);
  if (r.ok) session.join(sessionId);
  return r;
}

/** 挂断 = 空名单（主场里只有你一个人，不二次确认）。电话那一格收起看的是随后落下来的那条事件 */
export function hangUp(): Promise<CloudAck> {
  return setVoiceCall([]);
}

/** 「接着听」：通话还开着，这台重新开始听（只读之后落下来的话） */
export function joinCall(sessionId: string): void {
  session.join(sessionId);
}

/** 静音 = 关麦（spec §5.7 / demo）；再点一下开回来 */
export function setMic(on: boolean): void {
  session.setMic(on);
}
