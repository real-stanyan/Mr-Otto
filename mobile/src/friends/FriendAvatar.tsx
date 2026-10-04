// 朋友的头像带在线点（#1460）：右下角绿 = 在线、红 = 不在线；不知道（对方从没报过）不画点。
import { View } from "react-native";
import { PersonTile } from "../wx/Avatar.js";
import { PresenceDot } from "../wx/Badge.js";
import { usePresence } from "./presenceStore.js";

export function FriendAvatar({ uid, name, url, size, radius, ring, dot = 10 }: {
  uid: string;
  name: string;
  url: string;
  size: number;
  radius?: number;
  /** 点外面那圈环的颜色 = 头像底下那块的底色 */
  ring: string;
  dot?: number;
}) {
  const presence = usePresence(uid);
  return (
    <View>
      <PersonTile name={name} url={url} size={size} {...(radius === undefined ? {} : { radius })} />
      {presence !== null ? (
        <View style={{ position: "absolute", bottom: -3, right: -3 }}>
          <PresenceDot presence={presence} ring={ring} size={dot} />
        </View>
      ) : null}
    </View>
  );
}
