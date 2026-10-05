// 私聊页里人的头像 + 底下一排小圆脸（#1642）：这个人带进这条私聊的智能体。原来画在页顶的两条横幅
// （「带着 @峰哥 · 公开给 TA」「继爸带着 @雨姐 · 你也能 @」）挪到了这里——谁带的就挂在谁的头像底下。
// · 小圆脸压住头像下沿一点（像挂在头像上），彼此叠一点；最多三格（超过三只画两张脸 +「+n」），不然靠屏幕边那一侧会出界。
// · 朋友带的私人智能体只知道几只、不知道是谁（pair_presence），画成同样大小的空心灰圆。
// · 车道还没连上：脸淡一些（原横幅上的「（连接中）」）。
// · 点我自己的头像进编辑页（带上 / 移除 / 给谁看）；朋友的头像不可点。
import { Pressable, Text, View } from "react-native";
import { usePalette } from "../theme.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";

export interface AgentDot {
  key: string;
  slot: number;
  name: string;
}

const AVATAR = 40;
const DOT = 18;
const OVERLAP = 5;
const SHOWN = 3;

export function HumanAvatar({ name, url, me = false, dots, hidden = 0, dim = false, onPress, label }: {
  name: string;
  url: string;
  me?: boolean;
  dots: readonly AgentDot[];
  /** 看不到是谁的私人智能体有几只 */
  hidden?: number;
  dim?: boolean;
  onPress?: () => void;
  /** 读屏：整块读这一句 */
  label?: string;
}) {
  const { c } = usePalette();
  const total = dots.length + hidden;
  const room = total > SHOWN ? SHOWN - 1 : SHOWN;
  const faces = dots.slice(0, room);
  const blanks = Math.max(0, Math.min(hidden, room - faces.length));
  const more = total - faces.length - blanks;
  const ring = { borderWidth: 1.5, borderColor: c.background, borderRadius: DOT / 2 + 1.5 } as const;
  const tile = (
    <View style={{ width: AVATAR, alignItems: "center" }}>
      <PersonTile name={name} url={url} size={AVATAR} me={me} />
      {total > 0 ? (
        <View style={{ flexDirection: "row", marginTop: -OVERLAP, opacity: dim ? 0.45 : 1 }}>
          {faces.map((d, i) => (
            <View key={d.key} style={[ring, { overflow: "hidden" }, i > 0 && { marginLeft: -OVERLAP }]}>
              <FaceTile slot={d.slot} size={DOT} radius={DOT / 2} />
            </View>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <View key={`h${i}`} style={[ring, faces.length + i > 0 && { marginLeft: -OVERLAP }]}>
              <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: c.secondary, borderWidth: 1, borderColor: c.faint, borderStyle: "dashed" }} />
            </View>
          ))}
          {more > 0 ? (
            <View style={[ring, { marginLeft: -OVERLAP }]}>
              <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 9, fontWeight: "600", color: c.mutedForeground }}>{`+${more}`}</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  if (onPress === undefined) {
    return (
      <View accessible={label !== undefined} {...(label !== undefined ? { accessibilityLabel: label } : {})}>
        {tile}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" {...(label !== undefined ? { accessibilityLabel: label } : {})} hitSlop={4} onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
      {tile}
    </Pressable>
  );
}

