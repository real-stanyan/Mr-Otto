// 8 位验证码（Supabase 的 mailer_otp_length = 8，见 shared/forgotPassword.ts），4 + 4 两组：
// 从邮件里读 8 个数字再敲进来，中间断一下比一口气数 8 格好认（demo 的 .otp）。
//
// 底下是**一个**真输入框（数字键盘 + oneTimeCode：iOS 会把邮件里那串数字直接递上来），
// 铺满整排；格子只是它的画法（shared/forgotPassword.ts 的 otpCells）——粘贴、系统递码、
// 退格全走那一个框。光标停在第一个空格上，那一格的边换点缀色。
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { OTP_LENGTH, normalizeOtp, otpCells } from "../../../src/shared/forgotPassword.js";
import { MONO, radius, usePalette, withAlpha } from "../theme.js";

export function OtpInput({ value, onChange, busy, autoFocus }: {
  value: string;
  onChange: (code: string) => void;
  busy: boolean;
  autoFocus?: boolean;
}) {
  const { c } = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <View style={{ flexDirection: "row", gap: 5 }}>
        {otpCells(value).map((cell, i) => (
          <View
            key={i}
            style={{
              flex: 1, height: 42, borderRadius: radius.tile, borderWidth: 1,
              borderColor: focused && cell.cursor ? c.brand : c.input,
              backgroundColor: withAlpha(c.foreground, 0.05),
              alignItems: "center", justifyContent: "center",
              // 4 + 4 之间多一口气
              marginLeft: i === OTP_LENGTH / 2 ? 7 : 0,
              opacity: busy ? 0.45 : 1,
            }}
          >
            <Text style={{ fontFamily: MONO, fontSize: 20, fontWeight: "600", color: c.foreground }}>{cell.ch}</Text>
          </View>
        ))}
      </View>
      <TextInput
        value={value}
        // 粘进来的整句在这里就擦干净（只留数字、截到 8 位），而不是等到提交那一刻报「码不对」。
        // **不设 maxLength**：它在擦之前先截，「验证码：12345678」整句粘进来只剩「验证码：1234」
        onChangeText={(text) => onChange(normalizeOtp(text))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        editable={!busy}
        caretHidden
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={`${OTP_LENGTH} 位验证码`}
        // 铺满整排、几乎全透明。不写 0：UIKit 不把触摸派给 alpha < 0.01 的视图，
        // 那样点格子就对不上这个框了
        style={[StyleSheet.absoluteFill, { opacity: 0.02, color: "transparent" }]}
      />
    </View>
  );
}
