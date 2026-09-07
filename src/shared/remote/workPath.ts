// workPath —— 工作文件夹里那个「路径」的归一化（#1056）。**三端共用一份**，
// 同 wire.ts / validateRepoUrl 的纪律：客户端先归一化省一次明知会被拒的往返，
// 服务端自己再归一化一次（渲染层和主进程都不是安全边界）。
//
// 归一化的结果是一条**相对 /work 的干净路径**，`""` = 工作文件夹本身。
//
// **`..` 一律拒绝，不做「上跳一级」的解释**。解释它意味着两条不同的输入映射到
// 同一个地方，而那个映射里的任何一个差错都是一次容器内越界读；界面上的面包屑
// 本来就是按段拼出来的，它手上永远有目标路径的完整段列表，从不需要 `..`。
// 同理**绝对路径直接拒**而不是「当成相对的」：静默换一套坐标系正好会盖住调用
// 方的 bug。服务端在容器里还有第二道（realpath -m 之后必须仍在 /work 下）——
// 这一份是给人看的判据，那一份是兜底。

/** 路径最多多少段——深到这个份上的目录树，这一页也不是给人翻的正确工具 */
export const WORK_PATH_MAX_SEGMENTS = 32;
/** 整条路径的字节上限 */
export const WORK_PATH_MAX_BYTES = 1024;

/** 归一化成相对 /work 的路径；`""` = 根。`null` = 这条路径不合法，别发出去 */
export function normalizeWorkPath(input: string): string | null {
  if (input.includes("\0")) return null;
  if (input.startsWith("/")) return null;
  if (new TextEncoder().encode(input).length > WORK_PATH_MAX_BYTES) return null;

  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue; // 连续斜杠 / 「当前目录」都是无意义的写法，不是错误
    if (raw === "..") return null;
    segments.push(raw);
  }
  if (segments.length > WORK_PATH_MAX_SEGMENTS) return null;
  return segments.join("/");
}

/** 进入子项：拼一条新路径（不做校验，两端拿到之后各自过一次 normalizeWorkPath） */
export function joinWorkPath(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}
