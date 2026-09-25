// ＋ 那张岔路弹窗（#1356 A2，spec §5.5 / §4）：居中、**点外面能退**（按错了不该被关在里面）；
// 两行 + 一颗取消。形状是居中弹窗不是底部抽屉：抽屉在这个 App 里是「挑东西」（换个形象），
// 而这一下是一条新流程的岔路口（demo 的 newThing，维护者定的）。
//
// 两行左边画的都是**这一选会生出来的东西**：app 自己那张脸（此刻还没有谁——随手挑一张现成的脸
// 会让人以为那就是将要建出来的那只长什么样）/ 你的几只横排。左栏定宽 100、图一律靠左：两行正文
// 要从同一条竖线起，差几个点在并列的两行上一眼就看得出来（demo 的 .pickdlg）。
// 「一个群聊」要到 A3 才接上：这一片画出来但按不动、副标题照实说——不画一颗点了没去处的钮（#722），
// 也不把它藏起来让这张弹窗只剩一条路（spec §10 第 29 条）。
import type { ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { Dialog } from "../dialog.js";
import { Face } from "../face/Face.js";
import { usePalette, withAlpha } from "../theme.js";
import { Button } from "../ui.js";

function PickRow({ left, title, sub, disabled = false, onPress }: {
  left: ReactNode;
  title: string;
  sub: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}。${sub}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 14 },
        pressed && { backgroundColor: withAlpha(c.foreground, 0.08) },
        disabled && { opacity: 0.45 },
      ]}
    >
      <View style={{ width: 100, flexDirection: "row", alignItems: "center" }}>{left}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", letterSpacing: -0.1, color: c.foreground }}>{title}</Text>
        <Text style={{ fontSize: 12.5, lineHeight: 17, color: c.mutedForeground, marginTop: 2 }}>{sub}</Text>
      </View>
    </Pressable>
  );
}

export function NewThingDialog({ visible, groupFaces, onAgent, onDismiss, onExited }: {
  visible: boolean;
  /** 「一个群聊」那一行左边那几张（名册里的前三只） */
  groupFaces: { id: string; slot: number }[];
  /** 点了「一只智能体」：调用方收起弹窗，退场放完（onExited）再升抽屉 */
  onAgent: () => void;
  /** 取消 / 点外面 / 返回键 */
  onDismiss: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  return (
    <Dialog visible={visible} dismissible onDismiss={onDismiss} wide onExited={onExited}>
      <Text
        accessibilityRole="header"
        style={{ fontSize: 19, lineHeight: 25, fontWeight: "700", letterSpacing: -0.3, textAlign: "center", color: c.foreground, marginBottom: 10 }}
      >
        新建
      </Text>
      <PickRow
        left={<Image source={require("../../assets/otto.png")} style={{ width: 50, height: 50, borderRadius: 13 }} />}
        title="一只智能体"
        sub="说一句它是干什么的就行。它和别的智能体共用一台电脑。"
        onPress={onAgent}
      />
      <PickRow
        left={
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {groupFaces.map((f, n) => (
              // 互相压一点（-5）：三只收进 100 的左栏；一点不叠要 88.5，正文就得再往右让（demo 的 faceRow）
              <View key={f.id} style={{ marginLeft: n === 0 ? 0 : -5 }}>
                <Face slot={f.slot} tier="s" />
              </View>
            ))}
          </View>
        }
        title="一个群聊"
        sub="还没做好，下一步就有。"
        disabled
        onPress={() => {}}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Button size="dialog" variant="secondary" label="取消" onPress={onDismiss} />
      </View>
    </Dialog>
  );
}
