// 设置（#1356 A5；#1386 换成微信式通栏，退出登录从账号页挪到这里——demo 同款）：外观（这台手机自己的偏好）、
// 连接诊断（中继 + 版本）、退出登录。demo 里「有人 @ 我时通知」「智能体回话时通知」两行不画：手机没有推送凭据那一层
// （ADR-0256 的已知代价），画出来就是点了不生效的开关（#722）。
// 外观是单选清单（iOS 设置的语汇）不是分段控件：RN 没有原生分段控件，不为它加依赖。
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import { ACCOUNT_FOOTER, THEME_PREFS } from "../../../src/shared/mobileAccount.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { NoticeLine } from "../gate/NoticeLine.js";
import { unregisterPush } from "../push/pushRegistration.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";
import { setThemePref, useThemePref } from "../themePref.js";
import { Group, Inset, ListPage, Row } from "../ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function SettingsScreen() {
  const navigation = useNavigation();
  const pref = useThemePref();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住。登出会失败：断网而 access token 又过期时，supabase 刷新不了
  // session，就原样留着本地那份、也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生（A0 原话）
  const signOut = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      // 先注销这台的推送令牌（#1411）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网也照样退出
      await unregisterPush();
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
