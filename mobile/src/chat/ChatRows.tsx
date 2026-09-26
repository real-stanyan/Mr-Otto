// 聊天页时间线的各行（#1356 A1，spec §5.3）。画哪一种由 shared/mobileChat.ts 的 ChatRow 决定，
// 这里只管样子（尺寸逐值取自 demo：.bub.me / .bub.ot / .who / .dayline）。
// 脸只画名册里查得到的那只（agentFaceIfKnown）：派生对陌生 id 也算得出一张脸，画上去等于
// 宣称它还在名册里。
// A3：群的名单变了那一行（`roster`）居中、名字左边一张 s 档的脸；派活那一句是一条普通的旁白。
// A4：一场语音通话折成的那张卡（`call`），点开由调用方开抽屉（onOpenCall）。
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { agentFaceIfKnown } from "../../../src/shared/agentAvatar.js";
import { NOW_PHASE_TEXT, clockLabel, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
import type { RosterLinePart } from "../../../src/shared/cloudTimeline.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Face } from "../face/Face.js";
import { CallCardRow } from "../voice/CallCardRow.js";
import { type as t, usePalette } from "../theme.js";
import { Button } from "../ui.js";

export function ChatRowView({ row, ws, onOpenCall }: { row: ChatRow; ws: WorkspaceSnapshot; onOpenCall?: (seq: number) => void }) {
  const { c } = usePalette();
  switch (row.kind) {
    case "day":
      return (
        <Text style={{ alignSelf: "center", fontSize: 11.5, letterSpacing: 0.2, color: c.mutedForeground, opacity: 0.7, paddingTop: 6 }}>
          {row.label}
        </Text>
      );
    case "mine":
      return (
        <View style={{ paddingHorizontal: 16, alignItems: "flex-end" }}>
          <View style={{
            maxWidth: "80%", backgroundColor: c.primary, borderRadius: 20, borderBottomRightRadius: 7,
            paddingVertical: 10, paddingHorizontal: 14,
          }}>
            <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.primaryForeground }}>{row.text}</Text>
          </View>
        </View>
      );
    case "human":
      return (
        <View style={{ paddingHorizontal: 16, alignItems: "flex-start", gap: 4 }}>
          <Text style={{ fontSize: 12, color: c.mutedForeground, marginLeft: 4 }}>{`${row.name} · ${clockLabel(row.ts)}`}</Text>
          <View style={{ maxWidth: "82%", backgroundColor: c.secondary, borderRadius: 19, paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.secondaryForeground }}>{row.text}</Text>
          </View>
        </View>
      );
    case "agent": {
      const face = agentFaceIfKnown(ws, row.agentId);
      return (
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 2 }}>
            {face !== null ? <Face slot={face.slot} tier="s" /> : null}
            <Text style={{ fontSize: 12, color: c.mutedForeground }}>{`${row.name} · ${clockLabel(row.ts)}`}</Text>
          </View>
          {row.paragraphs.map((p, i) => (
            <Text key={i} selectable style={{ fontSize: 16.5, lineHeight: 24, letterSpacing: -0.15, color: c.foreground, paddingHorizontal: 2 }}>
              {p}
            </Text>
          ))}
        </View>
      );
    }
    case "note":
      return <NoteRow text={row.text} tone={row.tone} detail={row.detail} />;
    case "roster":
      return <RosterLineView parts={row.parts} ws={ws} />;
    case "call":
      return <CallCardRow card={row.card} topic={row.topic} onPress={() => onOpenCall?.(row.card.seq)} />;
    default: {
      // 新加一种行而这里没接上时编译不过——这个组件没写返回类型，漏接的那一种原来会安静地什么都不画
      const unhandled: never = row;
      return unhandled;
    }
  }
}

/** 群的名单变了那一行（A3，spec §5.6）：居中；每个名字左边一张 s 档的脸——**名册里查不到的不给脸**
    （派生对陌生 id 也算得出一张脸，画上去等于宣称它还在名册里，而被移出的那只常常正是刚被删掉的那只）。
    脸与名字包在同一格里不断开，名字多了整行折行；读屏把整句念一遍（几格拼起来就是那句话本身） */
function RosterLineView({ parts, ws }: { parts: readonly RosterLinePart[]; ws: WorkspaceSnapshot }) {
  const { c } = usePalette();
  return (
    <View
      accessible
      accessibilityLabel={parts.map((p) => p.text).join("")}
      style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", paddingHorizontal: 28, rowGap: 4 }}
    >
      {parts.map((p, i) => {
        const face = p.agentId === undefined ? null : agentFaceIfKnown(ws, p.agentId);
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            {face !== null ? <Face slot={face.slot} tier="s" /> : null}
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{p.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** 旁白 / 出错。带全文（后台任务那一档、出错原文）时点一下展开 */
function NoteRow({ text, tone, detail }: { text: string; tone: "muted" | "error"; detail: string | null }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const color = tone === "error" ? c.destructive : c.mutedForeground;
  const body = (
    <View style={{ alignItems: "center", paddingHorizontal: 28, gap: 4 }}>
      <Text style={{ ...t.footnote, color, textAlign: "center" }}>
        {text}
        {detail !== null && !open ? " ›" : ""}
      </Text>
      {open && detail !== null ? (
        <Text selectable style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{detail}</Text>
      ) : null}
    </View>
  );
  if (detail === null) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "收起详情" : "展开详情"}
      onPress={() => setOpen((v) => !v)}
      style={({ pressed }) => [pressed && { opacity: 0.6 }]}
    >
      {body}
    </Pressable>
  );
}

/** 最底下那一行 =「此刻」：脸 m 档跟着 dmFaceState 走、「名字 · 时间 · 排队中 / 执行中 / 作答中」，
    没有打字的三个点；「停一下」只在它真在跑时出现 */
export function NowRowView({ now, ws, ready, stopping, onStop }: {
  now: NowRow;
  ws: WorkspaceSnapshot;
  ready: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const { c } = usePalette();
  const face = agentFaceIfKnown(ws, now.agentId);
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 10 }}>
      {face !== null ? <Face slot={face.slot} tier="m" state={now.face} phase={facePhase(now.agentId)} ringColor={c.background} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, ...t.footnote, color: c.mutedForeground }}>
        {`${now.name} · ${clockLabel(now.ts)} · ${NOW_PHASE_TEXT[now.phase]}`}
      </Text>
      {now.canStop ? (
        <Button size="auto" variant="outline" label={stopping ? "正在停…" : "停一下"} onPress={onStop} disabled={!ready || stopping} />
      ) : null}
    </View>
  );
}
