// 聊天页的键盘让位接线（#1490）。手机代码依赖 react-native 进不了 vitest，这里读源码钉住：
// ① 两个聊天页都不再用 KeyboardAvoidingView + useHeaderHeight（算式里那个外来的输入就是真机偶发顶飞的嫌疑）；
// ② 换成 ui.tsx 的 useKeyboardInset：根 View 挂 ref + onLayout、paddingBottom 吃那个数；
// ③ 那个 hook 的算术走 shared 的 keyboardInsetOf（夹到键盘高度），键盘事件里再量一次底边。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe.each(["mobile/src/chat/ChatScreen.tsx", "mobile/src/friends/FriendChatScreen.tsx"])("%s", (path) => {
  const src = read(path);
  it("不再用 KeyboardAvoidingView / useHeaderHeight（注释里提它们可以，调用与 import 不许）", () => {
    expect(src).not.toMatch(/<KeyboardAvoidingView/);
    expect(src).not.toMatch(/useHeaderHeight\(/);
    expect(src).not.toMatch(/@react-navigation\/elements/);
  });
  it("根 View 挂 useKeyboardInset 的 ref + onLayout，paddingBottom 吃让位", () => {
    expect(src).toMatch(/const kb = useKeyboardInset\(/);
    expect(src).toMatch(/<View ref=\{kb\.root\.ref\} onLayout=\{kb\.root\.onLayout\} style=\{\{ flex: 1, paddingBottom: kb\.keyboard \}\}>/);
  });
});

describe("useKeyboardInset", () => {
  const src = read("mobile/src/ui.tsx");
  it("算术走 shared 的 keyboardInsetOf", () => {
    expect(src).toMatch(/import \{ keyboardInsetOf \} from "\.\.\/\.\.\/src\/shared\/keyboardInset\.js"/);
    expect(src).toMatch(/keyboardInsetOf\(bottom\.current, frame\)/);
  });
  it("键盘事件里再量一次底边，量到的不一样就补一拍", () => {
    expect(src).toMatch(/measure\(\(b\) => \{\s*const again = keyboardInsetOf\(b, frame\);/);
  });
  it("keyboardDidHide 兜底归零", () => {
    expect(src).toMatch(/Keyboard\.addListener\("keyboardDidHide"/);
  });
});
