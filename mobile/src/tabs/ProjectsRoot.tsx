// 项目栏的根：到自己那台电脑的投影（ADR-0094），M4 之前就是原来那一页舰队。
// 配对不再是进门的一步（spec §4.1）：没配过的人在这里看到一张卡，点了去扫码。
import { useCallback, useLayoutEffect, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Button, Card, Headline, Hint, Page } from "../ui.js";
import { useLink } from "../link.js";
import { useTabChrome } from "../chrome.js";
import { Fleet } from "../projects/Fleet.js";

export function ProjectsRoot() {
  const navigation = useNavigation();
  const { store, pairEpoch } = useLink();
  const { setHidden } = useTabChrome();
  const [paired, setPaired] = useState(() => store.peerIdentities().length > 0);
  // PinnedPeerStore 没有订阅口：从配对页回来、或者重新配过一台，都重新数一遍
  useFocusEffect(useCallback(() => {
    setPaired(store.peerIdentities().length > 0);
  }, [store, pairEpoch]));

  // 点进一个会话 = 推进一层：大标题那条导航栏和页签栏一起让位（会话页自己有返回栏）
  const [inDetail, setInDetail] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !inDetail });
    setHidden(inDetail);
  }, [navigation, inDetail, setHidden]);

  const toPair = (): void => navigation.navigate("Pair");

  if (!paired) {
    return (
      <Page>
        <Card>
          <Headline>还没配对电脑</Headline>
          <Hint>项目住在你的电脑上。扫一下电脑「设置 → 手机」里那张码，这里就能看、能批、能接着说。</Hint>
          <Button label="扫码配一台电脑" onPress={toPair} />
        </Card>
      </Page>
    );
  }
  // key = 配对次数：重新配过一台就整条连接重建（原来是「重新配对」把整个壳卸掉，效果相同）
  return <Fleet key={pairEpoch} store={store} onRepair={toPair} onDetailChange={setInDetail} />;
}
