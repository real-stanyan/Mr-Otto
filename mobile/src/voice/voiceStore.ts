// 语音通话在手机上的接线（#1356 A4，spec §5.7，ADR-0320）：编排在 shared 的 voiceSession（进 vitest），
// 这里只把它接到四样东西上——原生模块（识别 + 放音）、TTS 网关（createTtsClient）、聊天那条连接
// （chatStore 的钩子 + sayVoice / setVoiceCall）、App 前后台。
//
// · 原生模块只在开发版里有（Expo Go 里 OttoSpeech 为 null）：没有它就没有电话钮，别的照常。
// · 放音：一段字节先落成缓存目录里的一个文件（原生放音器只收路径），交给原生模块用识别那同一个
//   音频引擎放（ADR-0280：不被回声消除压低、是回声参考）；放完 / 放不了 / 停掉就删。起来先把那个目录
//   整个扫掉：崩掉、开发时重载、一段等不到 played，留下的文件没人再删。
// · 订阅快照：电话钮画不画要知道「订阅活跃 + 网关供语音」。进聊天页拉一次，拉失败留着上一次的
//   （拿不到 ≠ 没订阅）；还没拉到时不画钮（说不清就不画）。一次都没拉到的话，回到前台再拉一次——
//   一次失败不该把电话钮藏到重开这一页；拉到过就不再每次回前台都拉。
// · 切到后台 = 这台停听（停麦停放音），通话本身还在——回来那一格写「通话还开着」+「接着听」
//   （维护者 2026-09-26）。只认 background：下拉控制中心 / 来一条通知横幅是 inactive，那不是人离开了。
//   例外：系统来电（CallKit）进行中不停听，锁着屏也在通话；来电结束时还在后台再补停（#1428，call/systemCall.ts）。
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { agentVoiceId } from "../../../src/shared/agentVoice.js";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
import { createHelperAudio, helperAudioEvent, type HelperAudioBridge } from "../../../src/shared/helperAudio.js";
import type { BillingSnapshotView, CloudAck, VoiceSpeakResult } from "../../../src/shared/shellBridge.js";
import { createSpeakCache } from "../../../src/shared/speakCache.js";
import { speechEventOf } from "../../../src/shared/speechEvent.js";
import { createTtsClient } from "../../../src/shared/ttsClient.js";
import { ttsHostedOf } from "../../../src/shared/ttsRoute.js";
import { spokenUnits, voiceCallAvailable } from "../../../src/shared/voiceFeed.js";
import { IOS_PERMISSION_HELP, SPEECH_LOCALE, speechHints } from "../../../src/shared/voiceMic.js";
import { createVoiceSession, type VoiceListen, type VoiceMicPort } from "../../../src/shared/voiceSession.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import { inSystemCall, onSystemCallEnded } from "../call/systemCall.js";
import { chatEvents, currentSpeechTicket, sayVoice, setChatActivity, setVoiceCall } from "../cloud/chatStore.js";
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

// 上一次留下的先扫掉（见文件头）。这一刻这一份 JS 还一段都没交出去；开发时重载那种原生还在放上一份的
// 最后一段——iOS 上删掉一个正打开着的文件，读的那一方照样读得完。删不掉就算了：它在缓存目录里，系统也会清
try {
  if (audioDir.exists) audioDir.delete();
} catch {
  // 见上
}

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
      files.set(id, f);
      f.create({ overwrite: true });
      f.write(bytes);
      await OttoSpeech.play(id, f.uri);
      return { id };
    } catch (err) {
      // 落盘失败，或原生起不来（解不开 / 引擎起不来——那条 promise 被拒，message 是原话）：文件删掉，
      // 那句话交给放音队列（「播放失败：…」），它接着放下一段
      dropFile(id);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  async stop() {
    // 只收这一刻已经交出去的那几段：停的回执回来之前又交出去的那一段（下一句试听 / 电话的下一段）不归这一次停
    const ids = [...files.keys()];
    await OttoSpeech?.stopPlay();
    for (const id of ids) dropFile(id);
  },
};

const mic: VoiceMicPort = {
  start: (hints) => void OttoSpeech?.start(SPEECH_LOCALE, hints),
  stop: () => void OttoSpeech?.stop(),
  pause: () => void OttoSpeech?.pause(),
  resume: () => void OttoSpeech?.resume(),
};

/** 音色按名册顺序解撞（#1372）。预合成与放音必须用同一份，否则键对不上（#1420） */
const voiceRoster = () => homeSnapshot().home?.agents ?? [];
/** 回电开场白的预合成（#1420）：通话走它；只对预取过的句子起作用 */
/** 外联通话（#1441）：这条会话手上有票就每次合成都带上，钱记主人；没有票 = 一切照旧。每次现读，换票自动生效 */
const speechOpts = (): { speechTicket?: string } => {
  const speechTicket = currentSpeechTicket();
  return speechTicket === undefined ? {} : { speechTicket };
};
const speech = createSpeakCache((text, voiceId) => tts.speak(text, voiceId, speechOpts()));

const session = createVoiceSession({
  speak: speech.speak,
  createAudio: (bytes) => createHelperAudio(bytes, nativeAudio),
  mic,
  say: (text) => sayVoice(text),
  events: (sessionId) => chatEvents(sessionId),
  // 音色按名册顺序解撞、挑过的先占（agentVoiceIds，#1372）：同一只在桌面与手机上是同一个声音
  roster: voiceRoster,
  hints: () => speechHints(homeSnapshot().home),
  permissionHelp: IOS_PERMISSION_HELP,
  onChange: (listen) => store.set({ listen }),
});

// ── 按住说话（#1386，spec §3.5）──
// 同一个原生模块：按下开麦、松手先 pause（原生那一侧会把手上那半句收成一条 final 再报 paused，Recognizer.swift）
// 再 stop——拿得到整句，**不改 Swift**（改了要重编开发版、要人重新点授权）。按住的这几秒麦克风的事件归它，
// 不进通话那一层（通话在听的时候这颗钮本来就不画，两者不会同时开麦）。说出来的话发成普通一句话，
// 不带 voice 记号（那个记号的意思是「通话里说的」，带上会被折进通话卡，ADR-0288）。
interface Dictation {
  finals: string[];
  latest: string;
  onText: (text: string) => void;
  onError: (message: string) => void;
  done: ((text: string) => void) | null;
}
let dictation: Dictation | null = null;

function dictationText(d: Dictation): string {
  return [...d.finals, d.latest].map((t) => t.trim()).filter((t) => t !== "").join(" ");
}

/** 这台此刻能不能按住说话：有原生模块，且没在听电话 */
export function dictationUsable(s: VoiceStoreState): boolean {
  return nativeSpeech && s.listen === null;
}

/** 按下：开麦开始听。onText = 听到的字（一边说一边来）；onError = 权限没给 / 麦克风打不开 */
export function startDictation(onText: (text: string) => void, onError: (message: string) => void): void {
  if (OttoSpeech === null || store.get().listen !== null || dictation !== null) return;
  dictation = { finals: [], latest: "", onText, onError, done: null };
  void OttoSpeech.start(SPEECH_LOCALE, speechHints(homeSnapshot().home));
}

/** 松手：send = 要这句话（回整句）；否则（上划取消）直接关麦、回空串。等原生那一侧收尾最多 1.5 秒 */
export async function stopDictation(send: boolean): Promise<string> {
  const d = dictation;
  const speech = OttoSpeech;
  if (d === null || speech === null) return "";
  if (!send) {
    dictation = null;
    await speech.stop();
    return "";
  }
  const text = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(dictationText(d)), 1500);
    d.done = (t) => {
      clearTimeout(timer);
      resolve(t);
    };
    void speech.pause();
  });
  dictation = null;
  await speech.stop();
  return text;
}

function onDictationEvent(d: Dictation, ev: NonNullable<ReturnType<typeof speechEventOf>>): void {
  switch (ev.type) {
    case "partial":
      d.latest = ev.text;
      d.onText(dictationText(d));
      return;
    case "final":
      d.finals.push(ev.text);
      d.latest = "";
      d.onText(dictationText(d));
      return;
    case "paused":
      d.done?.(dictationText(d));
      return;
    case "listening":
      if (!ev.on) d.done?.(dictationText(d));
      return;
    case "error":
      d.onError(ev.message);
      return;
    default:
      return;
  }
}

OttoSpeech?.addListener("onSpeech", (raw) => {
  const ev = speechEventOf(raw);
  if (ev === null) return;
  // 放音的回执：先删文件，再叫醒那一段（helperAudio 的登记）；这两种不是麦克风的事
  if (ev.type === "played" || ev.type === "playError") dropFile(ev.id);
  if (helperAudioEvent(ev)) return;
  // 按住说话的那几秒，麦克风的事件归它
  if (dictation !== null) {
    onDictationEvent(dictation, ev);
    return;
  }
  session.onSpeech(ev);
});

setChatActivity({
  event: (e) => session.onEvent(e),
  delta: (d) => session.onDelta(d),
  room: (sessionId, prev, next) => session.onRoomState(sessionId, prev, next),
  closed: () => session.leave(),
});

AppState.addEventListener("change", (s) => {
  if (s === "background") {
    if (!inSystemCall()) session.leave();
  }
  // 订阅快照一次都没拉到（见文件头）：回到前台再拉一次
  else if (s === "active" && store.get().billing === null) void refreshVoiceBilling();
});

// 系统来电期间切后台不停听（#1428，修订 ADR-0320：锁着屏也在通话）；来电结束时还在后台，补做那一步
onSystemCallEnded(() => {
  if (AppState.currentState !== "active") session.leave();
});

/** 进聊天页拉一次订阅快照。拉失败留着上一次的（拿不到 ≠ 没订阅） */
export async function refreshVoiceBilling(): Promise<void> {
  const b = await fetchBilling();
  if (b !== null) store.set({ billing: b });
}

/** 开电话：改名单（call 帧）→ 回执 ok 之后这台开始听（发起的人自动加入，同桌面）。
    runtime 先广播那条 voice_call_changed 再回执，所以加入那一刻日志里已经有这场通话 */
export async function startCall(sessionId: string, agentIds: string[]): Promise<CloudAck> {
  // 发帧之前记下日志尾（#1420）：回执之前就落下来的事件（名单、接通）不会被当成历史。回电开场白
  // runtime 已经挪到回执之后一拍（终审 I1），这里是第二道保险——哪天它又先于回执到，照样念
  const sinceSeq = chatEvents(sessionId)?.at(-1)?.seq ?? -1;
  // 这台本来就在听这条（通话里再拉一只）：回执之前落下来的那几条已经按直播读过了，再按 sinceSeq
  // 补一遍就是把正在念的那句掐掉、从头再合成一次（又一笔额度）。这时照 #1420 之前的样子在日志尾
  // 重新加入——runtime 把回电开场白挪到了回执之后（终审 I1），它照样作为直播到、照样念
  // 发帧前后都在听才算：中途离开过的话，那几条没被读过，要补
  const listeningBefore = session.state()?.sessionId === sessionId;
  const r = await setVoiceCall(agentIds);
  if (r.ok) {
    if (listeningBefore && session.state()?.sessionId === sessionId) session.join(sessionId);
    else session.join(sessionId, sinceSeq);
  }
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

/** 挑声音那张表的试听（#1372，spec §10 第 97 条）：合成走电话那同一个 TTS 客户端（同一笔额度、同一套
    报错），放音走同一个原生放音器；不经过通话那一套（它不在任何一场电话里）。这台正在听电话时表那边
    不调它（同一个音频引擎，voicePreviewState 的 inCall） */
export function speakPreview(text: string, voiceId: string): Promise<VoiceSpeakResult> {
  return tts.speak(text, voiceId);
}

/** 放一段试听，回一个「停」。一次只放一段：调用方换一行之前先调上一段的「停」。这台正在听电话时不放——
    同一个音频引擎，试听会把电话那一段掐掉，这里兜住「点的时候还没在听、合成回来时已经在听了」那个窗口。
    起播的回执还没回来时 pause() 够不着原生那一段，这里补一次；起播之后 pause() 自己会停原生那边，
    不重复调——两处都调就是把「停」发两遍 */
export function playPreview(bytes: Uint8Array, on: { start(): void; end(): void; fail(message: string): void }): () => void {
  // 这台正在听电话：同一个音频引擎，试听会把电话那一段掐掉。表那边点的时候已经挡了，这里兜住
  // 「点的时候还没在听、合成回来时已经在听了」
  if (store.get().listen !== null) {
    on.fail("正在听电话，挂了再试听");
    return () => {};
  }
  const audio = createHelperAudio(bytes, nativeAudio);
  let started = false;
  audio.onended = () => on.end();
  audio.onerror = (message) => on.fail(message ?? "放不出来");
  audio.play().then(
    () => {
      started = true;
      on.start();
    },
    (err: unknown) => on.fail(err instanceof Error ? err.message : String(err)),
  );
  // 停一次就够：起播之后 pause() 自己会停原生那边；起播的回执还没回来时 pause() 够不着，这里补那一次
  return () => {
    if (!started) void nativeAudio.stop();
    audio.pause();
  };
}

/** 来电响铃时先把开场白合成好（#1420）：切句与音色都走接通后放音那条路同一套，接起来直接从缓存拿 */
export function prefetchOpening(agentId: string, opening: string, untilTs: number): void {
  const texts = spokenUnits(opening);
  if (texts.length === 0) return;
  speech.prefetch(texts, agentVoiceId(agentId, voiceRoster()), untilTs);
}
