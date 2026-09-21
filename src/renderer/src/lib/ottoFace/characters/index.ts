// 角色花名册。**加角色只改这一个文件**（外加 characters/<id>.ts 本身）。
//
// 顺序就是 UI 里的排列顺序——用户在智能体创建页面挑形象，看到的是这个顺序。
// Otto 排第一：它是产品自己的脸，不是一个可选项里的普通一项。

import type { FaceCharacter } from "../character.js";
import { OTTO } from "./otto.js";
import { BERET } from "./beret.js";
import { SPECS } from "./specs.js";
import { SCHOLAR } from "./scholar.js";
import { BOB } from "./bob.js";
import { SAGE } from "./sage.js";
import { STOIC } from "./stoic.js";
import { CAP } from "./cap.js";
import { MANE } from "./mane.js";
import { SWEEP } from "./sweep.js";
import { GRIN } from "./grin.js";

export { OTTO, BERET, SPECS, SCHOLAR, BOB, SAGE, STOIC, CAP, MANE, SWEEP, GRIN };

export const FACE_CHARACTERS: readonly FaceCharacter[] = [
  OTTO, BERET, SPECS, SCHOLAR, BOB, SAGE, STOIC, CAP, MANE, SWEEP, GRIN,
];

export function faceCharacter(id: string): FaceCharacter | undefined {
  return FACE_CHARACTERS.find((c) => c.id === id);
}

/** 全体角色共用的网格尺寸。**加角色时新角色必须补白到这个尺寸**（有测试钉着）——
 *  花名册上一排头像，谁大一圈谁小一圈是第一眼就看得出来的，而缩放只能取整，
 *  靠渲染这一侧补不回来。 */
export const FACE_CANVAS = { w: FACE_CHARACTERS[0]!.w, h: FACE_CHARACTERS[0]!.h } as const;
