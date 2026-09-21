// ottoFace —— 会动的像素脸（#1345，ADR-0311）。六个文件各管一件事：
//
// · `character.ts`  一份角色包的契约 + 从两三个尺寸推全套眉/眼/嘴的那几个函数
// · `characters/`   十个角色，每个一张自己的矩阵（**不是共用一张光头加头发**）
// · `sprites.ts`    13 个坑位 → 角色，外加这张脸在圆盘里的构图
// · `states.ts`     16 档表情（15 个真状态 + 一个 plain）
// · `frame.ts`      纯函数：坑位 + 状态 + 时刻 → 一帧的网格坐标
// · `paint.ts`      canvas 那一层，一个判断都不做
//
// 组件在 `components/AgentFace.tsx`。

export { dmFaceState } from "./adapt.js";
export {
  deriveBrows,
  deriveEyes,
  deriveMouths,
  type Box,
  type EyePair,
  type EyeShape,
  type MouthShape,
  type Tone,
} from "./character.js";
export { faceCharacter, FACE_PACKS } from "./characters/index.js";
export { composeFrame, faceCharacterAt, type FaceCell, type FaceFrame, type FrameOptions } from "./frame.js";
export { paintFace, sizeFaceCanvas } from "./paint.js";
export {
  BADGE_COLORS,
  FACE_STATE_LIST,
  FACE_STATES,
  faceAnimates,
  isFaceState,
  type FaceBadge,
  type FaceState,
  type FaceStateSpec,
  type LookDriver,
} from "./states.js";
export {
  DISC_COLOR,
  FACE_CANVAS,
  FACE_CHARACTERS,
  GRID_H,
  GRID_W,
  type FaceCharacter,
} from "./sprites.js";
