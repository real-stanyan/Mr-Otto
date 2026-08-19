// 暂存区准入的纯逻辑:分类结果 → (新 staged, 给人看的错误)。
// ＋ 按钮和粘贴共用这一份——两条入口不该有两套限额。

import type { StagedAttachment } from "../../../shared/shellBridge.js";

export type StagedOk = Extract<StagedAttachment, { kind: "image" | "text" }>;

/** 一条消息最多带几张图(模型侧的实际约束,不是拍脑袋) */
export const MAX_IMAGES = 4;

export interface MergeResult {
  staged: StagedOk[];
  /** null = 没有需要告诉用户的事 */
  error: string | null;
}

/**
 * 把新分类出来的附件并进已暂存的,顺便执行限额。
 * 被拒的和被裁掉的都要出声——静默丢弃会让用户以为传上了。
 */
export function mergeStaged(current: StagedOk[], picked: StagedAttachment[]): MergeResult {
  const ok = picked.filter((a): a is StagedOk => a.kind !== "rejected");
  const errors = picked
    .filter((a): a is Extract<StagedAttachment, { kind: "rejected" }> => a.kind === "rejected")
    .map((r) => `「${r.name}」被拒:${r.reason}`);

  let staged = [...current, ...ok];
  const images = staged.filter((a) => a.kind === "image").length;
  if (images > MAX_IMAGES) {
    let kept = 0;
    // 保留先来的:后粘的被裁,比"最后一张顶掉第一张"更符合直觉
    staged = staged.filter((a) => a.kind !== "image" || ++kept <= MAX_IMAGES);
    errors.push(`图片最多 ${MAX_IMAGES} 张/条,多出的 ${images - MAX_IMAGES} 张已忽略`);
  }
  return { staged, error: errors.length > 0 ? errors.join("；") : null };
}
