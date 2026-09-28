#!/usr/bin/env node
// make-ringtone —— 回电的铃声（#1411，spec §3.4）。自己合成、不用别人的音频（没有授权问题），产物提交在
// mobile/assets/sounds/ringtone.caf，由 expo-notifications 插件打进包里。
// 形状：两个音交替（E6 / C6，各 0.4 秒、敲一下的衰减）响两遍、停一秒多，一个周期 3 秒，九个周期 27 秒——
// APNs 的通知铃声上限 30 秒，超了系统换成默认提示音。
// 用法：node scripts/make-ringtone.mjs（WAV → CAF 那一步用 macOS 自带的 afconvert，只在 mac 上跑得完）
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RATE = 22_050;
export const CYCLE_S = 3;
export const CYCLES = 9;
const NOTE_S = 0.4;
const NOTES = [
  { at: 0.0, hz: 1318.51 },
  { at: 0.45, hz: 1046.5 },
  { at: 1.0, hz: 1318.51 },
  { at: 1.45, hz: 1046.5 },
];

/** 一整段铃声的采样（-1..1） */
export function ringtoneSamples(rate = RATE) {
  const total = Math.round(CYCLE_S * CYCLES * rate);
  const out = new Float32Array(total);
  const len = Math.round(NOTE_S * rate);
  for (let c = 0; c < CYCLES; c++) {
    for (const n of NOTES) {
      const start = Math.round((c * CYCLE_S + n.at) * rate);
      for (let i = 0; i < len && start + i < total; i++) {
        const t = i / rate;
        const attack = Math.min(1, t / 0.01); // 10ms 起音，免得咔哒一声
        const decay = Math.exp(-t * 6); // 敲一下的衰减
        const tail = Math.min(1, (len - i) / (0.02 * rate)); // 最后 20ms 收干净
        const tone = Math.sin(2 * Math.PI * n.hz * t) + 0.3 * Math.sin(2 * Math.PI * 2 * n.hz * t);
        out[start + i] += 0.45 * attack * decay * tail * tone;
      }
    }
  }
  return out;
}

/** 16 位单声道 PCM 的 WAV 字节 */
export function wavBytes(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const wav = join(mkdtempSync(join(tmpdir(), "ringtone-")), "ringtone.wav");
  writeFileSync(wav, wavBytes(ringtoneSamples()));
  const out = join(root, "mobile", "assets", "sounds", "ringtone.caf");
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync("afconvert", ["-f", "caff", "-d", "LEI16", wav, out], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("afconvert 失败（它只在 macOS 上有）");
    process.exit(1);
  }
  console.log(`写好了：${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
