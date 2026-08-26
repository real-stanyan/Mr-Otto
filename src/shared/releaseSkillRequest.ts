// releaseSkill IPC 请求的形状把关 —— 从 main/index.ts 的 ipcMain handler 里
// 抽出来做纯函数,好处只有一个但很关键:main/index.ts 顶层有 app.whenReady /
// app.setAsDefaultProtocolClient 这类副作用,vitest 直接 import 那个文件会在
// 非 Electron 运行时里跑这些调用而炸——tests/main/ 里至今没有任何测试真的
// import 过它(renameSession / archiveSession / importSkills 那几个结构相同
// 的 handler 也一样零覆盖,靠 e2e 兜底)。把"坏请求零痕迹"这条不变量单独摘
// 出来,才不用为了测一段十行的把关逻辑去给 main/index.ts 造一套 import
// harness——那是给自己挖坑,不是修复。
//
// 用户是老大:这里不做来源校验(模型自己 release 的来源校验在
// src/tools/skill.ts,跟这条 IPC 路径无关)。

/** 校验不过直接抛,抛的文案跟 handler 原来 inline 的一致(用户可能看到,不能改)。
    顺序即优先级:形状先于会话是否存在——同 handleSendMessage 的规矩,形状把关
    先于任何 append,判断谁先说话不影响结果但影响报错文案,固定下来才不会漂移。
    只查类型,不额外拒空串:现有 handler 从来没做过这层校验,这里如实照抄现状,
    不偷偷收紧语义(收紧是另一条 issue 的事) */
export function validateReleaseSkillRequest(name: unknown, sessionExists: boolean): asserts name is string {
  if (typeof name !== "string") throw new Error("skill 名字形状非法(应为字符串)");
  if (!sessionExists) throw new Error("会话不存在");
}
