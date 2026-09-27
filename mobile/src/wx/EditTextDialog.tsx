// 改一格字（#1386，demo 的 editDialog）：居中弹窗——标题、一句说明、一格（单行 / 多行）、「取消 / 保存」。
// 名字、职责、交代、群名、我的名字都走它：存了就生效（demo：改完下一句话就生效），不再有整页表单 +「存」。
// 保存的判据由调用方给（valid）：空、没改、太长时按不动；存失败那句话留在弹窗里，原文不清。
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette, withAlpha } from "../theme.js";
import { Field } from "../ui.js";

export function EditTextDialog({ visible, title, lead, initial, placeholder, maxLength, multiline = false, allowEmpty = false, check, onSave, onClose, onExited }: {
  visible: boolean;
  title: string;
  lead: string;
  initial: string;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  /** 空着也能存（「还有什么要交代的」可以清空） */
  allowEmpty?: boolean;
  /** 这一格此刻的毛病（空串 = 没毛病），一边打一边判 */
  check?: (v: string) => string;
  /** 存。抛出来的那句话画在弹窗里；成功了由调用方关 */
  onSave: (v: string) => Promise<void>;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = check?.(value) ?? "";
  const changed = value.trim() !== initial.trim();
  const ok = !busy && changed && problem === "" && (allowEmpty || value.trim() !== "");
  const save = async (): Promise<void> => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(multiline ? value.trim() : value.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog visible={visible} {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>{title}</DialogTitle>
      <DialogLead>{lead}</DialogLead>
      <DialogBody>
        {multiline ? (
          <TextInput
            multiline
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={c.mutedForeground}
            maxLength={maxLength}
            autoFocus
            textAlignVertical="top"
            editable={!busy}
            style={{
              minHeight: 110, maxHeight: 220, borderRadius: 14, borderWidth: 1, borderColor: problem !== "" ? c.destructive : c.input,
              backgroundColor: withAlpha(c.foreground, 0.05), color: c.foreground, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10,
              fontSize: 16, lineHeight: 23,
            }}
          />
        ) : (
          <Field
            variant="dialog"
            value={value}
            onChangeText={setValue}
            placeholder={placeholder ?? ""}
            maxLength={maxLength}
            autoFocus
            invalid={problem !== ""}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
          />
        )}
        {problem !== "" || error !== null ? (
          <View>
            <Text style={{ fontSize: 13, color: c.destructive, textAlign: "center" }}>{problem !== "" ? problem : error}</Text>
          </View>
        ) : null}
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "正在存…" : "保存", onPress: () => void save(), disabled: !ok }}
      />
    </Dialog>
  );
}
