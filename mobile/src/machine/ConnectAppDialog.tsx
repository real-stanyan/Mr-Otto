// 接入 / 重新登录那一张居中弹窗（#1430，spec §8；手机表单一律居中弹窗）：它是做什么的 + 以你的身份（重新登录不再说）
// + 要参数 / token 的当场问。按钮字按 auth 分流（「去登录」/「连接」）。
//
// 系统登录页（openAuthSessionAsync）升起时这张弹窗是**完全摊开**的，不叠在一张正在退场的 Modal 上（iOS 那样会什么都不发生）；
// 回来没接上就原样留在这张上：出错写一行，人自己关了浏览器什么都不说。
// 深链只是信号（connectFlow.ts 的 ConnectOutcome）：任何结局都先重拉云端视图，「接上了」只认重拉回来的那一份
// （landedApp）。视图要等下一次渲染才换上新的，所以判定挂在 verify 这一格上、在 effect 里读这一帧的 useConnectors()。
// 关弹窗走 visible → 退场放完 → onExited 再回调：调用方在那里换页 / 弹 toast，不在退场途中叠第二层。
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { CuratedEntry } from "../../../src/shared/mcpCatalog.js";
import { connectDialogText, connectParams, landedApp, paramFormError } from "../../../src/shared/mobileConnectors.js";
import type { CloudViewItem } from "../../../src/shared/remote/pxCloud.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { radius, space, type as t, usePalette } from "../theme.js";
import { Field, Labeled } from "../ui.js";
import { AppTile } from "./AppTile.js";
import { realConnectDeps, runConnect } from "./connectApp.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

export function ConnectAppDialog({ entry, relogin = false, onClose }: {
  entry: CuratedEntry;
  relogin?: boolean;
  /** 退场放完之后调一次。landed = 重拉回来的视图里真接上了的那一台；取消 / 没接上 = null */
  onClose: (landed: CloudViewItem | null) => void;
}) {
  const { c } = usePalette();
  const text = connectDialogText(entry, relogin);
  const cloud = useConnectors();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  /** 流程自称接上了哪一台：等重拉回来的那一帧去对 */
  const [verify, setVerify] = useState<string | null>(null);
  const landed = useRef<CloudViewItem | null>(null);

  useEffect(() => {
    if (verify === null) return;
    landed.current = landedApp(cloud.apps, entry.id, verify);
    setVerify(null);
    setBusy(false);
    setVisible(false);
  }, [verify, cloud.apps, entry.id]);

  const missing = paramFormError(entry, values) !== null;
  const go = async (): Promise<void> => {
    if (busy || missing) return;
    setBusy(true);
    setError(null);
    const r = await runConnect(realConnectDeps, entry.id, connectParams(entry, values));
    await refreshConnectors();
    if (r.kind === "connected") {
      setVerify(r.serverId);
      return;
    }
    setBusy(false);
    if (r.kind === "error") setError(r.message);
  };

  return (
    <Dialog visible={visible} onExited={() => onClose(landed.current)}>
      <View style={{ alignItems: "center", marginBottom: 10 }}>
        <AppTile name={entry.name} />
      </View>
      <DialogTitle>{text.title}</DialogTitle>
      <DialogLead>{text.lead}</DialogLead>
      <DialogBody>
        {text.note !== null ? (
          <View style={{ backgroundColor: c.field, borderRadius: radius.tile, paddingVertical: 9, paddingHorizontal: 11 }}>
            <Text style={{ ...t.footnote, color: c.mutedForeground, lineHeight: 19 }}>{text.note}</Text>
          </View>
        ) : null}
        {entry.params.map((p) => (
          <Labeled key={p.name} label={p.name} hint={p.description} error={null}>
            <Field
              variant="dialog"
              value={values[p.name] ?? ""}
              onChangeText={(v) => {
                setValues((s) => ({ ...s, [p.name]: v }));
                setError(null);
              }}
              placeholder=""
              secure={entry.auth === "token"}
              editable={!busy}
            />
          </Labeled>
        ))}
        {error !== null ? (
          <Text accessibilityRole="alert" style={{ ...t.footnote, color: c.destructive, textAlign: "center", marginTop: space.xs }}>
            {error}
          </Text>
        ) : null}
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: () => setVisible(false), disabled: busy }}
        right={{ label: busy ? "连接中…" : text.action, onPress: () => void go(), disabled: busy || missing }}
      />
    </Dialog>
  );
}
