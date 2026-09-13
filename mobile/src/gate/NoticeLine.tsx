// 进门那几处报错的同一种画法：一句人话 + 一步能做的事，认不出来的原文降级成等宽小字
// （shared/authError.ts 的 AuthNotice）。闸门上一处、找回密码弹窗里一处——判据与画法只能有一份。
import { View } from "react-native";
import type { AuthNotice } from "../../../src/shared/authError.js";
import { Meta, Note } from "../ui.js";

export function NoticeLine({ notice }: { notice: AuthNotice }) {
  return (
    <View style={{ width: "100%", gap: 4 }}>
      <Note tone="error">{notice.hint ? `${notice.title} —— ${notice.hint}` : notice.title}</Note>
      {notice.raw ? <Meta>{notice.raw}</Meta> : null}
    </View>
  );
}
