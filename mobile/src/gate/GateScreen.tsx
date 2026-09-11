// 进门闸（demo 的 signin / signup，同桌面 SignInScreen）：一张脸 + 字标，底下一张玻璃卡。
// 波场背景在 App 那层（开屏与闸门共用同一块，不重启）。进场 260ms：透明度 + 上移 10 +
// 从 .98 放到 1（同桌面 ENTER_MS），不从 0 起；关了动效就只淡入。
// 报错贴在卡的上面：一句人话 + 一步能做的事；认不出来的原文降级成等宽小字（shared/authError.ts）。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, View } from "react-native";
import type { AuthNotice } from "../../../src/shared/authError.js";
import { Page, useKeyboardInset, useReduceMotion } from "../ui.js";
import { ForgotDialog } from "./ForgotDialog.js";
import { NoticeLine } from "./NoticeLine.js";
import { SignInCard } from "./SignInCard.js";
import { Wordmark } from "./Wordmark.js";

export function GateScreen({ resetHold, onHold, onRelease }: {
  /** 闸门此刻被找回密码那条路按着（有 session、新密码还没设）——弹窗要开在「设新密码」那一步 */
  resetHold: boolean;
  onHold: () => Promise<void>;
  onRelease: () => Promise<void>;
}) {
  /** 找回密码那张弹窗开着时带的邮箱；null = 没开 */
  const [forgotEmail, setForgotEmail] = useState<string | null>(null);
  const reduce = useReduceMotion();
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  // 键盘要让位：卡在屏幕正中，「用邮箱登录」就贴在密码框下面
  const { root, keyboard } = useKeyboardInset(() => {});
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1, duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true,
    }).start();
  }, [enter]);
  const motion = reduce ? null : {
    transform: [
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
    ],
  };

  return (
    <View ref={root.ref} onLayout={root.onLayout} style={{ flex: 1, paddingBottom: keyboard }}>
      <Page grow>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Animated.View style={[
            { width: "100%", maxWidth: 320, alignItems: "center", gap: 16, opacity: enter },
            motion,
          ]}>
            {/* 身份就是这两行：一张脸 + 一个名字。它们属于这一屏，不属于登录控件 */}
            <View style={{ alignItems: "center", gap: 8 }}>
              <View style={{
                borderRadius: 16, shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25,
                shadowOffset: { width: 0, height: 25 },
              }}>
                <Image source={require("../../assets/otto.png")} style={{ width: 80, height: 80, borderRadius: 16 }} />
              </View>
              <Wordmark />
            </View>
            {notice ? <NoticeLine notice={notice} /> : null}
            <SignInCard onNotice={setNotice} onForgot={setForgotEmail} />
          </Animated.View>
        </View>
      </Page>
      {/* 两条路打开它：点了「忘记密码？」；或者闸门被按着（冷启动回来、上一次停在「设新密码」）。
          验码成功那一刻两个条件都成立，还是同一个实例——这一步不会被换掉重来 */}
      {forgotEmail !== null || resetHold ? (
        <ForgotDialog
          initialEmail={forgotEmail ?? ""}
          initialStage={forgotEmail === null ? "set" : "email"}
          onClose={() => setForgotEmail(null)}
          onHold={onHold}
          onRelease={onRelease}
        />
      ) : null}
    </View>
  );
}
