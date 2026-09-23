// 形象陈列馆——**只在开发构建里出现**（#1356 A0）。A1 之前手机上没有任何一屏会画真智能体的脸，
// 这一屏是在模拟器上对着 demo 核一遍画法的唯一入口：11 张脸、全部表情、三档尺寸、深浅两套底
// （切系统外观看描边）。同桌面 scripts/build-face-gallery.mjs 的用途，不是产品的一部分。
import { ScrollView, Text, View } from "react-native";
import {
  FACE_PACKS,
  FACE_STATE_LIST,
  FACE_STATES,
  firstSlotOf,
} from "../../../src/shared/ottoFace/index.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { space, type as t, usePalette } from "../theme.js";
import { Face } from "../face/Face.js";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...t.footnote, color: c.mutedForeground }}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "flex-end" }}>
        {children}
      </View>
    </View>
  );
}

function Caption({ children }: { children: string }) {
  const { c } = usePalette();
  return <Text style={{ ...t.footnote, fontSize: 10.5, color: c.mutedForeground, textAlign: "center" }}>{children}</Text>;
}

export function FaceGallery() {
  const specs = firstSlotOf("specs") ?? 0;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Section title="11 个角色 · alive · m 档（错开相位，不该一起眨眼）">
        {FACE_PACKS.map((p) => (
          <Face key={p.id} slot={firstSlotOf(p.id) ?? 0} state="alive" tier="m" phase={facePhase(p.id)} label={p.name} />
        ))}
      </Section>
      <Section title="全部表情 · specs · m 档">
        {FACE_STATE_LIST.map((s) => (
          <View key={s} style={{ alignItems: "center", gap: 4 }}>
            <Face slot={specs} state={s} tier="m" />
            <Caption>{FACE_STATES[s].zh}</Caption>
          </View>
        ))}
      </Section>
      <Section title="三档 · working（s / m / l）">
        <Face slot={specs} state="working" tier="s" />
        <Face slot={specs} state="working" tier="m" />
        <Face slot={specs} state="working" tier="l" />
      </Section>
    </ScrollView>
  );
}
