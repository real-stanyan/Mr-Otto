// 个人信息（#1386，demo 的 profilePage，照微信「我 → 个人信息」）：头像 / 名字 / 邮箱（只看）/ 改密码。
// · 头像：底下升起几样（从相册选一张 / 换回名字的首字）——在几样里挑一样是选择器，走底部；
// · 名字：居中弹窗，存了就生效（朋友和群里的人看到的就是它，profileEdit 收敛空白、限长）；
// · 邮箱：登录用的，这里改不了（改邮箱要走确认信，那是另一件事）；
// · 改密码：居中弹窗；忘了 / 没设过 → 找回密码那一套（8 位验证码）。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { NAME_MAX } from "../../../src/shared/profile.js";
import { sanitizeName } from "../../../src/shared/profileEdit.js";
import { ForgotDialog } from "../gate/ForgotDialog.js";
import { usePalette } from "../theme.js";
import { Group, ListPage, Row } from "../ui.js";
import { ActionSheet } from "../wx/ActionSheet.js";
import { PersonTile } from "../wx/Avatar.js";
import { EditTextDialog } from "../wx/EditTextDialog.js";
import { toast } from "../wx/toast.js";
import { useMyName } from "../tabs/MeScreen.js";
import { PasswordDialog } from "./PasswordDialog.js";
import { pickAvatar } from "./pickAvatar.js";
import { refreshProfile, saveProfile, useProfile } from "./profileStore.js";

type Open = { kind: "avatar" | "name" | "password" | "forgot"; key: number; visible: boolean } | null;

export function ProfileScreen() {
  const { c } = usePalette();
  const me = useMyName();
  const profile = useProfile();
  const [open, setOpen] = useState<Open>(null);
  /** 改密码那张收完之后要不要接着开找回密码那张（两个弹窗不叠着出场） */
  const forgotNext = useRef(false);
  const after = useCallback((next: NonNullable<Open>["kind"] | null) => {
    setOpen(null);
    if (next !== null) setOpen({ kind: next, key: Date.now(), visible: true });
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refreshProfile();
    }, []),
  );
  const show = (kind: NonNullable<Open>["kind"]): void => setOpen({ kind, key: Date.now(), visible: true });
  const hide = (): void => setOpen((o) => (o === null ? o : { ...o, visible: false }));

  const changeAvatar = async (): Promise<void> => {
    try {
      const url = await pickAvatar();
      if (url === null) return;
      await saveProfile({ avatarUrl: url });
      toast("头像换好了");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const resetAvatar = async (): Promise<void> => {
    try {
      await saveProfile({ avatarUrl: "" });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ListPage>
        <Group footer="邮箱是登录用的，这里改不了。名字和头像朋友、群里的人都看得到。">
          <Row
            label="头像"
            minHeight={88}
            trailing={<PersonTile name={me.name} url={me.avatar} size={60} me radius={10} />}
            chevron
            onPress={() => show("avatar")}
          />
          <Row label="名字" value={me.name} chevron onPress={() => show("name")} />
          <Row label="邮箱" value={me.email} />
        </Group>
        <Group>
          <Row label="改密码" chevron onPress={() => show("password")} />
        </Group>
      </ListPage>

      <ActionSheet
        visible={open?.kind === "avatar" && open.visible}
        title="换头像"
        options={[
          { key: "pick", label: "从相册选一张" },
          ...(profile.me?.avatarUrl ? [{ key: "reset", label: "换回名字的首字" }] : []),
        ]}
        onClose={hide}
        onPick={(key) => {
          setOpen(null);
          if (key === "pick") void changeAvatar();
          else if (key === "reset") void resetAvatar();
        }}
      />
      {open?.kind === "name" ? (
        <EditTextDialog
          key={open.key}
          visible={open.visible}
          title="名字"
          lead="朋友和群里的人看到的就是这个名字。"
          initial={me.name}
          placeholder="你的名字"
          maxLength={NAME_MAX}
          check={(v) => (v.trim() !== "" && sanitizeName(v) === "" ? "名字不能是空的" : "")}
          onSave={async (v) => {
            await saveProfile({ name: v });
            hide();
          }}
          onClose={hide}
          onExited={() => after(null)}
        />
      ) : null}
      {open?.kind === "password" ? (
        <PasswordDialog
          key={open.key}
          visible={open.visible}
          email={me.email}
          onClose={hide}
          onForgot={() => {
            forgotNext.current = true;
            hide();
          }}
          onDone={() => {
            hide();
            toast("密码改好了，下次登录用新的");
          }}
          onExited={() => {
            const next = forgotNext.current;
            forgotNext.current = false;
            after(next ? "forgot" : null);
          }}
        />
      ) : null}
      {open?.kind === "forgot" ? (
        // 找回密码那一张（闸门那一套）：人已经登录着，验完码换来的是同一个人的 session，不用按住闸门
        <ForgotDialog
          key={open.key}
          initialEmail={me.email}
          onClose={() => setOpen(null)}
          onHold={async () => undefined}
          onRelease={async () => undefined}
        />
      ) : null}
    </View>
  );
}
