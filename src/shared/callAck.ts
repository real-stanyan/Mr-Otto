// callAck —— 通话里主人说完，智能体**想之前**先应一句（#1623）。纯逻辑零 IO。
//
// 为什么是 runtime 替它说、为什么在它想之前：电话里主人说完一段，模型要先想几秒（再去调工具），那几秒电话
// 那头是沉默——主人不知道它听见没有。所以人话一落盘就应一句（不另起模型调用，同 ADR-0332 开场白的思路），
// 从池子里挑、不重复上一句（主人的要求：别每次都一样）。
// 它说的这句落成 assistant_message（ack: true）：日志里有、电话里念、但**不喂回模型**——它不是模型的输出，
// 喂回去模型会以为自己已经答过一句。

/** 口语、短、能被读出来；至少八句才换得出花样 */
export const CALL_ACKS: readonly string[] = [
  "嗯，我听到了，稍等。",
  "好，我想想。",
  "收到，等我一下。",
  "明白，我看看。",
  "行，我这就去弄。",
  "知道了，稍等我一下。",
  "好嘞，我来处理。",
  "嗯嗯，马上。",
];

/** 挑一句：不和上一句一样。`rand` 注入便于测试 */
export function pickCallAck(previous: string | null, rand: () => number = Math.random): string {
  const candidates = previous === null ? CALL_ACKS : CALL_ACKS.filter((s) => s !== previous);
  const i = Math.min(candidates.length - 1, Math.max(0, Math.floor(rand() * candidates.length)));
  return candidates[i]!;
}
