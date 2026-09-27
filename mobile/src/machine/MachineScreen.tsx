// 它们的电脑（#1356 A5，spec §5.8）：它们共用的那一容器一卷（ADR-0232）。一组四行——文件 / 应用 / 记忆 / 这周用了多少。
// 数字只报查得到的（shared 的 machineRows）：磁盘、文件数、「等你登录」都问不出来，所以不画（spec §10 第 80–81 条）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { MACHINE_FOOTER, machineRows, machineShareText, type MachineRowView } from "../../../src/shared/mobileMachine.js";
import { RowGlyph, type RowGlyphName } from "../chrome/RowGlyphs.js";
import { useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Group, Hint, Page, Row } from "../ui.js";
import { refreshUsage, refreshWiki, useMachine } from "./machineStore.js";

const GLYPH: Record<MachineRowView["key"], RowGlyphName> = { files: "folder", apps: "plug", wiki: "book", usage: "chart" };

export function MachineScreen() {
  const navigation = useNavigation();
  const ws = useHome().home;
  const m = useMachine();
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId === null) return;
      void refreshWiki(homeId);
      void refreshUsage(homeId);
    }, [homeId]),
  );

  if (ws === null) {
    return <Page><Hint>还没有智能体，也就还没有这台电脑。</Hint></Page>;
  }
  const rows = machineRows({ apps: ws.connectors.length, wiki: m.wiki, usage: m.usage });
  const go = (key: MachineRowView["key"]): void => {
    if (key === "files") navigation.navigate("Files", { path: "" });
    else if (key === "apps") navigation.navigate("Apps");
    else if (key === "wiki") navigation.navigate("Wiki");
    else navigation.navigate("Usage");
  };
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Group header={machineShareText(ws)} footer={MACHINE_FOOTER}>
          {rows.map((r) => (
            <Row
              key={r.key}
              leading={<RowGlyph name={GLYPH[r.key]} />}
              label={r.title}
              detail={r.detail}
              {...(r.value === null ? {} : { value: r.value })}
              chevron
              onPress={() => go(r.key)}
            />
          ))}
        </Group>
      </View>
    </Page>
  );
}
