// 设置（#1356 A5；#1386 换成微信式通栏，退出登录从账号页挪到这里——demo 同款）：消息通知（#1442）、隐私（已读回执）、
// 外观（这台手机自己的偏好）、连接诊断（中继 + 版本）、退出登录。
// 通知那几个开关存在账号上（notify_prefs），runtime 推之前读它；读不到时整段不画（画成「全开」就是撒谎，#722）。
// 系统层面没允许通知时开关照画，但底下说清「这里开着也收不到」——那一格只有人自己去系统设置里改得了。
// 外观是单选清单（iOS 设置的语汇）不是分段控件：RN 没有原生分段控件，不为它加依赖。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { useCallback, useState } from "react";
import { Linking, Switch } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import { ACCOUNT_FOOTER, THEME_PREFS } from "../../../src/shared/mobileAccount.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { NoticeLine } from "../gate/NoticeLine.js";
import { goOffline } from "../friends/presenceStore.js";
import { healthAvailable, setHealthEnabled, useHealthEnabled } from "../health/healthPrefs.js";
import { loadNotify, setPref, useNotify } from "../push/notifyStore.js";
import { unregisterPush } from "../push/pushRegistration.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";
import { setThemePref, useThemePref } from "../themePref.js";
import { Group, Inset, ListPage, Note, Row } from "../ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function SettingsScreen() {
  const navigation = useNavigation();
  const pref = useThemePref();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const notify = useNotify();
  const healthOn = useHealthEnabled();
  const [healthError, setHealthError] = useState<string | null>(null);
  const toggleHealth = (v: boolean): void => {
    setHealthError(null);
    void setHealthEnabled(v).catch((e: unknown) => setHealthError(e instanceof Error ? e.message : String(e)));
  };
  /** 系统层面允没允许通知。null = 还没问到 */
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      void loadNotify().catch(() => undefined);
      void Notifications.getPermissionsAsync()
        .then((p) => setAllowed(p.status !== "denied"))
        .catch(() => setAllowed(null));
    }, []),
  );
  const prefs = notify.prefs;
  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <Row label={label} trailing={<Switch value={value} onValueChange={onChange} accessibilityLabel={label} />} />
  );

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住。登出会失败：断网而 access token 又过期时，supabase 刷新不了
  // session，就原样留着本地那份、也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生（A0 原话）
  const signOut = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      // 先注销这台的推送令牌（#1411）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网也照样退出
      await unregisterPush();
      // 好友那边当场变红（#1460），不等心跳过期
      await goOffline();
      // 只登出这台手机：supabase 缺省是 global，会把电脑上的 Mr Otto 一起登出（spec §10 第 88 条）
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) setNotice(authNoticeOf(error.message));
      else setConfirm(false);
    } catch (e: unknown) {
      setNotice(authNoticeOf(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ListPage>
      {prefs !== null ? (
        <Group
          header="消息通知"
          footer={
            allowed === false
              ? "系统设置里没有允许 Otto 发通知，这里开着也收不到。"
              : "关掉之后这一类不再推到你的手机。单个聊天的「消息免打扰」在聊天信息里设。"
          }
        >
          {toggle("智能体回答", prefs.agentReply, (v) => void setPref({ agentReply: v }))}
          {toggle("有人 @ 我", prefs.mentions, (v) => void setPref({ mentions: v }))}
          {toggle("朋友消息", prefs.friends, (v) => void setPref({ friends: v }))}
          {allowed === false ? <Row label="去系统设置打开通知" chevron onPress={() => void Linking.openSettings()} /> : null}
        </Group>
      ) : null}
      <Group header="免打扰与汇报" footer="免打扰期间手机不推消息，朋友的消息和代办由管理员替你收着；到你设的时间它打电话或发消息汇报。">
        <Row label="免打扰时段 · 管理员汇报" chevron onPress={() => navigation.navigate("QuietHours")} />
      </Group>
      {prefs !== null ? (
        <Group header="隐私" footer="关掉之后，朋友看不到你有没有读他的消息。">
          {toggle("已读回执", prefs.readReceipts, (v) => void setPref({ readReceipts: v }))}
        </Group>
      ) : null}
      {notify.error !== null ? <Inset><Note tone="error">{notify.error}</Note></Inset> : null}
      <Group
        header="Apple 健康"
        footer={
          healthAvailable()
            ? "打开后，你问智能体健康相关的问题时，它会从这台手机读取步数、睡眠、心率、体重和体能训练（按天汇总）。只在 Otto 开着时能读。哪几类能读，在 iOS「健康」App → 共享 → App → Otto 里改。"
            : "这台设备读不了健康数据。"
        }
      >
        {healthAvailable() ? toggle("允许智能体读取", healthOn, toggleHealth) : null}
      </Group>
      {healthError !== null ? <Inset><Note tone="error">{healthError}</Note></Inset> : null}
      <Group header="外观" footer="只改这台手机。跟随系统时，系统切深浅色它也跟着切。">
        {THEME_PREFS.map((p) => (
          <Row key={p.key} label={p.label} checked={pref === p.key} onPress={() => void setThemePref(p.key)} />
        ))}
      </Group>
      {/* 纯诊断信息——不做成按钮，长按能选中拷走就够了（A0 的那一组，原样搬过来） */}
      <Group header="连接" footer="出问题时把这两行长按拷下来一起发过来。">
        <Row label="中继" value={RELAY_BASE} mono />
        <Row label="版本" value={appJson.expo.version} mono />
      </Group>
      {/* 形象陈列馆只在开发构建里有（dev/FaceGallery.tsx 头注）；入口原来在名册右上，名册换成聊天列表之后挪到这里 */}
      {__DEV__ ? (
        <Group header="开发">
          <Row label="形象陈列馆" chevron onPress={() => navigation.navigate("FaceGallery")} />
        </Group>
      ) : null}
      <Group footer={ACCOUNT_FOOTER}>
        <Row label="退出登录" align="center" tone="destructive" onPress={() => setConfirm(true)} />
      </Group>
      {notice !== null ? <Inset><NoticeLine notice={notice} /></Inset> : null}

      <Dialog visible={confirm}>
        <DialogTitle>退出登录？</DialogTitle>
        <DialogLead>只退出这台手机。智能体和聊天记录都在云上，下次登录还在。</DialogLead>
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirm(false), disabled: busy }}
          right={{ label: busy ? "正在退出…" : "退出", onPress: () => void signOut(), disabled: busy, tone: "destructive" }}
        />
      </Dialog>
    </ListPage>
  );
}
