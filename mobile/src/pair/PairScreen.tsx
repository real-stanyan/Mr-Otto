// 扫码配对 / 6 位安全码配对。从 App.tsx 原样拆出来（#1237 M0），逻辑一个字没动。

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { View } from "react-native";
import type { PinnedPeerStore, RemotePeer } from "../../../src/shared/remote/devices.js";
import { decodePairingOffer } from "../../../src/shared/remote/pairing.js";
import { armPairing, devices } from "../session.js";
import { myLabel } from "../deviceLabel.js";
import { usePalette, radius, space } from "../theme.js";
import { Button, Card, CodeTiles, Headline, Hint, Note, Page, Spinner, Title, Warn } from "../ui.js";
import { useNavigation } from "@react-navigation/native";
import { useLink } from "../link.js";

/* ── 配对 ───────────────────────────────────────────────
   这一屏真正要人做的只有一件事:把这里的 6 位数和电脑上那个比一遍。
   账号目录不是信任来源(ADR-0095):公钥从 Supabase 下发,掌握库的人能发一把假的。
   对上了才 pin —— 所以文案必须把"对不上就别配"说在按钮前面。
   数字拆成一格一格,因为它的唯一用途是**逐位比对**。 */
/**
 * 扫码配对(issue #583)。**这一屏的主动作** —— 人只在这儿动一次,电脑那边不用
 * 再确认第二遍。二维码里有电脑的身份公钥(直接读到,中间人换不掉)和一把一次性
 * secret(下一轮握手拿它签个持有证明,电脑据此认得这台手机)。
 *
 * 扫到别的码一律**不猜**:decodePairingOffer 回 null 就只是提示一句,继续扫。
 */
function ScanPair({
  store, onDone, onCancel,
}: { store: PinnedPeerStore; onDone: () => void; onCancel: () => void }) {
  const { c } = usePalette();
  const [perm, requestPerm] = useCameraPermissions();
  const [err, setErr] = useState<string | null>(null);
  /** 相机会对着同一张码连着回调几十次。认下第一次就够,后面的全丢 */
  const done = useRef(false);

  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain) void requestPerm();
  }, [perm, requestPerm]);

  const onScan = (data: string): void => {
    if (done.current) return;
    const scanned = decodePairingOffer(data);
    if (!scanned) {
      setErr("这不是 Mr Otto 的配对码。对准电脑「设置 → 手机」里那张。");
      return;
    }
    done.current = true;
    // 顺序:先 pin 电脑的公钥(这一下就是"我认得这台电脑了"),再把 secret 存起来
    // 让下一轮握手带上证明。反过来的话,证明发出去了而本地还不认它的回复
    store.pinPeer(scanned.identityPub);
    armPairing(scanned.secret);
    onDone();
  };

  if (!perm) return <Page><Spinner /></Page>;

  if (!perm.granted) {
    return (
      <Page>
        <Card>
          <Headline>要用一下相机</Headline>
          <Hint>
            只在扫这张配对码时用,扫完就不再开。
            {perm.canAskAgain ? "" : "系统设置 → Mr Otto → 相机 里打开。"}
          </Hint>
          {perm.canAskAgain ? (
            <Button label="允许使用相机" onPress={() => void requestPerm()} />
          ) : null}
          <Button label="改用 6 位安全码" variant="plain" onPress={onCancel} />
        </Card>
      </Page>
    );
  }

  return (
    <Page grow>
      <Hint>对准电脑「设置 → 手机」里那张二维码。</Hint>
      {err ? <Note tone="error">{err}</Note> : null}
      <View
        style={{
          flex: 1, minHeight: 280, borderRadius: radius.card,
          overflow: "hidden", backgroundColor: c.muted,
        }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => onScan(data)}
        />
      </View>
      <Button label="扫不了,改用 6 位安全码" variant="plain" onPress={onCancel} />
    </Page>
  );
}

export function Pair({ store, onPaired }: { store: PinnedPeerStore; onPaired: () => void }) {
  const [peers, setPeers] = useState<RemotePeer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 默认就是扫码 —— 主路径不该藏在一个按钮后面。6 位码是退到这一屏才看得见的降级路径 */
  const [scanning, setScanning] = useState(true);
  const api = devices(store);

  const refresh = useCallback(() => {
    void (async () => {
      setErr(null);
      await api.registerSelf(myLabel());
      setPeers(await api.listPeers());
    })().catch((e: unknown) => setErr(String(e)));
    // api 每次 render 新建一个,不进依赖 —— 它没有状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(refresh, [refresh]);

  const pin = async (deviceId: string): Promise<void> => {
    setBusy(deviceId);
    const ok = await api.pin(deviceId);
    setBusy(null);
    if (ok) onPaired();
    else setErr("这台电脑的公钥不合法,没有配对");
  };

  if (scanning) {
    return <ScanPair store={store} onDone={onPaired} onCancel={() => setScanning(false)} />;
  }

  return (
    <Page>
      <View style={{ gap: space.xs }}>
        <Hint>
          下面的 6 位数会同时显示在电脑的「设置 → 手机」里。
          <Warn>对不上就不要配</Warn>——那说明中间有人换掉了公钥。
          这条路要在电脑上<Warn>再按一次</Warn>确认;扫码不用。
        </Hint>
      </View>
      {err ? <Note tone="error">{err}</Note> : null}
      {peers === null ? (
        <Spinner />
      ) : peers.length === 0 ? (
        <Card>
          <Headline>还没有电脑登记</Headline>
          <Hint>在电脑上打开「设置 → 手机」,这里下拉刷新就能看到它。</Hint>
        </Card>
      ) : (
        peers.map((p) => (
          <Card key={p.deviceId} style={{ gap: space.md }}>
            <Headline>{p.label || p.deviceId}</Headline>
            <CodeTiles code={p.code} />
            <Button
              label={busy === p.deviceId ? "配对中…" : p.pinned ? "重新配对" : "安全码一致，配对"}
              disabled={busy === p.deviceId}
              onPress={() => void pin(p.deviceId)}
            />
          </Card>
        ))
      )}
      <Button label="刷新" variant="plain" onPress={refresh} />
      <Button label="改回扫码" variant="plain" onPress={() => setScanning(true)} />
    </Page>
  );
}

/** 根栈里的配对页。标题「配对电脑」是原生导航栏画的;配成之后回到来的地方,
    项目栏按 pairEpoch 重建连接(新握手要带上刚扫到的那把 secret) */
export function PairScreen() {
  const navigation = useNavigation();
  const { store, bumpPair } = useLink();
  return (
    <Pair
      store={store}
      onPaired={() => {
        bumpPair();
        navigation.goBack();
      }}
    />
  );
}

