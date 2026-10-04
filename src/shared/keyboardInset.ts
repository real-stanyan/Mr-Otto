// 键盘占了这一屏底下多少——直接当 paddingBottom 用的那个数（#1490）。纯算术，手机端 ui.tsx 的 useKeyboardInset 调它，进 vitest。
//
// bottom：这一屏底边在**屏幕坐标**里的位置（measureInWindow 的 y + h），还没量到就是 null；
// frame：keyboardWillChangeFrame 的 endCoordinates（screenY = 键盘顶边的屏幕坐标，height = 键盘自己多高）。
//
// 为什么夹到键盘高度：iOS 偶发会把 screenY 报成 0（RN 自己的 KeyboardAvoidingView 为此专门留了
// 「Prefer Cross-Fade Transitions 时 screenY===0 当没键盘」那条例外——说明它见过）。不夹的话差值 = 整个内容区：
// 列表被挤成 0、输入栏贴到标题栏正下方、底下整块空白——真机截图里就是这个样子，而且是偶发的。
// 让位本来就不可能比键盘本身还高，所以夹住不会让正常那条路少让一点。
export function keyboardInsetOf(bottom: number | null, frame: { screenY: number; height: number }): number {
  if (bottom === null) return 0;
  const height = Number.isFinite(frame.height) ? Math.max(0, frame.height) : 0;
  if (height === 0 || !Number.isFinite(frame.screenY)) return 0;
  const raw = bottom - frame.screenY;
  if (raw <= 0) return 0;
  return Math.min(raw, height);
}
