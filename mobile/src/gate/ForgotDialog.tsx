// 找回密码（demo 的 forgot / forgotCode / forgotSet，同桌面 ForgotPasswordDialog + SetPasswordDialog）：
// 填邮箱 → 收验证码 → 设新密码，**同一张居中弹窗里原地换三步**（桌面的第三步是另一张弹窗
// 「换在同一位置」，这里就真是同一张）。
//
// 验过验证码那一刻人就是登录态了（recovery OTP 换到真 session），所以验之前先让 App 按住闸门
// （onHold，落 kv-store）；设完新密码或明说「以后再说」才放开（onRelease）——ADR-0194：一个
// 旧密码原封不动的人不该就这么进去。「查无此人也不报错」由服务端守着，所以发完一律进第二步。
//
// 与 demo 的一处不同（spec §10）：第二步的说明去掉「邮件里那条链接点了也算」——手机端没有接
// 那条深链，这句话在手机上是假的。
import { useEffect, useRef, useState } from "react";
import { LayoutAnimation, Pressable, Text, View, type TextInput } from "react-native";
import {
  OTP_LENGTH, RESEND_COOLDOWN_S, canSubmitOtp, resendLabel,
} from "../../../src/shared/forgotPassword.js";
import { MIN_PASSWORD } from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Field, Strong, useReduceMotion } from "../ui.js";
import { NoticeLine } from "./NoticeLine.js";
import { OtpInput } from "./OtpInput.js";
import { errorText, sendReset, setNewPassword, verifyReset } from "./authActions.js";

export type ForgotStage = "email" | "code" | "set";

const TITLE: Record<ForgotStage, string> = { email: "找回密码", code: "填验证码", set: "设一个新密码" };

export function ForgotDialog({ initialEmail, initialStage = "email", onClose, onHold, onRelease }: {
  /** 登录卡里已经填了的那个邮箱。人已经在那一格上打过字了，不该让他再打一遍 */
  initialEmail: string;
  /** 冷启动回来时闸门还按着：直接从「设新密码」那一步开始 */
  initialStage?: ForgotStage;
  /** 「取消」：弹窗退场放完才调，调用方在这里把它卸掉 */
  onClose: () => void;
  /** 验码之前按住闸门（App 那层落盘）；验码失败由 onRelease 放开 */
  onHold: () => Promise<void>;
  /** 设完新密码、或明说「以后再说」：放开闸门，App 自己进 */
  onRelease: () => Promise<void>;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const [stage, setStage] = useState<ForgotStage>(initialStage);
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  /** 重发冷却剩几秒，0 = 解冻。对齐 GoTrue 对同一邮箱的 60 秒限制——点了才被服务端骂一句是坏的 */
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  /** 按了「取消」先在这里关：Dialog 放完退场（onExited）才轮到 onClose */
  const [open, setOpen] = useState(true);
  /** 验码在飞。挡的是「同一批里 onChangeText 连来两次」：两次读到的 busy 都还是渲染那一刻的 false，
      第二次拿已经用掉的码去验必然失败，而失败分支的 onRelease 会把刚按住的闸门放掉 */
  const verifying = useRef(false);
  /** 第一格新密码按「下一项」跳到的那一格 */
  const pw2Ref = useRef<TextInput>(null);

  // 一秒一跳的倒数：setTimeout 链而不是常驻 setInterval——弹窗随时会整棵卸载
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** 换步：弹窗不动、里面换；高度的变化交给 LayoutAnimation，关了动效就瞬切 */
  const go = (next: ForgotStage): void => {
    if (!reduce) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(240, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
      );
    }
    setNotice(null);
    setStage(next);
  };

  const send = async (again: boolean): Promise<void> => {
    const addr = email.trim();
    const bad = localEmailProblem(addr);
    if (bad) return setNotice(authNoticeOf(bad));
    setBusy(true);
    try {
      await sendReset(addr);
      setCode("");
      setCooldown(RESEND_COOLDOWN_S);
      if (!again) go("code");
    } catch (e: unknown) {
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (token: string): Promise<void> => {
    if (verifying.current || busy || token.length !== OTP_LENGTH) return;
    verifying.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // 先按住再验：验过那一刻 session 就来了，晚一步闸门已经抬起来了。按住也写在 try 里：
      // 落盘失败就不验，busy 照样由 finally 放开——写在外面的话，这张锁住的弹窗从此一颗钮都点不动
      await onHold();
      await verifyReset(email.trim(), token);
      go("set");
    } catch (e: unknown) {
      await onRelease();
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  };

  // 同注册那张表单的规矩：够长 + 两次一致，且**空着不念**
  const mismatch = pw2 !== "" && pw !== pw2 ? "两次输入不一样" : null;
  const canSave = !busy && pw.length >= MIN_PASSWORD && pw === pw2;

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await setNewPassword(pw);
      await onRelease();
    } catch (e: unknown) {
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const right =
    stage === "email"
      ? { label: busy ? "稍等…" : "发送验证码", onPress: () => void send(false), disabled: busy || email.trim() === "" }
      : stage === "code"
        ? { label: busy ? "稍等…" : "提交", onPress: () => void verify(code), disabled: !canSubmitOtp(code, busy) }
        : { label: busy ? "保存中…" : "保存", onPress: () => void save(), disabled: !canSave };
  // 第三步左边从「取消」变成「以后再说」：验过之后已经没有东西可取消了——人已经进来了，
  // 逼着设只是又一道收费站（同桌面 SetPasswordDialog）。「以后再说」自己也收起弹窗：这一步若 session
  // 没了（在别处被登出），闸门抬不起来，只放开不关会把人困在这里
  const left =
    stage === "set"
      ? { label: "以后再说", onPress: () => { void onRelease(); setOpen(false); }, disabled: busy }
      : { label: "取消", onPress: () => setOpen(false), disabled: busy };

  return (
    <Dialog visible={open} onExited={onClose}>
      <DialogTitle>{TITLE[stage]}</DialogTitle>
      <DialogLead>
        {stage === "email" ? (
          "填注册时用的邮箱，我们发一个验证码过去。"
        ) : stage === "code" ? (
          <>验证码发到 <Strong>{email.trim()}</Strong> 了，填回来就能设新密码。</>
        ) : (
          "你已经进来了，但旧密码还没变 —— 现在设一个，下次在别的设备上才用得上。"
        )}
      </DialogLead>
      <DialogBody>
        {notice ? <NoticeLine notice={notice} /> : null}

        {stage === "email" ? (
          <Field
            variant="dialog" value={email} onChangeText={setEmail} placeholder="邮箱" autoFocus
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="send"
            onSubmitEditing={() => { if (!right.disabled) right.onPress(); }}
          />
        ) : stage === "code" ? (
          <>
            <OtpInput
              value={code} busy={busy} autoFocus
              // 手机上填满就交：少按一下（Apple 账户的验证码也是这样）
              onChange={(v) => {
                setCode(v);
                if (v.length === OTP_LENGTH) void verify(v);
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
              {/* 倒数写出来：没有理由的灰按钮会被反复去点 */}
              <SmallLink label={resendLabel(cooldown)} disabled={cooldown > 0 || busy} onPress={() => void send(true)} />
              <SmallLink label="换个邮箱" disabled={busy} onPress={() => { setCode(""); go("email"); }} />
            </View>
          </>
        ) : (
          <>
            <Field
              variant="dialog" value={pw} onChangeText={setPw} placeholder={`新密码（至少 ${MIN_PASSWORD} 位）`}
              secure autoFocus autoComplete="new-password" textContentType="newPassword" returnKeyType="next"
              onSubmitEditing={() => pw2Ref.current?.focus()}
            />
            <View>
              <Field
                inputRef={pw2Ref} variant="dialog" value={pw2} onChangeText={setPw2} placeholder="再输一遍" secure
                invalid={mismatch !== null} autoComplete="new-password" textContentType="newPassword"
                returnKeyType="done" onSubmitEditing={() => { if (canSave) void save(); }}
              />
              {mismatch ? (
                <Text style={{ fontSize: 12, lineHeight: 16, color: c.destructive, paddingTop: 6, paddingHorizontal: 2 }}>
                  {mismatch}
                </Text>
              ) : null}
            </View>
          </>
        )}
      </DialogBody>
      <DialogFooter left={left} right={right} />
    </Dialog>
  );
}

/** 验证码底下那两条小字路（demo 的 .gdlg .links：13pt、暗色；冻着时 .6） */
function SmallLink({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ paddingVertical: 4, opacity: disabled ? 0.6 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>{label}</Text>
    </Pressable>
  );
}
