// 「Mr Otto」字标：Poppins SemiBold Italic，同桌面进门闸那一行（SignInScreen.tsx，app.css 的 @font-face）。
// 字体没加载出来之前退成系统的斜体半粗——这一行照样读得出是同一个字标，不闪一个空位。
import { Text } from "react-native";
import { Poppins_600SemiBold_Italic, useFonts } from "@expo-google-fonts/poppins";
import { usePalette } from "../theme.js";

export function Wordmark() {
  const { c } = usePalette();
  const [loaded] = useFonts({ Poppins_600SemiBold_Italic });
  return (
    <Text style={[
      { fontSize: 17, lineHeight: 22, letterSpacing: -0.1, color: c.foreground },
      loaded ? { fontFamily: "Poppins_600SemiBold_Italic" } : { fontStyle: "italic", fontWeight: "600" },
    ]}>
      Mr Otto
    </Text>
  );
}
