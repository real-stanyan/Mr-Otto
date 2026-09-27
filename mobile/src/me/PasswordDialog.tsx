// 改密码（#1386，demo 的 passwordDialog）：居中弹窗——现在的、新的、再输一遍；一边输一边说哪里不对
// （shared/profileEdit 的 passwordProblem：够不够长 → 两次一不一样 → 和现在的是不是同一个），全对了「保存」才按得动。
//
// 「现在的密码」对不对：拿它 signInWithPassword 一次（换来的是同一个人的新 session，别的都不变）；不对就说
// 「现在的密码不对」，不往下改。用 Google / GitHub 注册的账号压根没有密码——那一句 GoTrue 与「密码不对」
// 是同一句话，所以底下那行「没设过、或忘了？用邮箱验证码重设」两种都接住：走闸门那一套找回密码
// （8 位验证码，ADR-0194），这台手机上人已经登录着，不用按住闸门。
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { authNoticeOf } from "../../../src/shared/authError.js";
import { passwordProblem, passwordReady } from "../../../src/shared/profileEdit.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { Field } from "../ui.js";

export function PasswordDialog({ visible, email, onClose, onForgot, onDone, onExited }: {
  visible: boolean;
  email: string;
  onClose: () => void;
  /** 「用邮箱验证码重设」：调用方收起这一张、换成找回密码那一张 */
  onForgot: () => void;
  onDone: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(cur, next, again);
  const ready = passwordReady(cur, next, again) && !busy;

  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const check = await supabase.auth.signInWithPassword({ email, password: cur });
      if (check.error) {
        const n = authNoticeOf(check.error.message);
        setError(/invalid login credentials/i.test(check.error.message) ? "现在的密码不对（用 Google / GitHub 注册的账号没有密码，走下面那行）" : n.title);
        setBusy(false);
        return;
      }
      const { error: e } = await supabase.auth.updateUser({ password: next });
      if (e) {
        setError(authNoticeOf(e.message).title);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const line = error ?? (problem !== "" ? problem : "");
  return (
    <Dialog visible={visible} {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>改密码</DialogTitle>
      <DialogLead>新密码下次登录就用它。</DialogLead>
      <DialogBody>
        <Field variant="dialog" secure value={cur} onChangeText={setCur} placeholder="现在的密码" autoComplete="current-password" textContentType="password" editable={!busy} />
        <Field variant="dialog" secure value={next} onChangeText={setNext} placeholder="新密码" autoComplete="new-password" textContentType="newPassword" editable={!busy} />
        <Field variant="dialog" secure value={again} onChangeText={setAgain} placeholder="再输一遍新密码" autoComplete="new-password" textContentType="newPassword" editable={!busy} />
        <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, minHeight: 18, color: c.destructive, textAlign: "center" }}>{line}</Text>
        <View style={{ alignItems: "center" }}>
          <Pressable accessibilityRole="button" hitSlop={8} disabled={busy} onPress={onForgot} style={({ pressed }) => [pressed && { opacity: 0.5 }]}>
            <Text style={{ fontSize: 14, color: c.brand }}>没设过、或忘了？用邮箱验证码重设</Text>
          </Pressable>
        </View>
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "正在改…" : "保存", onPress: () => void save(), disabled: !ready }}
      />
    </Dialog>
  );
}
