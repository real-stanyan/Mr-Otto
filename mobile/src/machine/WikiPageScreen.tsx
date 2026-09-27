// 记忆里的一页（#1356 A5）：标题、「谁写的 · 什么时候 · 常驻」、摘要、正文（纯文本，可长按选中；markdown 不渲染——手机
// 端没有 markdown 渲染器，不为它加依赖）、「它提到的」那几页（正文里的 [[链接]]）。右上「改」压改这一页。
// **读不到 ≠ 空**：上一次读到的这一页留着，错误另起一行。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { WIKI_TRUNCATED, wikiGroupsOf, wikiLinkRows, wikiMetaLine, wikiPageFrom } from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, type WikiPage } from "../../../src/shared/wiki.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { type as t, space, usePalette } from "../theme.js";
import { Card, Group, Hint, Inset, Note, Row, Spinner, useNow } from "../ui.js";
import { refreshWiki, useMachine } from "./machineStore.js";

type Props = NativeStackScreenProps<RootStackParams, "WikiPage">;

export function WikiPageScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const { wiki } = useMachine();
  const now = useNow(60_000);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${path}`);
    const got = r.ok ? wikiPageFrom(path, r.value) : { ok: false as const, message: r.message };
    if (!got.ok) {
      setError(got.message);
      return;
    }
    setError(null);
    setPage(got.page);
    setTruncated(got.truncated);
  }, [homeId, path]);
  // 改完回来要看见新的；索引没读过（从名册搜索直接点进来）就顺手读一次，「它提到的」要靠它认标题
  useFocusEffect(
    useCallback(() => {
      void load();
      if (homeId !== null) void refreshWiki(homeId);
    }, [load, homeId]),
  );

  const loaded = page !== null;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (loaded && !truncated ? <HeaderTextButton label="改" disabled={false} onPress={() => navigation.navigate("WikiEdit", { path })} /> : null),
    });
  }, [navigation, loaded, truncated, path]);

  const links = page === null ? [] : wikiLinkRows(page, wikiGroupsOf(wiki) ?? []);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xl, gap: space.md }}
    >
      {error !== null ? <Inset><Note tone="warn">{page === null ? error : `这一刻读不到最新的（${error}），下面是上一次的。`}</Note></Inset> : null}
      {page === null && error === null ? <Inset><Spinner /></Inset> : null}
      {page !== null ? (
        <>
          <View style={{ gap: 6, paddingHorizontal: space.md }}>
            <Text style={{ ...t.title, color: c.foreground }}>{page.front.title}</Text>
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{wikiMetaLine(page, now)}</Text>
            {page.front.summary !== "" ? <Text style={{ ...t.callout, color: c.foreground }}>{page.front.summary}</Text> : null}
          </View>
          {truncated ? <Inset><Hint>{WIKI_TRUNCATED}</Hint></Inset> : null}
          <Card style={{ marginHorizontal: 12, borderRadius: 14 }}>
            <Text selectable style={{ ...t.callout, lineHeight: 23, color: page.body.trim() === "" ? c.mutedForeground : c.foreground }}>
              {page.body.trim() === "" ? "这一页还没有正文。" : page.body.trim()}
            </Text>
          </Card>
          {links.length > 0 ? (
            <Group header="它提到的" inset={52}>
              {links.map((e) => (
                <Row key={e.path} leading={<RowGlyph name="book" />} label={e.title} chevron onPress={() => navigation.push("WikiPage", { path: e.path })} />
              ))}
            </Group>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
