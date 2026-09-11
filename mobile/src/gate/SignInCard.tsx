// 登录那张玻璃卡（demo 的 .glasscard，同桌面 SignInCard 的 glass 档）。自上而下三段：
// 邮箱密码 → OAuth → 离开这张表单的两条路（Task 7 / 8 加上）。三段共用一圈边，
// 段间 16、段内 8——分组全靠这个比值读出来。邮箱在前、OAuth 在后是维护者定的（#731）。
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { canSubmitSignIn } from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "../oauth.js";
import { radius, usePalette, withAlpha } from "../theme.js";
import { Button, Field } from "../ui.js";
import { GitHubMark, GoogleMark } from "./marks.js";
import { errorText, signInWithPassword } from "./authActions.js";

export function SignInCard({ onNotice }: { onNotice: (n: AuthNotice | null) => void }) {
  const { c } = usePalette();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | OAuthProvider | null>(null);
  const canSubmit = canSubmitSignIn({
    mode: "sign-in", name: "", email, password, confirm: "", busy: busy !== null,
  });

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    // 本地预检：形状一眼不对就别跑这趟网络；报文与 supabase 那句同文，翻出来是同一条
    const bad = localEmailProblem(email.trim());
    if (bad) return onNotice(authNoticeOf(bad));
    onNotice(null);
    setBusy("password");
    try {
      await signInWithPassword(email.trim(), password);
      // 成功不用做别的：App 那层的 onAuthStateChange 会把闸门抬起来，这张卡跟着卸载
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
        <View style={{ gap: 8 }}>
          <Field
            variant="gate" value={email} onChangeText={setEmail} placeholder="邮箱"
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next"
          />
          <Field
            variant="gate" value={password} onChangeText={setPassword} placeholder="密码" secure
            autoComplete="current-password" textContentType="password" returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />
          <Button
            size="compact" label={busy === "password" ? "…" : "用邮箱登录"}
            disabled={!canSubmit} onPress={() => void submit()}
          />
        </View>
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
      </View>
    </View>
  );
}
