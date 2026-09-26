import { describe, expect, it, vi } from "vitest";

// ── 默认播放适配走 Web Audio（#1170）───────────────────────────────────
//
// 真机冒烟：`<audio src=blob:…>` 被渲染层的 CSP（`default-src 'self'`，没有 media-src）
// 挡掉，每段都是「这段音频播不出来」。Web Audio 解码的是内存里的字节，没有 URL，CSP
// 管不着；也不用 revoke blob。AudioContext 经工厂注入，jsdom 里没有它。
import { webAudioPlayback } from "../../src/renderer/src/lib/webAudio.js";

function fakeCtx() {
  const calls: string[] = [];
  let decodeImpl: (buf: ArrayBuffer) => Promise<unknown> = async (buf) => { calls.push(`decode:${buf.byteLength}`); return { duration: 1 }; };
  const sources: { started: number; stopped: number; onended: (() => void) | null }[] = [];
  const ctx = {
    state: "suspended",
    destination: { kind: "dest" },
    async resume() { calls.push("resume"); ctx.state = "running"; },
    decodeAudioData: (buf: ArrayBuffer) => decodeImpl(buf),
    createBufferSource() {
      const s = {
        buffer: null as unknown, started: 0, stopped: 0, onended: null as (() => void) | null,
        connect(d: unknown) { calls.push(`connect:${(d as { kind: string }).kind}`); },
        start() { s.started += 1; calls.push("start"); },
        stop() { s.stopped += 1; calls.push("stop"); },
        addEventListener(_type: "ended", cb: () => void) { s.onended = cb; },
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx, calls, sources, setDecode: (f: typeof decodeImpl) => { decodeImpl = f; } };
}

describe("webAudioPlayback（#1170）", () => {
  it("play：按 byteOffset/byteLength 切出字节解码 → 接 destination → resume → start；播完回 onended", async () => {
    const f = fakeCtx();
    const view = new Uint8Array(new ArrayBuffer(10), 2, 4); // 视图不从 0 开始
    const a = webAudioPlayback(view, () => f.ctx as never);
    let ended = 0;
    a.onended = () => { ended += 1; };
    await a.play();
    expect(f.calls).toEqual(["decode:4", "connect:dest", "resume", "start"]);
    f.sources[0]!.onended?.();
    expect(ended).toBe(1);
  });

  it("pause：停掉 source；停之后迟到的解码不再 start", async () => {
    const f = fakeCtx();
    let release!: () => void;
    f.setDecode(() => new Promise((r) => { release = () => r({ duration: 1 }); }));
    const a = webAudioPlayback(new Uint8Array([1, 2]), () => f.ctx as never);
    const p = a.play();
    a.pause(); // 解码还没回来
    release();
    await p;
    expect(f.calls.filter((c) => c === "start")).toHaveLength(0);
    // 正常播着时 pause = stop
    const g = fakeCtx();
    const b = webAudioPlayback(new Uint8Array([1]), () => g.ctx as never);
    await b.play();
    b.pause();
    expect(g.sources[0]!.stopped).toBe(1);
  });

  it("解码失败：play() 拒绝（VoicePlayer 据此当播放失败跳到下一段）；工厂抛错同理", async () => {
    const f = fakeCtx();
    f.setDecode(async () => { throw new Error("bad mp3"); });
    await expect(webAudioPlayback(new Uint8Array([1]), () => f.ctx as never).play()).rejects.toThrow("bad mp3");
    await expect(webAudioPlayback(new Uint8Array([1]), () => { throw new Error("no AudioContext"); }).play()).rejects.toThrow("no AudioContext");
  });
});
