// 文件（#1356 A5，spec §5.8）：它们那台电脑上的工作文件夹（/work，ADR-0251）。一次只列一层（files 帧，ADR-0253），
// 点目录压一页、点文件压一页预览；最外层那一页上面一条搜索框（按名找；`?` 开头按内容找，桌面同一个约定）。
// **读不到 ≠ 空**：出错时上一份清单留在原地，错误另起一行（ADR-0243 那一族）。文件下不到手机上（组尾说清）。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import {
  FILES_FOOTER, FILES_SEARCH_PLACEHOLDER, baseName, workEntryRows, workFolderText, workFolderTruncated, workHitRows,
} from "../../../src/shared/mobileMachine.js";
import type { CsWorkHit, CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import { parseFileQuery } from "../../../src/shared/workFilesView.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space } from "../theme.js";
import { Button, Field, Group, Hint, Note, Page, Row, Spinner, useNow } from "../ui.js";

type Props = NativeStackScreenProps<RootStackParams, "Files">;

export function FilesScreen({ route, navigation }: Props) {
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const now = useNow(60_000);
  const [node, setNode] = useState<CsWorkNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CsWorkHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: path === "" ? "文件" : baseName(path) });
  }, [navigation, path]);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, path);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setError(null);
    setNode(r.value);
  }, [homeId, path]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 搜索只在最外层那一页（files_search 本来就搜整个文件夹）。去抖 250ms；空的 = 回到清单
  const q = path === "" ? parseFileQuery(query) : null;
  const term = q?.term ?? null;
  const content = q?.content ?? false;
  useEffect(() => {
    if (term === null || homeId === null) {
      setHits(null);
      setSearchNote(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const r = await cloudClient.workspaceFilesSearch(homeId, term, content);
        setSearching(false);
        if (r.ok) {
          setHits(r.value);
          setSearchNote(null);
          return;
        }
        // 降级要说出来：不说的话空结果读起来就是「那台电脑上没有」（桌面同一条）
        setHits([]);
        setSearchNote(r.message);
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [term, content, homeId]);

  if (homeId === null) {
    return <Page><Hint>还没有智能体，也就还没有这台电脑。</Hint></Page>;
  }

  const openDir = (p: string): void => navigation.push("Files", { path: p });
  const openFile = (p: string): void => navigation.push("FilePreview", { path: p });
  const notice = node === null ? null : workFolderText(node);
  const truncated = node === null ? null : workFolderTruncated(node);
  const rows = node !== null && node.kind === "dir" ? workEntryRows(path, node.entries, now) : [];

  return (
    <Page>
      <View style={{ gap: space.md }}>
        {path === "" ? (
          <Field value={query} onChangeText={setQuery} placeholder={FILES_SEARCH_PLACEHOLDER} returnKeyType="search" />
        ) : null}
        {hits !== null ? (
          <View style={{ gap: space.sm }}>
            {searchNote !== null ? <Note tone="warn">{searchNote}</Note> : null}
            {hits.length === 0 && searchNote === null && !searching ? (
              <Hint>{`没有找到「${(term ?? "").trim()}」`}</Hint>
            ) : null}
            {hits.length > 0 ? (
              <Group>
                {workHitRows(hits).map((h) => (
                  <Row key={h.key} leading={<RowGlyph name={h.icon} />} label={h.title} detail={h.detail} chevron onPress={() => openFile(h.path)} />
                ))}
              </Group>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: space.sm }}>
            {error !== null ? (
              <View style={{ gap: space.sm }}>
                <Note tone="warn">{node === null ? `读不到这个文件夹：${error}` : `这一刻读不到（${error}），下面是上一次的。`}</Note>
                <View style={{ alignItems: "flex-start" }}>
                  <Button size="auto" variant="outline" label="重试" onPress={() => void load()} />
                </View>
              </View>
            ) : null}
            {node === null && error === null ? <Spinner /> : null}
            {notice !== null ? <Hint>{notice}</Hint> : null}
            {rows.length > 0 ? (
              <Group {...(truncated === null ? {} : { footer: truncated })}>
                {rows.map((r) => (
                  <Row
                    key={r.key}
                    leading={<RowGlyph name={r.icon} />}
                    label={r.name}
                    {...(r.meta === "" ? {} : { detail: r.meta })}
                    {...(r.opens === null ? {} : { chevron: true, onPress: () => (r.opens === "dir" ? openDir(r.path) : openFile(r.path)) })}
                  />
                ))}
              </Group>
            ) : null}
            {path === "" ? <Hint>{FILES_FOOTER}</Hint> : null}
          </View>
        )}
      </View>
    </Page>
  );
}
