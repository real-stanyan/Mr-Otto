// 名册（根）。A0 只立骨架：头上那颗账号钮 + 一句实话的空态。真数据（主场的智能体 + 群，
// 混排按最近一次动静）在 A1 接上（spec §5.2）。搜索与 ＋ 在 A1 / A2 才画——
// 点了什么都不发生的钮是撒谎的勾（#722）。
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space, usePalette } from "../theme.js";
import { Button, Card, Headline, Hint } from "../ui.js";
import { AccountButton } from "./AccountButton.js";

export function RosterScreen() {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* demo 的 .pillnav：状态栏下 8pt、左右 12pt，没有实心导航条 */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" }}>
        <AccountButton onPress={() => navigation.navigate("Account")} />
      </View>
      <View style={{ padding: space.lg, gap: space.md }}>
        <Card>
          <Headline>智能体名册</Headline>
          <Hint>下一步在这里接上真数据：你的智能体和群聊，按最近一次动静排。</Hint>
        </Card>
        {__DEV__ ? (
          <Button variant="quiet" label="形象陈列馆（开发用）" onPress={() => navigation.navigate("FaceGallery")} />
        ) : null}
      </View>
    </View>
  );
}
