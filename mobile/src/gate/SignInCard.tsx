// 登录 / 注册那张玻璃卡（demo 的 .glasscard，同桌面 SignInCard）。登录与注册是**同一张卡的两个
// 状态**，不是两页：注册态原地长出「用户名」「再输一遍」两格，按钮与底下那行换说法——两者除了
// 多两格一模一样，换一页等于让人把整张表重读一遍。
//
// 自上而下三段：邮箱密码 → OAuth → 离开这张表单的两条路。三段共用一圈边，段间 16、段内 8，
// 分组全靠这个比值读出来。邮箱在前、OAuth 在后是维护者定的（#731）。
import { useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import {
  MIN_PASSWORD, NAME_MAX, canSubmitSignIn, confirmHint, type SignInMode,
} from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "../oauth.js";
import { radius, usePalette, withAlpha } from "../theme.js";
import { Button, Field, useReduceMotion } from "../ui.js";
import { GitHubMark, GoogleMark } from "./marks.js";
import { errorText, signInWithPassword, signUp } from "./authActions.js";
import { ConfirmMailDialog } from "./ConfirmMailDialog.js";

export function SignInCard({ onNotice, onForgot }: {
  onNotice: (n: AuthNotice | null) => void;
  /** 点「忘记密码？」：带上已经填了的邮箱——人已经在那一格上打过字了 */
  onForgot: (email: string) => void;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const [mode, setMode] = useState<SignInMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | OAuthProvider | null>(null);
  /** 注册成功、正在等确认信。存的是那一刻的邮箱密码——弹窗要拿它轮询；只活在内存里 */
  const [pending, setPending] = useState<{ email: string; password: string } | null>(null);

  const form = { mode, name, email, password, confirm, busy: busy !== null };
  const canSubmit = canSubmitSignIn(form);
  const mismatch = confirmHint(form);
  const up = mode === "sign-up";

  /** 换态：清掉只有注册才有的两格（同桌面切换那三行）。两格原地长出来 / 收回去，
      高度的变化交给 LayoutAnimation；关了动效就瞬切 */
  const switchMode = (next: SignInMode): void => {
    if (!reduce) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(280, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
      );
    }
    setMode(next);
    setName("");
    setConfirm("");
    onNotice(null);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    // 本地预检：形状一眼不对就别跑这趟网络；报文与 supabase 那句同文，翻出来是同一条
    const addr = email.trim();
    const bad = localEmailProblem(addr);
    if (bad) return onNotice(authNoticeOf(bad));
    onNotice(null);
    setBusy("password");
    try {
      if (!up) {
        await signInWithPassword(addr, password);
      } else if ((await signUp(addr, password, name)) === "confirm-email") {
        setPending({ email: addr, password });
      }
      // 登录成功 / 注册即登录：App 那层的 onAuthStateChange 会把闸门抬起来，这张卡跟着卸载
    } catch (e: unknown) {
      onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const oauth = async (provider: OAuthProvider): Promise<void> => {
    onNotice(null);
    setBusy(provider);
    try {
      await signInWithProvider(provider);
    } catch (e: unknown) {
      // 取消不是故障，不报红
      if (!(e instanceof AuthCancelled)) onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    // 阴影在外层、裁切在内层：iOS 上 overflow:hidden 会连阴影一起裁掉
    <View style={{
      width: "100%", borderRadius: radius.card,
      shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
    }}>
      <View style={{
        borderRadius: radius.card, overflow: "hidden", borderWidth: 1, borderColor: c.border,
        backgroundColor: withAlpha(c.card, 0.85), padding: 12, gap: 16,
      }}>
        {/* 不透一点、不糊一层的话，卡是「贴」在波场上而不是「坐」在里面 */}
        <BlurView tint="systemMaterial" intensity={60} style={StyleSheet.absoluteFill} />

        {/* 一：邮箱密码。用户名排在邮箱上面——它问的是「你叫什么」，邮箱密码是「怎么进来」 */}
        <View style={{ gap: 8 }}>
          {up ? (
            <Field
              variant="gate" value={name} onChangeText={setName} placeholder="用户名"
              maxLength={NAME_MAX} autoComplete="nickname" textContentType="nickname" returnKeyType="next"
            />
          ) : null}
          <Field
            variant="gate" value={email} onChangeText={setEmail} placeholder="邮箱"
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next"
          />
          <Field
            variant="gate" value={password} onChangeText={setPassword}
            placeholder={up ? `密码（至少 ${MIN_PASSWORD} 位）` : "密码"} secure
            autoComplete={up ? "new-password" : "current-password"}
            textContentType={up ? "newPassword" : "password"}
            returnKeyType={up ? "next" : "go"}
            onSubmitEditing={up ? undefined : () => void submit()}
          />
          {up ? (
            <View>
              <Field
                variant="gate" value={confirm} onChangeText={setConfirm} placeholder="再输一遍密码" secure
                invalid={mismatch !== null} autoComplete="new-password" textContentType="newPassword"
                returnKeyType="go" onSubmitEditing={() => void submit()}
              />
              {/* 贴着那一格念：这是边打字边改的问题，提示要待在他正在看的地方；
                  空着不念（confirmHint 只在打了字之后才说）——空着就红，那是催促不是提示 */}
              {mismatch ? (
                <Text style={{ fontSize: 12, lineHeight: 16, color: c.destructive, paddingTop: 6, paddingHorizontal: 2 }}>
                  {mismatch}
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* 对不上就按不动，而不是按了报错：密码看不见，按之前就该知道 */}
          <Button
            size="compact" label={busy === "password" ? "…" : up ? "注册" : "用邮箱登录"}
            disabled={!canSubmit} onPress={() => void submit()}
          />
        </View>

        {/* 二：OAuth。注册态照样在：拿 Google 头一次进来就是注册 */}
        <View style={{ gap: 8 }}>
          <Button
            size="compact" variant="outline" icon={<GoogleMark />}
            label={busy === "google" ? "登录中…" : "用 Google 登录"}
            disabled={busy !== null} onPress={() => void oauth("google")}
          />
          <Button
            size="compact" variant="outline" icon={<GitHubMark />}
            label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
            disabled={busy !== null} onPress={() => void oauth("github")}
          />
        </View>

        {/* 三：两条离开这张表单的路，一行两端分开摆。左边「我进不去了」，
            右边「我还没有账号」——右边照样靠右，左边先留一个空位撑住 */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          {/* 注册态没有这条（那一屏还不存在「旧密码」这回事），但它占着位置，右边那条照样靠右 */}
          <GateLink label="忘记密码？" hidden={up} onPress={() => onForgot(email.trim())} />
          <GateLink
            label={up ? "已有账号？登录" : "没有账号？注册"}
            onPress={() => switchMode(up ? "sign-in" : "sign-up")}
          />
        </View>
      </View>

      {pending ? (
        <ConfirmMailDialog
          email={pending.email}
          password={pending.password}
          onLater={() => {
            setPending(null);
            switchMode("sign-in");
          }}
        />
      ) : null}
    </View>
  );
}

/** 卡底下那两条小字路（demo 的 .gatelink：12pt、暗色、无边框）。hidden = 占着位置但看不见、点不动 */
export function GateLink({ label, onPress, hidden }: { label: string; onPress: () => void; hidden?: boolean }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button" accessibilityElementsHidden={hidden} disabled={hidden}
      onPress={onPress} hitSlop={10}
      style={({ pressed }) => ({ opacity: hidden ? 0 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, color: c.mutedForeground }}>{label}</Text>
    </Pressable>
  );
}
