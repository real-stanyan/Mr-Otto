// 测试用的一次性目录。
//
// 起因：全仓十五个测试文件各自 mkdtempSync 建目录、谁都不删，每跑一次门禁
// 就在 /tmp 下留十几个 otter-* 目录（issue #141）。逐个补 afterEach 也行，
// 但那要求每个新写的测试都记得补——记不住的规矩迟早失效。
//
// 所以清理挂在 setupFiles 上（vitest.config.ts）：每个测试文件跑完，
// 这一份里登记过的目录一起删。建目录的地方只要改一个函数名就行，
// 不用关心什么时候删、删几次。
//
// 只删自己建的：路径来自 mkdtempSync 的返回值，不是拼出来的——
// rm -rf 一个拼错的路径是不可逆的。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** 建一个一次性目录，测试文件跑完自动删。prefix 只为了在 /tmp 里认得出来 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** setupFiles 调。force：目录可能已经被测试自己删过了 */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
