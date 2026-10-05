// 朋友的智能体的主人那枚小药丸（#1641）：名字右边一枚，主人的头像 + 名字。
// 标题只写智能体自己的名字——「爸爸 的 管理员」读起来是一句话，名字被埋在后半截；拆开后名字在前、归属是附注。
// 读屏不读它：调用方把「X 的智能体」拼进那一行自己的 accessibilityLabel。
import { Text, View } from "react-native";
import type { PersonAvatar } from "../../../src/shared/wechatInbox.js";
import { usePalette } from "../theme.js";
import { PersonTile } from "./Avatar.js";

const H = 20;
const FACE = 16;

export function OwnerPill({ owner, maxWidth = 104 }: { owner: PersonAvatar; maxWidth?: number }) {
  const { c } = usePalette();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: "row", alignItems: "center", gap: 4, height: H, maxWidth, flexShrink: 0,
        paddingLeft: (H - FACE) / 2, paddingRight: 8, borderRadius: 999, backgroundColor: c.secondary,
      }}
    >
      <PersonTile name={owner.name} url={owner.url} size={FACE} radius={FACE / 2} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: c.mutedForeground }}>{owner.name}</Text>
    </View>
  );
}
