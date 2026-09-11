// 两颗第三方登录的标记。一律 20pt：两个标记的视觉重量差不多，给同一个尺寸就够齐。
import { Image } from "react-native";
import { usePalette } from "../theme.js";

export function GoogleMark({ size = 20 }: { size?: number }) {
  return <Image source={require("../../assets/google-mark.png")} style={{ width: size, height: size }} />;
}

/** GitHub 那个标记是**反白猫**:黑底挖出猫。深色下黑底就看不见了,
    换成白底那版 —— 挖出来的猫这时露的是页面底色,和浅色下同一个读法 */
export function GitHubMark({ size = 20 }: { size?: number }) {
  const { isDark } = usePalette();
  return (
    <Image
      source={isDark ? require("../../assets/github-mark-light.png") : require("../../assets/github-mark.png")}
      style={{ width: size, height: size }}
    />
  );
}
