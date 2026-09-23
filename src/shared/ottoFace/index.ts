// ottoFace —— 会动的像素脸的纯层（#1345，ADR-0316；#1356 挪进 shared，桌面与手机共用同一份）。
//
// · `character.ts`  一份角色包的契约 + 从两三个尺寸推全套眉/眼/嘴的那几个函数
// · `characters/`   十一个角色，每个一张自己的矩阵（**不是共用一张光头加头发**）
// · `sprites.ts`    13 个坑位 → 角色，外加这张脸的构图常量
// · `states.ts`     表情表
// · `frame.ts`      纯函数：坑位 + 状态 + 时刻 → 一帧的网格坐标
// · `adapt.ts`      仓里已有的状态 → 脸上的表情
//
// 画出来的那一层各端各写：桌面是 canvas（`src/renderer/src/lib/ottoFace/paint.ts`），
// 手机是 react-native-svg（`mobile/src/face/Face.tsx`）。

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
export {
  composeFrame,
  composeFrameAt,
  faceCharacterAt,
  frameMotion,
  motionKey,
  type FaceCell,
  type FaceFrame,
  type FaceMotion,
  type FrameOptions,
} from "./frame.js";
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
  displaySlotOf,
  FACE_CANVAS,
  FACE_CHARACTERS,
  GRID_H,
  GRID_W,
  pickSlotOf,
  type FaceCharacter,
} from "./sprites.js";
