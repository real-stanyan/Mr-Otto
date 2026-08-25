// **必须在任何 @noble/* 之前执行。** index.ts 第一行就 import 它。
//
// 虚拟机上第一次跑就崩在这儿:`Error: crypto.getRandomValues must be defined`。
// noble 的算法是纯 JS,但随机数不能是 —— 它要一个真 CSPRNG,而 Hermes 没有
// `globalThis.crypto`。ADR-0101 说"不需要 native module"指的是**算法**那部分;
// 熵这一件事永远要向系统要。
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
