// dist:win 前置（issue #308）：把 napi-rs 系依赖的 win32-x64 binding 包补进 node_modules。
//
// 为什么缺：napi-rs 的原生模块（如 @firecrawl/anydoc）把各平台二进制拆成
// optionalDependencies 平台包，npm install 只装当前平台那个——mac 上装出来的
// node_modules 天生没有 win32 包，交叉打出的 win 安装包在用户机器上启动即崩
// （「Cannot find native binding」，v1.0.1 真机冒烟翻的车）。
//
// 做法：扫 package.json 的直接依赖，凡 optionalDependencies 里带 win32-x64 的，
// 缺哪个就 `npm pack` 拉哪个的 tgz、解进 node_modules。不写 package.json、
// 不动 lockfile——这是打包期的临时补位，不是项目依赖关系的一部分。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 直接依赖里所有 win32-x64 的 napi 平台包：[名字, 版本] */
const wanted = [];
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const depPkgPath = join(root, "node_modules", dep, "package.json");
  if (!existsSync(depPkgPath)) continue;
  const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
  for (const [name, version] of Object.entries(depPkg.optionalDependencies ?? {})) {
    if (name.includes("win32-x64")) wanted.push([name, version]);
  }
}

if (wanted.length === 0) {
  console.log("ensure-win-bindings:没有需要补的 win32-x64 binding");
  process.exit(0);
}

const tmp = join(root, "node_modules", ".win-bindings-tmp");
for (const [name, version] of wanted) {
  const dest = join(root, "node_modules", name);
  if (existsSync(dest)) {
    console.log(`ensure-win-bindings:${name} 已就位`);
    continue;
  }
  console.log(`ensure-win-bindings:补 ${name}@${version}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // npm pack 只下 tgz 不做平台检查；--ignore-scripts 防 tgz 里带 install 钩子
  const out = execFileSync(
    "npm",
    ["pack", `${name}@${version}`, "--ignore-scripts", "--pack-destination", tmp],
    { encoding: "utf8", cwd: root },
  ).trim();
  const tgz = join(tmp, out.split("\n").at(-1));
  execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "inherit" });
  mkdirSync(join(root, "node_modules", name.split("/")[0]), { recursive: true });
  renameSync(join(tmp, "package"), dest);
}
rmSync(tmp, { recursive: true, force: true });
console.log("ensure-win-bindings:完成");
