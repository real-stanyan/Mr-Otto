// ottoFace —— 会动的像素脸（#1345，ADR-0311）。四个文件各管一件事：
//
// · `sprites.ts` 画料（一张光头 + 13 个角色包 + 眉/眼/嘴三层）
// · `states.ts`  16 档表情（15 个真状态 + 一个 plain）
// · `frame.ts`   纯函数：坑位 + 状态 + 时刻 → 一帧的网格坐标
// · `paint.ts`   canvas 那一层，一个判断都不做
//
// 组件在 `components/AgentFace.tsx`。

export { dmFaceState } from "./adapt.js";
export { composeFrame, faceCharacterAt, type FaceCell, type FaceFrame } from "./frame.js";
export { paintFace, sizeFaceCanvas } from "./paint.js";
export {
  BADGE_COLORS,
  FACE_STATES,
  faceAnimates,
  type FaceBadge,
  type FaceState,
} from "./states.js";
export {
  FACE_CHARACTERS,
  FACE_COLORS,
  GRID_H,
  GRID_W,
  type FaceCharacter,
} from "./sprites.js";
