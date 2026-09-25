// 「换个形象」（#1356 A1，spec §5.4）：上面一张 l 档大脸走一遍它干活的样子（换一张脸从头走、
// 缩一下再回来），下面那面墙只有选中那张是活的。与「新建智能体」共用一副骨架（FaceWall.tsx，A2 抽出）。
// 点一张只改表单里的那一格；真正写库在设置页按「存」的时候（没换就不写）。
import { ScrollView, View } from "react-native";
import { faceCharacterAt } from "../../../src/shared/ottoFace/index.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette } from "../theme.js";
import { FacePreview, FaceWall } from "./FaceWall.js";

export function FacePickerSheet({ visible, current, onPick, onClose, onExited }: {
  visible: boolean;
  /** 此刻画的那一格（表单里的选择，没挑过就是派生出来的那张） */
  current: number;
  onPick: (slot: number) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  return (
    <BottomSheet visible={visible} title="换个形象" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingTop: 8, paddingBottom: 24 }}>
        <FacePreview slot={current} ring={c.card} />
        <View style={{ marginTop: 20, alignSelf: "stretch" }}>
          <FaceWall current={faceCharacterAt(current).id} onPick={(f) => onPick(f.slot)} />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
