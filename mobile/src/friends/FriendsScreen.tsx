// 好友从页签降到账号栈里（spec §4.6，M6 再换皮）。它自己有「加好友 / 聊天」两个内层屏，
// 各带一条自己的返回栏；翻进去时把根栈那条原生导航栏收起来，两条栏不叠。
// 页签上的角标（待处理请求 + 未读）三栏之后暂时没有地方画——M6 接回，ADR 里记着。
import { useCallback, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Friends } from "../friends.js";

export function FriendsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [inDetail, setInDetail] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !inDetail });
  }, [navigation, inDetail]);
  const ignoreBadge = useCallback((_n: number) => {}, []);
  return (
    // 导航栏收起时内层那条返回栏要自己躲开刘海和 home 条
    <View style={{ flex: 1, paddingTop: inDetail ? insets.top : 0, paddingBottom: inDetail ? insets.bottom : 0 }}>
      <Friends embedded onDetailChange={setInDetail} onBadge={ignoreBadge} />
    </View>
  );
}
