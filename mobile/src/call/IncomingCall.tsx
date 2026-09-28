// 全屏来电页（#1411，spec §3.2）：它的脸（waiting——唯一左右摆的那一档，「等你」）、名字、它要说的那句话、
// 「挂断」「接听」。手机一直震，直到接了、挂了或过了时限。同一时刻只弹一张（队列在 ringStore）。
// 样子照通话整屏（CallOverlay）：深色一屏、两个主题同一个样子。
//
// **不是 Modal，是导航外面的一层浮层**（挂在 RootNavigator 里 ToastHost 的前面）：接听是「原地接通」——这一页
// 不走、改写「正在接通…」，底下把导航换到那条聊天，连上之后通话整屏（CallOverlay，一个 Modal）从下面盖上来，
// 盖住之后才撤掉这一页（ringStore.settleAnswer）。Modal 做不到：iOS 不许在正在退场的 Modal 上再叠一个，
// 而撤掉一个正在 present 别人的 Modal 会连它上面那个一起撤掉。代价：进出场、状态栏字色、读屏焦点
// （accessibilityViewIsModal）要自己管；App 里别的 Modal（底部抽屉之类）开着时这一层在它下面——铃声和震动照样在。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Keyboard, StatusBar, Text, Vibration, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { agentAvatarSlot } from "../../../src/shared/agentAvatarSlot.js";
import type { RingPush } from "../../../src/shared/callRing.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { homeSnapshot } from "../home/homeStore.js";
import { teamsSnapshot } from "../inbox/teamsStore.js";
import { barStyleFor } from "../statusBarStyle.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { FG, FG2, RoundControl, SHELL } from "../voice/CallOverlay.js";
import { FaceTile } from "../wx/Avatar.js";
import { answerRing, declineRing, pruneRings, useRings } from "./ringStore.js";

/** 震的节奏：震一下、停一下（iOS 忽略时长，只认「一震一停」的次数） */
const VIBRATE = [0, 800, 1200];
/** 进场 / 退场：同 RN Modal 的 slide（iOS 抽屉那条曲线） */
const EASE = Easing.bezier(0.32, 0.72, 0, 1);

/** 这通电话所在的工作区快照（画脸要它）。找不到就按 id 派生一张：来电一定要有张脸 */
function wsOf(ring: RingPush): WorkspaceSnapshot | null {
  const home = homeSnapshot().home;
  if (home !== null && home.id === ring.workspaceId) return home;
  const t = teamsSnapshot();
  return t.teams.find((x) => x.ws.id === ring.workspaceId)?.ws ?? t.guests.find((g) => g.ws.id === ring.workspaceId)?.ws ?? null;
}

export function IncomingCall() {
  const { queue, connecting } = useRings();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { isDark } = usePalette();
  const reduce = useReduceMotion();
  const [now, setNow] = useState(() => Date.now());
  const head = connecting ?? queue.find((r) => r.expiresTs > now) ?? null;
  const visible = head !== null;
  // 画的是哪一通：head 没了（挂了 / 过了时限 / 交给了通话整屏）时留着上一通，把退场演完
  const last = useRef<RingPush | null>(null);
  if (head !== null) last.current = head;
  const ring = last.current;
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);
  const y = useRef(new Animated.Value(height)).current;
  const ringingId = connecting === null ? (head?.ringId ?? null) : null;

  // 一秒对一次表：过了时限的清出去（下一通顶上来，或者整页收起）
  useEffect(() => {
    if (queue.length === 0) return;
    const id = setInterval(() => {
      setNow(Date.now());
      pruneRings();
    }, 1_000);
    return () => clearInterval(id);
  }, [queue.length]);

  // 进场 / 退场。退场演完才卸下（mounted），中途又来一通就从当前位置接着往上走
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(y, { toValue: 0, duration: reduce ? 0 : 380, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setEntered(true);
      });
      return;
    }
    setEntered(false);
    Animated.timing(y, { toValue: height, duration: reduce ? 0 : 300, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible]);

  // 不是 Modal：人正在别的聊天里打字时键盘不会自己收，会盖住下面的「挂断 / 接听」（Modal 会把输入框的焦点带走，
  // 这一层不会）——进场就收掉
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  // 深色一屏配浅色字；收起时还给主题的那一种（全 app 只有 statusBarStyle.ts 在管它，这里只是临时借一下）。
  // 时机跟着这一层的上沿走：进场时顶上那一条最后才被盖住，演完再换；退场时它最先让出来，一开始就还
  useEffect(() => {
    if (!visible || !entered) return;
    StatusBar.setBarStyle("light-content", true);
    return () => StatusBar.setBarStyle(barStyleFor(isDark), true);
  }, [visible, entered, isDark]);

  // 一直震，直到接了（接通中不震）、挂了或过了时限
  useEffect(() => {
    if (ringingId === null) return;
    Vibration.vibrate(VIBRATE, true);
    return () => Vibration.cancel();
  }, [ringingId]);

  if (ring === null || (!mounted && !visible)) return null;
  const ws = wsOf(ring);
  const slot = ws !== null ? agentFaceSlot(ws, ring.agentId) : agentAvatarSlot(ring.agentId, []);
  const busy = connecting !== null;
  return (
    <Animated.View
      accessibilityViewIsModal
      style={{
        position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SHELL, transform: [{ translateY: y }],
        paddingTop: insets.top + 56, paddingBottom: insets.bottom + 40, paddingHorizontal: 32,
      }}
    >
      <View style={{ flex: 1, alignItems: "center", gap: 14 }}>
        <FaceTile slot={slot} size={168} radius={46} state="waiting" phase={facePhase(ring.agentId)} />
        <Text numberOfLines={1} style={{ fontSize: 28, fontWeight: "600", color: FG, marginTop: 10 }}>{ring.agentName}</Text>
        <Text style={{ fontSize: 15, color: FG2 }}>{busy ? "正在接通…" : "邀请你语音通话"}</Text>
        <Text numberOfLines={3} style={{ fontSize: 17, lineHeight: 24, color: FG, textAlign: "center", marginTop: 18 }}>{ring.reason}</Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
        <RoundControl icon="phone-off" label="挂断" tone="end" disabled={busy} onPress={() => declineRing(ring)} />
        <RoundControl icon="phone" label="接听" tone="go" disabled={busy} onPress={() => answerRing(ring)} />
      </View>
    </Animated.View>
  );
}
