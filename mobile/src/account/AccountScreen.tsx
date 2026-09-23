// 账号页（A0 精简版，#1356）。完整的账号页——额度两扇窗、订阅、这周用了多少、它们共用的一台
// 电脑、设置——在 A5（spec §5.8）。原来的「好友」「配对的电脑」「记录与用量」随投影一起删了
// （spec §11 第 2 条）：那些数要电脑在线才算得出，而这个 App 从此不连自己的电脑。
//
// 形状是 iOS 的分组列表：邮箱与退出登录都属于账号，但退出登录单独一组、居中、红字——
// 破坏性动作不跟只读信息同一块板。
import { useEffect, useState } from "react";
import { View } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";
import { space } from "../theme.js";
import { Group, Page, Row } from "../ui.js";
import { NoticeLine } from "../gate/NoticeLine.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function AccountScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住，这一屏不用管。
  // 但登出会失败：断网而 access token 又过期时，supabase 刷新不了 session，就原样留着本地那份、
  // 也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生
  const [signOutNotice, setSignOutNotice] = useState<AuthNotice | null>(null);
  const signOut = (): void => {
    void (async () => {
      setBusy(true);
      setSignOutNotice(null);
      try {
        const { error } = await supabase.auth.signOut();
        if (error) setSignOutNotice(authNoticeOf(error.message));
      } catch (e: unknown) {
        setSignOutNotice(authNoticeOf(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Group header="账号">
          <Row label="邮箱" value={email ?? "读取中…"} />
        </Group>

        <Group>
          <Row
            label={busy ? "退出中…" : "退出登录"}
            align="center" tone="destructive"
            disabled={busy} onPress={signOut}
          />
        </Group>
        {signOutNotice ? <NoticeLine notice={signOutNotice} /> : null}

        {/* 纯诊断信息——不做成按钮，长按能选中拷走就够了 */}
        <Group header="连接" footer="出问题时把这两行长按拷下来一起发过来。">
          <Row label="中继" value={RELAY_BASE} mono />
          <Row label="版本" value={appJson.expo.version} mono />
        </Group>
      </View>
    </Page>
  );
}
