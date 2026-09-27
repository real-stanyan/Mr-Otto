// 一个文件（#1356 A5）：只读，开头 64 KB（files 帧的上限，ADR-0251），等宽、可以长按选中拷走；二进制 / 截断 / 空文件
// 各说一句（shared 的 workFileText）。按名搜出来的可能是个文件夹——那就把这一页换成文件夹那一页。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { baseName, workFileText } from "../../../src/shared/mobileMachine.js";
import type { CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { MONO, space, usePalette } from "../theme.js";
import { Button, Card, Hint, Note, Spinner } from "../ui.js";

type Props = NativeStackScreenProps<RootStackParams, "FilePreview">;

export function FilePreviewScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const [node, setNode] = useState<CsWorkNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: baseName(path) });
  }, [navigation, path]);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, path);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (r.value.kind === "dir") {
      navigation.replace("Files", { path });
      return;
    }
    setError(null);
    setNode(r.value);
  }, [homeId, path, navigation]);
  useEffect(() => {
    void load();
  }, [load]);

  const notice = node === null ? null : workFileText(node);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
    >
      {error !== null ? (
        <View style={{ gap: space.sm }}>
          <Note tone="warn">{`读不到这个文件：${error}`}</Note>
          <View style={{ alignItems: "flex-start" }}>
            <Button size="auto" variant="outline" label="重试" onPress={() => void load()} />
          </View>
        </View>
      ) : null}
      {node === null && error === null ? <Spinner /> : null}
      {node !== null && node.kind === "file" && node.text !== "" ? (
        <Card>
          <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: c.foreground }}>{node.text}</Text>
        </Card>
      ) : null}
      {notice !== null ? <Hint>{notice}</Hint> : null}
    </ScrollView>
  );
}
