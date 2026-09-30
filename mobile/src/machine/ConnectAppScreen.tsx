// 接入应用（#1430，spec §8）：搜索 + 按分类分组的目录（只列能在云端跑的，connectCatalog）。点一行弹居中弹窗；
// 已接的行尾写「已接入」、点进详情；实测接不上的那几条第二行写原因、按不动。
// 接上之后这一页换成详情页（返回直接回应用列表），toast 说一句——判据是重拉回来的视图（ConnectAppDialog 的 landed）。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { MCP_CATALOG } from "../../../src/shared/mcpCatalog.js";
import { CATALOG_FOOTER, CONNECTED_MARK, catalogEmpty, connectCatalog, connectedToast } from "../../../src/shared/mobileConnectors.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { Field, Group, Inset, ListPage, Note, Row } from "../ui.js";
import { AppTile } from "./AppTile.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "ConnectApp">;

export function ConnectAppScreen({ navigation }: Props) {
  const { c } = usePalette();
  const cloud = useConnectors();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const groups = useMemo(() => connectCatalog(cloud.apps, q), [cloud.apps, q]);
  const entry = picked === null ? null : MCP_CATALOG.find((e) => e.id === picked) ?? null;
  // 「已接入」那一格跟着云端视图走：从外面切回来时拉一次新的
  useFocusEffect(
    useCallback(() => {
      void refreshConnectors();
    }, []),
  );
  const serverIdOf = (catalogId: string): string | null => cloud.apps?.find((a) => a.catalogId === catalogId)?.serverId ?? null;

  const side = { ...t.footnote, color: c.mutedForeground, paddingHorizontal: space.md, lineHeight: 19 };
  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        <Inset>
          <Field value={q} onChangeText={setQ} placeholder="搜应用" returnKeyType="search" />
        </Inset>
        {cloud.loadError !== null ? <Inset><Note tone="warn">{cloud.loadError}</Note></Inset> : null}
        {groups.length === 0 ? (
          <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", lineHeight: 24, paddingTop: 36, paddingHorizontal: 32 }}>
            {catalogEmpty(q.trim())}
          </Text>
        ) : (
          <>
            {groups.map((g) => (
              <Group key={g.category} header={g.category} inset={68}>
                {g.items.map((i) => {
                  const blocked = i.blocked !== null && !i.connected;
                  return (
                    <Row
                      key={i.id}
                      leading={<AppTile name={i.name} />}
                      label={i.name}
                      detail={i.blocked !== null && !i.connected ? i.blocked : i.description}
                      {...(i.connected
                        ? { trailing: <Text style={{ ...t.footnote, fontSize: 14, color: c.faint }}>{CONNECTED_MARK}</Text> }
                        : {})}
                      disabled={blocked}
                      onPress={() => {
                        const serverId = i.connected ? serverIdOf(i.id) : null;
                        if (serverId !== null) navigation.navigate("AppDetail", { serverId });
                        else if (!blocked) setPicked(i.id);
                      }}
                    />
                  );
                })}
              </Group>
            ))}
            <Text style={[side, { paddingTop: 6 }]}>{CATALOG_FOOTER}</Text>
          </>
        )}
      </View>
      {entry !== null ? (
        <ConnectAppDialog
          entry={entry}
          onClose={(landed) => {
            setPicked(null);
            if (landed === null) return;
            toast(connectedToast(entry.name));
            navigation.replace("AppDetail", { serverId: landed.serverId });
          }}
        />
      ) : null}
    </ListPage>
  );
}
