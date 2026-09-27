// 设置（#1356 A5，spec §5.8）：只留有后端的两组——外观（这台手机自己的偏好）与连接诊断（A0 那两行，从账号页挪过来）。
// demo 里的「通话时麦克风常开」「它们的声音」「提醒」「隐私与数据」都没有后端（推送没有凭据那一层、声音 #1372），
// 画出来就是点了不生效的开关（#722），不画。外观是单选清单（iOS 设置的语汇）不是 demo 的分段控件：RN 没有原生分段控件，
// 不为它加依赖。
import { View } from "react-native";
import { THEME_PREFS } from "../../../src/shared/mobileAccount.js";
import { RELAY_BASE } from "../relay.js";
import { space } from "../theme.js";
import { setThemePref, useThemePref } from "../themePref.js";
import { Group, Page, Row } from "../ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function SettingsScreen() {
  const pref = useThemePref();
  return (
    <Page>
      <View style={{ gap: space.lg }}>
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
      </View>
    </Page>
  );
}
