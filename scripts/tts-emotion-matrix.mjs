// scripts/tts-emotion-matrix.mjs —— turbo × agentVoice.ts 的十三个音色 × 7 emotion 各念一个字，记 status_code（#1515）。
// ai-podcast 只验过 hd + 自家四音色；Otto 用的组合没人验过，而 emotion 被拒的降级路只兜「不出声」，
// 兜不住「哪几档从来没生效过」。跑法（key 只在 Worker secret 里，维护者在本机 export 一次）：
//   MINIMAX_API_KEY=… npx tsx scripts/tts-emotion-matrix.mjs > /tmp/matrix.txt
// 要用 npx tsx：下面 import 的是 .ts 文件，裸 node 读不了（仓库里已有 .mts + tsx 的先例）。
// 不打印 key；每发之间歇 300ms 避 RPM。
import { AGENT_VOICES, ADMIN_VOICE_ID } from "../src/shared/agentVoice.ts";

const key = process.env.MINIMAX_API_KEY;
if (!key) { console.error("要 MINIMAX_API_KEY"); process.exit(1); }
const base = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com";
const model = process.env.MODEL ?? "speech-2.8-turbo";
const emotions = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"];
const voices = [ADMIN_VOICE_ID, ...AGENT_VOICES.map((v) => v.id)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(voice, emotion) {
  const voice_setting = { voice_id: voice, speed: 1, vol: 1, pitch: 0, ...(emotion === "neutral" ? {} : { emotion, emotion_intensity: 1.0 }) };
  const res = await fetch(`${base}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, text: "测", stream: false, voice_setting, audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 64000, channel: 1 } }),
  });
  const body = await res.json().catch(() => ({}));
  return { code: body.base_resp?.status_code, msg: body.base_resp?.status_msg, audio: !!body.data?.audio };
}

console.log(`| voice_id | ${emotions.join(" | ")} |`);
console.log(`|---|${emotions.map(() => ":-:").join("|")}|`);
for (const v of voices) {
  const cells = [];
  for (const e of emotions) {
    const r = await call(v, e);
    cells.push(r.code === 0 && r.audio ? "✓" : `✗ ${r.code ?? "?"}`);
    await sleep(300);
  }
  console.log(`| \`${v}\` | ${cells.join(" | ")} |`);
}
