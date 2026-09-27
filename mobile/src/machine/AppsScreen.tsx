// 应用（#1356 A5，spec §5.8）：接着的那几个（workspace_connectors，桌面贡献进来的）。**只列，不画状态、不给钮**：
// 连没连上 / 要不要重新登录只活在桌面进程里，手机问不出来；接新的、登录都在电脑上做（spec §10 第 80 条）。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { APPS_EMPTY, APPS_FOOTER, appRows } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Group, Hint, Page, Row } from "../ui.js";

export function AppsScreen() {
  const ws = useHome().home;
  // 清单跟着名册那份快照走（connectors 就在里面）；进这一页拉一次新的
  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );
  if (ws === null) {
    return <Page><Hint>还没有智能体。</Hint></Page>;
  }
  const rows = appRows(ws);
  return (
    <Page>
      {rows.length === 0 ? (
        <View style={{ gap: space.sm }}>
          <Hint>{APPS_EMPTY}</Hint>
          <Hint>{APPS_FOOTER}</Hint>
        </View>
      ) : (
        <Group footer={APPS_FOOTER}>
          {rows.map((r) => (
            <Row key={r.key} leading={<RowGlyph name="plug" />} label={r.title} detail={r.detail} />
          ))}
        </Group>
      )}
    </Page>
  );
}
