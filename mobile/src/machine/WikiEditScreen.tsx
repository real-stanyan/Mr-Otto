// 改记忆里的一页（#1356 A5）：标题 / 摘要 / 常驻 / 正文，右上「存」。走 wiki_write 帧——服务端与 wiki 工具同一条写入
// 路径（人改的和它们改的过同一道门：盖章、索引、日志、备份，ADR-0282）。**整页替换**：页头里的 sources 这张表改不了，
// 原样带回去（不带就是人每改一句正文就顺手删掉了它，桌面同一条）。进来时现读一遍，改的是此刻那一版。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { wikiEditError, wikiPageFrom } from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, WIKI_SUMMARY_MAX, WIKI_TITLE_MAX, type WikiPage } from "../../../src/shared/wiki.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { MONO, type as t, radius, space, usePalette } from "../theme.js";
import { Field, Labeled, Note, Spinner } from "../ui.js";
import { refreshWiki } from "./machineStore.js";

type Props = NativeStackScreenProps<RootStackParams, "WikiEdit">;

export function WikiEditScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const [page, setPage] = useState<WikiPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [pinned, setPinned] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (homeId === null) return;
      await ensureUid();
      const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${path}`);
      const got = r.ok ? wikiPageFrom(path, r.value) : { ok: false as const, message: r.message };
      if (!got.ok) {
        setLoadError(got.message);
        return;
      }
      setPage(got.page);
      setTitle(got.page.front.title);
      setSummary(got.page.front.summary);
      setPinned(got.page.front.pinned);
      setBody(got.page.body);
    })();
  }, [homeId, path]);

  const dirty = page !== null
    && (title !== page.front.title || summary !== page.front.summary || pinned !== page.front.pinned || body !== page.body);

  const save = async (): Promise<void> => {
    if (page === null || homeId === null || busy) return;
    const bad = wikiEditError({ title, summary, pinned, sources: page.front.sources });
    if (bad !== null) {
      setError(bad);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await cloudClient.workspaceWikiWrite(homeId, {
      op: "write", path, title, summary, pinned, body, sources: [...page.front.sources],
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    // 标题 / 摘要 / 常驻改了，索引跟着变
    void refreshWiki(homeId);
    navigation.goBack();
  };

  // 「存」挂法照 AgentSettingsScreen：按下去调 ref 里最新的 save；setOptions 只在「按不按得动 / 正在存」变了时重设
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderTextButton label={busy ? "正在存…" : "存"} disabled={!dirty || busy} onPress={() => void saveRef.current()} />
      ),
    });
  }, [navigation, dirty, busy]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      {loadError !== null ? <Note tone="warn">{`读不到这一页：${loadError}`}</Note> : null}
      {page === null && loadError === null ? <Spinner /> : null}
      {page !== null ? (
        <>
          <Labeled label="标题" error={null}>
            <Field value={title} onChangeText={setTitle} placeholder="这一页叫什么" maxLength={WIKI_TITLE_MAX} editable={!busy} />
          </Labeled>
          <Labeled label="摘要" hint="索引里就这一行" error={null}>
            <Field value={summary} onChangeText={setSummary} placeholder="一句话说这一页是什么" maxLength={WIKI_SUMMARY_MAX} editable={!busy} />
          </Labeled>
          <View style={{
            flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 10,
            backgroundColor: c.card, borderRadius: radius.control, borderWidth: 1, borderColor: c.input,
          }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...t.body, color: c.foreground }}>常驻</Text>
              <Text style={{ ...t.footnote, color: c.mutedForeground }}>每一轮都带给所有智能体（常驻页合计有字数上限）</Text>
            </View>
            <Switch value={pinned} onValueChange={setPinned} disabled={busy} />
          </View>
          <Labeled label="正文" hint="用 [[路径]] 链到别的页" error={null}>
            <TextInput
              multiline
              value={body}
              onChangeText={setBody}
              editable={!busy}
              placeholder="这一页记下什么"
              placeholderTextColor={c.mutedForeground}
              textAlignVertical="top"
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                minHeight: 240, borderRadius: radius.control, borderWidth: 1, borderColor: c.input,
                backgroundColor: c.card, color: c.foreground,
                paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontFamily: MONO, fontSize: 14, lineHeight: 20,
              }}
            />
          </Labeled>
          {error !== null ? <Note tone="error">{error}</Note> : null}
        </>
      ) : null}
    </ScrollView>
  );
}
