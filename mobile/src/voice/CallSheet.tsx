// 通话卡点开的那一扇（#1356 A4，spec §5.7）：从下面滑上来、不盖住头上那颗药丸（A1 那副 70% 的底部抽屉）。
// 一句一行：我说的靠右、上面一行「第几分几秒」；它说的靠左、上面一行「名字 · 第几分几秒」；
// 名单变更那几行居中只写字（不带脸）。抽屉底色是 card，所以它说的那句用 background 做底才分得开。
import { ScrollView, Text, View } from "react-native";
import { callOffsetText, type VoiceCallCard, type VoiceCallCardLine } from "../../../src/shared/cloudTimeline.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { callCardDuration } from "./CallCardRow.js";

function CallLine({ line }: { line: VoiceCallCardLine }) {
  const { c } = usePalette();
  if (line.parts !== null) {
    return <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{line.parts.map((p) => p.text).join("")}</Text>;
  }
  const at = callOffsetText(line.offsetMs);
  if (line.mine) {
    return (
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text style={{ fontSize: 12, color: c.mutedForeground, marginRight: 4, fontVariant: ["tabular-nums"] }}>{at}</Text>
        <View style={{ maxWidth: "85%", backgroundColor: withAlpha(c.foreground, 0.12), borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 }}>
          <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.foreground }}>{line.text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "flex-start", gap: 3 }}>
      <Text style={{ fontSize: 12, color: c.mutedForeground, marginLeft: 4, fontVariant: ["tabular-nums"] }}>{`${line.label} · ${at}`}</Text>
      <View style={{ maxWidth: "90%", backgroundColor: c.background, borderRadius: 20, paddingVertical: 11, paddingHorizontal: 15 }}>
        <Text selectable style={{ fontSize: 16, lineHeight: 23, color: c.foreground }}>{line.text}</Text>
      </View>
    </View>
  );
}

export function CallSheet({ visible, card, onClose, onExited }: {
  visible: boolean;
  /** 点开的那一张；抽屉退场放完之前调用方不清它（onExited 才清），正文不会在退场时一下子空掉 */
  card: VoiceCallCard | null;
  onClose: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  const title = card === null ? "语音聊天" : `语音聊天 · ${callCardDuration(card)}`;
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose} onExited={onExited}>
      <ScrollView contentContainerStyle={{ padding: space.md, gap: 10 }}>
        {card === null ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>这通电话已经不在了。</Text>
        ) : card.lines.length === 0 ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>这通电话里没人说话。</Text>
        ) : (
          card.lines.map((l) => <CallLine key={l.seq} line={l} />)
        )}
      </ScrollView>
    </BottomSheet>
  );
}
