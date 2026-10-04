// 全屏看图怎么关（#1518，维护者：「和微信交互逻辑一样」）：图片页点一下就关、整屏下拽过阈值关、
// 左右翻页不受影响、X 留给视频页。读源码钉住接线，别让下次改版又回到「只有 X 能关」。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const viewer = (): string => read("mobile/src/media/MediaViewer.tsx");

describe("MediaViewer 的退出方式", () => {
  it("图片页整页是一颗 Pressable，点一下 → onTap → onClose；视频页不挂（原生控件要吃点击）", () => {
    const src = viewer();
    expect(src).toMatch(/accessibilityLabel="点一下关闭" onPress=\{onTap\}/);
    expect(src).toMatch(/<ImagePage [^\n]*onTap=\{onClose\}/);
    expect(src).not.toMatch(/<VideoPage [^\n]*onTap=/);
  });
  it("下拽：Pan 只认竖向（activeOffsetY / failOffsetX 同一个起步量），落点用 gestureMath 的动量投影，往上有阻尼", () => {
    const src = viewer();
    expect(src).toMatch(/Gesture\.Pan\(\)/);
    expect(src).toMatch(/\.activeOffsetY\(\[-DRAG_START, DRAG_START\]\)/);
    expect(src).toMatch(/\.failOffsetX\(\[-DRAG_START, DRAG_START\]\)/);
    expect(src).toMatch(/e\.translationY \+ projectMomentum\(e\.velocityY\)/);
    expect(src).toMatch(/e\.velocityY > DISMISS_VELOCITY \|\| landing > height \* DISMISS_DISTANCE/);
    expect(src).toMatch(/rubberband\(e\.translationY, RUBBER_MAX, RUBBER_SLOPE\)/);
    expect(src).toMatch(/from "\.\.\/\.\.\/\.\.\/src\/shared\/gestureMath\.js"/);
  });
  it("黑底自己画且随下拽变淡：Modal 透明，不再 presentationStyle=fullScreen", () => {
    const src = viewer();
    expect(src).toMatch(/<Modal visible transparent animationType="fade"/);
    expect(src).not.toMatch(/presentationStyle="fullScreen"/);
    expect(src).toMatch(/backgroundColor: "#000000" \}, fadeStyle\]/);
    expect(src).toMatch(/<GestureHandlerRootView style=\{\{ flex: 1 \}\}>/);
  });
  it("右上角那颗 X 留着（视频页靠它）", () => {
    expect(viewer()).toMatch(/accessibilityLabel="关闭"/);
  });
  it("只走热更新：gesture-handler / reanimated 都已在 mobile/package.json 里", () => {
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toHaveProperty("react-native-gesture-handler");
    expect(pkg.dependencies).toHaveProperty("react-native-reanimated");
  });
});
