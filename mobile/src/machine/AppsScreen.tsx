// 应用（#1430，spec §8；原 #1356 A5 只列电脑上接的）：上段「手机上接的」（第一行固定是 Apple 健康，#1671；其余是
// edge 的云端连接器，GET /px/v1/cloud），
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
import { HEALTH_APP_NAME, healthAppRow, healthConnectedToast, showPhoneAppsEmpty } from "../../../src/shared/mobileHealthApp.js";
import { appRows } from "../../../src/shared/mobileMachine.js";
import { HealthConnectDialog } from "../health/HealthConnectDialog.js";
import { useHealthAppState } from "../health/healthPrefs.js";
import { HealthTile } from "../health/HealthTile.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { toast } from "../wx/toast.js";
import { Button, Group, Inset, ListPage, Note, Row } from "../ui.js";
import { AppTile } from "./AppTile.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";
import { refreshApps, useApps } from "../apps/appsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "Apps">;

/** 行首带 40pt 方块的那几组：分隔线从方块右边开始（16 + 40 + 12） */
const TILE_INSET = 68;

export function AppsScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const cloud = useConnectors();
  // 我的应用（#1591）：管理员派应用专员做的小应用；进这一页 / 回到这一页时拉一次
  const mine = useApps();
  /** 正在重新登录的那一台（目录条目 id） */
  const [relogin, setRelogin] = useState<string | null>(null);
  const health = useHealthAppState();
  const healthRow = healthAppRow(health);
  const [connectingHealth, setConnectingHealth] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
      void refreshConnectors();
      void refreshApps();
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
        {mine.error !== null ? <Inset><Note tone="warn">{mine.error}</Note></Inset> : null}
        {mine.apps !== null && mine.apps.length > 0 ? (
          <Group header="我的应用" footer="管理员派应用专员做的小应用，点开就能用；要改就跟管理员说一句。" inset={TILE_INSET}>
            {mine.apps.map((a) => (
              <Row
                key={a.id}
                leading={<View style={{ width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.06) }}><Text style={{ fontSize: 22 }}>{a.icon}</Text></View>}
                label={a.name}
                detail={a.description === "" ? `v${a.currentVersion}` : a.description}
                chevron
                onPress={() => navigation.navigate("MiniApp", { appId: a.id })}
              />
            ))}
          </Group>
        ) : null}
        {cloud.loadError !== null ? <Inset><Note tone="warn">{cloud.loadError}</Note></Inset> : null}
        {phone !== null && showPhoneAppsEmpty({ healthAvailable: health !== "unavailable", cloudApps: phone.length }) ? (
          <View style={{ paddingTop: 36, paddingHorizontal: 32, paddingBottom: 8, alignItems: "center", gap: 14 }}>
            <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", lineHeight: 24 }}>{PHONE_APPS_EMPTY}</Text>
            <Button size="auto" label="接入应用" onPress={() => navigation.navigate("ConnectApp")} />
          </View>
        ) : (
          <Group header="手机上接的" footer={PHONE_APPS_FOOTER} inset={TILE_INSET}>
            {/* Apple 健康（#1671，demo 方向 B）：固定第一行，没连时也在；云端清单还没拉下来时它照样画（它不靠那份清单） */}
            <Row
              leading={<HealthTile dim={healthRow.action === null} />}
              label={HEALTH_APP_NAME}
              detail={healthRow.detail}
              {...(healthRow.action === "connect"
                ? { trailing: <Button size="sm" label="连接" onPress={() => setConnectingHealth(true)} />, onPress: () => setConnectingHealth(true) }
                : healthRow.action === "detail"
                  ? { chevron: true, onPress: () => navigation.navigate("HealthDetail") }
                  : { disabled: true })}
            />
            {(phone ?? []).map((r) => (
              <Row
                key={r.serverId}
                leading={<AppTile name={r.title} icon={r.icon} />}
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
              <Row key={r.key} leading={<AppTile name={r.title} icon={r.icon} />} label={r.title} detail={r.detail} />
            ))}
          </Group>
        ) : null}
      </View>
      {connectingHealth ? (
        <HealthConnectDialog
          onClose={(connected) => {
            setConnectingHealth(false);
            if (connected) toast(healthConnectedToast);
          }}
        />
      ) : null}
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
