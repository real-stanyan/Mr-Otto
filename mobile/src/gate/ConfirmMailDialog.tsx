// 注册完、等他去邮箱点确认链接（demo 的 confirmMail，同桌面 ConfirmEmailDialog）。
//
// 我们自己盯着：轮询重试登录——邮箱没确认时 GoTrue 一律回 Email not confirmed，确认之后同一把
// 邮箱密码立刻换得到 session。成功那一刻 App 那层的 onAuthStateChange 把闸门抬起来，这张弹窗
// 跟着卸载，不用他回来按什么。「我已确认」= 立刻探一次。节奏前快后慢（shared/confirmEmailPoll.ts），
// 否则「等确认」自己把账号打进 /token 的限流。密码只活在内存里，不落盘。
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { pollDelayMs } from "../../../src/shared/confirmEmailPoll.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { type as t, usePalette } from "../theme.js";
import { Dot, Strong } from "../ui.js";
import { trySignIn } from "./authActions.js";

export function ConfirmMailDialog({ email, password, onLater }: {
  email: string;
  password: string;
  /** 「稍后再说」：弹窗退场放完才调，调用方在这里把它卸掉。确认成功那条路不走这里——闸门一抬，
      整张卡连同这张弹窗一起卸载 */
  onLater: () => void;
}) {
  const { c } = usePalette();
  const [checking, setChecking] = useState(false);
  /** 手动按过「我已确认」但还没生效。只用来说一句话，不拦他再按——邮件到得慢是常事 */
  const [notYet, setNotYet] = useState(false);
  /** 按了「稍后再说」就先在这里关：Dialog 放完退场（onExited）才轮到 onLater */
  const [open, setOpen] = useState(true);

  // 一次一约的 setTimeout 而不是 setInterval：间隔会变，上一轮还在飞时也不该叠下一轮。
  // 说了「稍后再说」就立刻停，不等退场放完
  useEffect(() => {
    if (!open) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const tick = async (): Promise<void> => {
      if (stop) return;
      await trySignIn(email, password);
      if (stop) return;
      timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    };
    timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [email, password, open]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setNotYet(false);
    const ok = await trySignIn(email, password);
    setChecking(false);
    if (!ok) setNotYet(true);
  };

  return (
    <Dialog visible={open} onExited={onLater}>
      <DialogTitle>去邮箱点一下确认链接</DialogTitle>
      <DialogLead>
        确认信已经发给 <Strong>{email}</Strong>。点开里面的链接，这里会自己继续，不用回来按什么。
      </DialogLead>
      <View style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        marginTop: -4, paddingHorizontal: 20,
      }}>
        {notYet ? null : <Dot tone="busy" />}
        <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>
          {notYet ? "还没生效——邮件可能慢了一点，也看看垃圾箱。" : "正在等你确认…"}
        </Text>
      </View>
      <DialogFooter
        left={{ label: "稍后再说", onPress: () => setOpen(false) }}
        right={{ label: checking ? "查一下…" : "我已确认", onPress: () => void checkNow(), disabled: checking }}
      />
    </Dialog>
  );
}
