// scripts/make-ringtone.mjs 的类型面（#1411）：同 deploy-stamp.d.mts——脚本是普通 node ESM（不进 tsc），
// 被单测 import 才要这一份。手写的，.mjs 那侧改了签名这里不会自动红，只有调用点会。
export declare const RATE: number;
export declare const CYCLE_S: number;
export declare const CYCLES: number;
export declare function ringtoneSamples(rate?: number): Float32Array;
export declare function wavBytes(samples: Float32Array, rate?: number): Buffer;
