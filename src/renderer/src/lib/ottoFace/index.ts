// ottoFace 的对外门面。
//
//   const face = createFace(el, { character: OTTO, state: "idle", scale: 2 })
//   face.setState("waiting")
//   face.destroy()
//
// 只有三个方法是有意的：这东西挂在花名册的每一行上，一屏可能十几个实例，
// API 面越小越不容易在某一行忘了 destroy。

import { composeFrame, layoutFor, type ComposeOptions } from "./compose.js";
import type { FaceCharacter } from "./character.js";
import { blitScaled, paintFrame } from "./paint.js";
import type { FaceState } from "./states.js";

export type { FaceCharacter, Box, EyePair, EyeShape, MouthShape, Tone } from "./character.js";
export type { Frame, ComposeOptions } from "./compose.js";
export type { FaceState, FaceStateDef, LookDriver } from "./states.js";
export type { BadgeName } from "./badges.js";
export type { FaceSourceInput, VoiceState } from "./adapter.js";
export { deriveBrows, deriveEyes, deriveMouths } from "./character.js";
export { composeFrame, layoutFor, scaleForHeight } from "./compose.js";
export { ACCENT, FACE_STATES, FACE_STATE_LIST, isFaceState } from "./states.js";
export { faceStateFor, SLEEP_AFTER_MS } from "./adapter.js";
export { FACE_CHARACTERS, faceCharacter, OTTO, BERET, SPECS, SCHOLAR, BOB, SAGE, STOIC, CAP } from "./characters/index.js";

export interface FaceOptions {
  readonly character: FaceCharacter;
  readonly state?: FaceState;
  /** 整数倍放大；小数会向下取整。1 = 原生网格（角色 38 格宽 ≈ 38px，花名册那个尺寸） */
  readonly scale?: number;
  /** 眼睛跟指针。一屏十几个实例时建议关掉——十几个 pointermove 订阅不划算 */
  readonly followPointer?: boolean;
  /** 描边颜色。深色底上必须给：这批头像的头发是纯黑的，不描边整个脑袋糊成一团。
   *  浅色底上给了反而多一道白边，所以这是宿主按背景决定的，不是角色自带的 */
  readonly rim?: string;
}

export interface FaceHandle {
  setState(state: FaceState): void;
  setCharacter(character: FaceCharacter): void;
  /** 跟着主题切换调。传 undefined 关掉描边 */
  setRim(rim: string | undefined): void;
  readonly canvas: HTMLCanvasElement;
  destroy(): void;
}

export function createFace(host: HTMLElement, options: FaceOptions): FaceHandle {
  let character = options.character;
  let state: FaceState = options.state ?? "idle";
  const scale = Math.max(1, Math.floor(options.scale ?? 1));

  const canvas = document.createElement("canvas");
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d");

  let rim = options.rim;
  let pointer: ComposeOptions = {};
  const onPointer = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    pointer = {
      pointerX: ((e.clientX - (r.left + r.width / 2)) / (r.width * 0.55)),
      pointerY: ((e.clientY - (r.top + r.height * 0.5)) / (r.height * 0.6)),
    };
  };
  if (options.followPointer === true) window.addEventListener("pointermove", onPointer);

  const resize = (): void => {
    const L = layoutFor(character);
    off.width = L.gridW;
    off.height = L.gridH;
    canvas.width = L.gridW * scale;
    canvas.height = L.gridH * scale;
    canvas.style.width = `${L.gridW * scale}px`;
    canvas.style.height = `${L.gridH * scale}px`;
  };
  resize();

  let raf = 0;
  let alive = true;
  const tick = (now: number): void => {
    if (!alive) return;
    if (ctx !== null && offCtx !== null) {
      paintFrame(offCtx, composeFrame(character, state, now, rim === undefined ? pointer : { ...pointer, rim }));
      blitScaled(ctx, off, off.width, off.height, scale);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    canvas,
    setState(next) { state = next; },
    setCharacter(next) { character = next; resize(); },
    setRim(next) { rim = next; },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      if (options.followPointer === true) window.removeEventListener("pointermove", onPointer);
      canvas.remove();
    },
  };
}
