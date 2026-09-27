// 记忆（#1356 A5，spec §5.8）：它们自己维护的那一叠互链页面（ADR-0282 的 wiki，住在那台电脑的 wiki/ 里）。清单读
// wiki/index.md（分组照索引：常驻 / 各只自己那一页 / 各个目录），点一页压进去看。手机上能改、不能新建或删（demo 只有
// 「改」；新建要起路径名，留在电脑上）。**读不到 ≠ 空**：上一份清单留在原地，错误另起一行。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { WIKI_ABSENT, WIKI_EMPTY, WIKI_FOOTER, wikiGroupsOf, wikiGroupTitle } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Button, Group, Hint, Inset, ListPage, Note, Row, Spinner } from "../ui.js";
import { refreshWiki, useMachine } from "./machineStore.js";

export function WikiScreen() {
  const navigation = useNavigation();
  const ws = useHome().home;
  const { wiki } = useMachine();
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId !== null) void refreshWiki(homeId);
    }, [homeId]),
  );

  if (homeId === null) {
    return <ListPage><Inset><Hint>还没有智能体，也就还没有记忆。</Hint></Inset></ListPage>;
  }
  const groups = wikiGroupsOf(wiki);
  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        {wiki.kind === "error" ? (
          <Inset>
            <Note tone="warn">{groups === null ? `这一刻读不到记忆：${wiki.message}` : `这一刻读不到最新的（${wiki.message}），下面是上一次的。`}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshWiki(homeId)} />
            </View>
          </Inset>
        ) : null}
        {wiki.kind === "loading" ? <Inset><Spinner /></Inset> : null}
        {wiki.kind === "absent" ? <Inset><Hint>{WIKI_ABSENT}</Hint></Inset> : null}
        {groups !== null && groups.length === 0 ? <Inset><Hint>{WIKI_EMPTY}</Hint></Inset> : null}
        {(groups ?? []).map((g) => (
          <Group key={g.name} header={wikiGroupTitle(g.name)} inset={52}>
            {g.entries.map((e) => (
              <Row
                key={e.path}
                leading={<RowGlyph name="book" />}
                label={e.title}
                detail={e.summary === "" ? e.path : e.summary}
                chevron
                onPress={() => navigation.navigate("WikiPage", { path: e.path })}
              />
            ))}
          </Group>
        ))}
        {groups !== null && groups.length > 0 ? <Inset><Hint>{WIKI_FOOTER}</Hint></Inset> : null}
      </View>
    </ListPage>
  );
}
