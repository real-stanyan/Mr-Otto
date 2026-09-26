// **必须在任何要用 crypto.getRandomValues 的代码之前执行。** index.ts 第一行就 import 它。
//
// 原来是给配对那条 @noble/* 铺路的,配对功能连同 @noble/* 已经随 #1356 一起删了。
// 留着这个 polyfill 是因为 supabase-js 的 PKCE 流程也要 crypto.getRandomValues,
// 而 Hermes 没有 `globalThis.crypto` —— 虚拟机上第一次跑就崩在这儿:
// `Error: crypto.getRandomValues must be defined`。它要一个真 CSPRNG,熵这一件事
// 永远要向系统要,不是纯 JS 算法补得出来的。
//
// 用 expo-crypto 而不是 react-native-get-random-values:前者是 Expo 模块,
// Expo Go 里就有,不需要 prebuild —— 这条正是 ADR-0101 要保住的性质。

import * as ExpoCrypto from "expo-crypto";

type MutableCrypto = { getRandomValues?: <T extends ArrayBufferView>(a: T) => T };

const g = globalThis as unknown as { crypto?: MutableCrypto };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = ((a: ArrayBufferView) =>
    ExpoCrypto.getRandomValues(a as never)) as MutableCrypto["getRandomValues"];
}
