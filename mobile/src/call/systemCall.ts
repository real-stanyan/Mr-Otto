// 系统来电进行中吗（#1428，spec §3「后台不断」）。voiceStore 与 cloudClient 切后台时读它：系统来电期间不停听、
// 不暂停会话房（修订 ADR-0320）；来电结束时如果还在后台，它们各自补做切后台那一步。
// **这个文件不 import 任何东西**：callKit.ts 依赖那两处，那两处再 import callKit.ts 就成环。
let active = false;
const enders: (() => void)[] = [];

export function inSystemCall(): boolean {
  return active;
}

/** 来电结束时要补做的那一步（切后台时被跳过的） */
export function onSystemCallEnded(fn: () => void): void {
  enders.push(fn);
}

export function setInSystemCall(v: boolean): void {
  if (active === v) return;
  active = v;
  if (!v) for (const fn of enders) fn();
}
