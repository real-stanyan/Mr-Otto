// 搜索条（#1386，demo 的 .msearch）：没打字时「搜索」两个字和放大镜一起居中，打了字靠左。
// 不是一个单独的搜索页：列表就在下面，边打边滤（本机搜，不打网络）。
import { useState } from "react";
import { TextInput, View } from "react-native";
import { usePalette } from "../theme.js";
import { Icon } from "./Icon.js";

export function SearchBar({ value, onChange, placeholder = "搜索" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { c } = usePalette();
  const [focused, setFocused] = useState(false);
  const centred = !focused && value === "";
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 2, paddingBottom: 10, backgroundColor: c.background }}>
      <View
        style={{
          height: 36, borderRadius: 9, backgroundColor: c.inputBg, flexDirection: "row", alignItems: "center",
          justifyContent: centred ? "center" : "flex-start", paddingHorizontal: 10, gap: 6,
        }}
      >
        <Icon name="search" size={17} color={c.faint} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={c.faint}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel={placeholder}
          style={{ fontSize: 16, color: c.foreground, padding: 0, ...(centred ? {} : { flex: 1 }) }}
        />
      </View>
    </View>
  );
}
