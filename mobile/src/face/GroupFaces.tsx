// 群那几张脸横着叠（#1356 A1，spec §5.2）：s 档，总宽钉死 = m 档单只的宽（名册这一列的
// 左边缘因此是一条直线），后一张压前一张（后画的在上面）。几何在 shared/mobileRoster.ts。
import { View } from "react-native";
import { GROUP_FACES_WIDTH, groupFaceOffsets } from "../../../src/shared/mobileRoster.js";
import { faceBox, facePhase } from "../../../src/shared/ottoFace/art.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { Face } from "./Face.js";

export function GroupFaces({ agentIds, slots, state = "alive", height }: {
  agentIds: string[];
  slots: number[];
  state?: FaceState;
  /** 外框高度：名册那一行给 m 档单只的高（52），药丸里不给（= 一张 s 档的高） */
  height?: number;
}) {
  const { w, h } = faceBox("s");
  const offsets = groupFaceOffsets(slots.length);
  return (
    <View style={{ width: GROUP_FACES_WIDTH, height: height ?? h, justifyContent: "center" }}>
      <View style={{ width: GROUP_FACES_WIDTH, height: h }}>
        {slots.map((slot, i) => (
          <View key={agentIds[i] ?? String(i)} style={{ position: "absolute", left: offsets[i] ?? 0, top: 0, width: w, height: h }}>
            <Face slot={slot} tier="s" state={state} phase={facePhase(agentIds[i] ?? String(i))} />
          </View>
        ))}
      </View>
    </View>
  );
}
