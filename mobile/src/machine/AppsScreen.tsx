// 应用（#1430，spec §8；原 #1356 A5 只列电脑上接的）：上段「手机上接的」（edge 的云端连接器，GET /px/v1/cloud），
// 下段「电脑上接的」（主场快照的 connectors，只读——那几台连没连上只活在桌面进程里，手机问不出来）。
// 右上「接入」进目录。过期的那一行点一下直接弹「重新登录」，不先进详情页（demo 定稿）。
// **读不到 ≠ 空**：清单没拉下来时上一份照画，错误另起一行；还没拉到过就什么都不说（不许先说「还没接」）。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { Text, View } from "react-native";
import { MCP_CATALOG } from "../../../src/shared/mcpCatalog.js";
import {
  DESKTOP_APPS_FOOTER, PHONE_APPS_EMPTY, PHONE_APPS_FOOTER, phoneAppRows, reloginToast,
} from "../../../src/shared/mobileConnectors.js";
import { appRows } from "../../../src/shared/mobileMachine.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { Button, Group, Inset, ListPage, Note, Row } from "../ui.js";
import { AppTile } from "./AppTile.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "Apps">;

/** 行首带 40pt 方块的那几组：分隔线从方块右边开始（16 + 40 + 12） */
const TILE_INSET = 68;

export function AppsScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const cloud = useConnectors();
  /** 正在重新登录的那一台（目录条目 id） */
  const [relogin, setRelogin] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
      void refreshConnectors();
    }, []),
  );
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <HeaderTextButton label="接入" disabled={false} onPress={() => navigation.navigate("ConnectApp")} />,
    });
  }, [navigation]);

  const homeId = home.home?.id ?? null;
  const phone = cloud.apps === null ? null : phoneAppRows(cloud.apps, homeId);
  const desktop = home.home ? appRows(home.home) : [];
  const catalogIdOf = (serverId: string): string | null => cloud.apps?.find((a) => a.serverId === serverId)?.catalogId ?? null;
  const reloginEntry = relogin === null ? null : MCP_CATALOG.find((e) => e.id === relogin) ?? null;

  const openRow = (serverId: string, needsLogin: boolean): void => {
    const catalogId = catalogIdOf(serverId);
    // 目录里已经没有这个条目（下架了）：没有表单可弹，进详情页让人断开
    if (needsLogin && catalogId !== null && MCP_CATALOG.some((e) => e.id === catalogId)) setRelogin(catalogId);
    else navigation.navigate("AppDetail", { serverId });
  };

  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        {cloud.loadError !== null ? <Inset><Note tone="warn">{cloud.loadError}</Note></Inset> : null}
        {phone === null ? null : phone.length === 0 ? (
          <View style={{ paddingTop: 36, paddingHorizontal: 32, paddingBottom: 8, alignItems: "center", gap: 14 }}>
            <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", lineHeight: 24 }}>{PHONE_APPS_EMPTY}</Text>
            <Button size="auto" label="接入应用" onPress={() => navigation.navigate("ConnectApp")} />
          </View>
        ) : (
          <Group header="手机上接的" footer={PHONE_APPS_FOOTER} inset={TILE_INSET}>
            {phone.map((r) => (
              <Row
                key={r.serverId}
                leading={<AppTile name={r.title} />}
                label={r.title}
                detail={r.detail}
                {...(r.trailing !== null
                  ? { trailing: <Text style={{ ...t.footnote, fontSize: 14, color: c.warn }}>{r.trailing}</Text> }
                  : { chevron: true })}
                onPress={() => openRow(r.serverId, r.needsLogin)}
              />
            ))}
          </Group>
        )}
        {desktop.length > 0 ? (
          <Group header="电脑上接的" footer={DESKTOP_APPS_FOOTER} inset={TILE_INSET}>
            {desktop.map((r) => (
              <Row key={r.key} leading={<AppTile name={r.title} />} label={r.title} detail={r.detail} />
            ))}
          </Group>
        ) : null}
      </View>
      {reloginEntry !== null ? (
        <ConnectAppDialog
          entry={reloginEntry}
          relogin
          onClose={(landed) => {
            setRelogin(null);
            if (landed !== null) toast(reloginToast(reloginEntry.name));
          }}
        />
      ) : null}
    </ListPage>
  );
}
