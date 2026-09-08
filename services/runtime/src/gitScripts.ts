// 三把 Git 刀在容器里跑的那几段脚本，以及它们输出的解析（#1105）。
//
// 与 `workFiles.ts` 同一个分工：这个文件**一个 docker 的字都不碰**，所以真正
// 会坏的那三件事（字段顺序 / 分隔符 / 退出码怎么带回来）进得了单测。
//
// **脚本里的转义序列一律走 `String.raw`**（同 workFiles.ts 文件头那条）：普通
// 模板串里的 `\0` 会变成一个真的 NUL 字节，而 execve 的参数在 NUL 处截断——
// 两处都不报错，单测因为不看脚本字节而全绿（#1056 真踩过）。

/** 单引号包裹 + `'\''` 转义——同 sandbox.ts / workFiles.ts / dockerWorld.ts
    那几份。各写一遍是有意的：合并要跨 services/runtime 与 src/ 的边界 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 探一格目标目录：里面有几个条目、`origin` 指哪儿。**只读**，一个字节都不动。

    `entries` 数的是**包含隐藏文件**的条目数（`.git` 也算）——一个只有 `.git`
    的目录不是空的，往里 clone 会失败得莫名其妙。 */
export function buildCloneProbeScript(dest: string): string {
  return [
    `d=${shellQuote(dest)}`,
    String.raw`target="/work/$d"`,
    // realpath 兜底：一条指向 /etc 的软链过得了客户端那道路径闸（同 workFiles）
    String.raw`real=$(realpath -m -- "$target" 2>/dev/null) || real=""`,
    String.raw`case "$real" in /work|/work/*) ;; *) echo "denied"; exit 0;; esac`,
    String.raw`if [ ! -e "$real" ]; then echo "entries=0"; echo "origin="; exit 0; fi`,
    String.raw`if [ ! -d "$real" ]; then echo "notdir"; exit 0; fi`,
    String.raw`n=$(ls -A -- "$real" 2>/dev/null | wc -l | tr -d ' ')`,
    String.raw`echo "entries=$n"`,
    String.raw`git config --global --add safe.directory "$real" >/dev/null 2>&1 || true`,
    String.raw`o=$(git -C "$real" remote get-url origin 2>/dev/null) || o=""`,
    String.raw`echo "origin=$o"`,
  ].join("\n");
}

export type CloneProbe =
  | { kind: "ok"; entries: number; origin: string }
  | { kind: "denied" }
  | { kind: "notdir" }
  | { kind: "unparsable"; detail: string };

/** 探测输出 → 结构。**认不出来单列一档**，不退化成「空目录」——后者会让下一步
    直接往一个我们没看懂的地方 clone（同 ADR-0200 决策③「探测失败 → refused，
    绝不退化成没克隆完去清空」的同一条纪律）。 */
export function parseCloneProbe(stdout: string): CloneProbe {
  const text = stdout.trim();
  if (text === "denied") return { kind: "denied" };
  if (text === "notdir") return { kind: "notdir" };
  const entriesLine = /^entries=(\d+)$/m.exec(text);
  const originLine = /^origin=(.*)$/m.exec(text);
  if (!entriesLine || !originLine) return { kind: "unparsable", detail: text.slice(0, 200) };
  return { kind: "ok", entries: Number(entriesLine[1]), origin: (originLine[1] ?? "").trim() };
}

/** 远端默认分支。`git ls-remote --symref origin HEAD` 回两行，第一行形如
    `ref: refs/heads/main\tHEAD`。**这一步要凭据**，所以跟 clone 一样跑在旁路
    容器里。 */
export function buildDefaultBranchScript(dest: string): string {
  return [
    `d=${shellQuote(dest)}`,
    String.raw`real=$(realpath -m -- "/work/$d" 2>/dev/null) || real=""`,
    String.raw`case "$real" in /work/*) ;; *) echo "denied"; exit 0;; esac`,
    String.raw`git config --global --add safe.directory "$real" >/dev/null 2>&1 || true`,
    String.raw`git -C "$real" ls-remote --symref origin HEAD 2>/dev/null | head -n 1`,
  ].join("\n");
}

/** `ref: refs/heads/main\tHEAD` → `main`。**认不出来回 null**，而 null 在
    `pushesDefaultBranch` 里一律当成「是默认分支」= 拒绝（ADR-0243 的纪律：
    没有任何输入能让这一轮比它开始时更松）。 */
export function parseDefaultBranch(stdout: string): string | null {
  const m = /^ref:\s+refs\/heads\/(\S+)\s/m.exec(stdout);
  return m?.[1] ?? null;
}

/** 提交并推。`author` 形如 `名字 <uid@users.noreply.mrotto.app>`。

    **没有 `--force`，也没有 `--force-with-lease`**：后者听着安全，但它仍然是
    「用我的历史覆盖远端」。远端已有同名分支且不是快进时 push 自己会失败，
    错误原文照实带回去。 */
export function buildPushScript(args: {
  dest: string;
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
}): string {
  return [
    `d=${shellQuote(args.dest)}`,
    `b=${shellQuote(args.branch)}`,
    `m=${shellQuote(args.message)}`,
    `an=${shellQuote(args.authorName)}`,
    `ae=${shellQuote(args.authorEmail)}`,
    String.raw`real=$(realpath -m -- "/work/$d" 2>/dev/null) || real=""`,
    String.raw`case "$real" in /work/*) ;; *) echo "denied"; exit 1;; esac`,
    String.raw`git config --global --add safe.directory "$real" >/dev/null 2>&1 || true`,
    String.raw`cd "$real" || { echo "no such dir"; exit 1; }`,
    // 分支：已存在就切过去，否则从当前 HEAD 开一条
    String.raw`git checkout -B "$b" >/dev/null 2>&1 || { echo "checkout failed"; exit 1; }`,
    String.raw`git add -A`,
    // 没有改动不是失败——分支还不存在时照样要把当前 HEAD 推上去建这条分支
    String.raw`if git diff --cached --quiet; then echo "nothing-to-commit"; else`,
    String.raw`  git -c user.name="$an" -c user.email="$ae" commit -m "$m" >/dev/null 2>&1 || { echo "commit failed"; exit 1; }`,
    String.raw`  echo "committed"`,
    String.raw`fi`,
    String.raw`git push origin "$b" 2>&1 || exit 1`,
    String.raw`echo "pushed"`,
  ].join("\n");
}

/** push 脚本的输出 → 结局。`pushed` 那一行是唯一的成功凭据——**不看退出码**：
    退出码只说「最后一条命令回了 0」，而这段脚本里最后一条是 `echo`。 */
export function parsePushOutput(stdout: string): { pushed: boolean; committed: boolean; detail: string } {
  const text = stdout.trim();
  return {
    pushed: /^pushed$/m.test(text),
    committed: /^committed$/m.test(text),
    detail: text.slice(0, 2000),
  };
}
