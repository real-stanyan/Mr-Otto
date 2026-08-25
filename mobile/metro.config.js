// metro 要吃到仓库里那份共享代码,得配两处。两处都是**必须**的,不是优化。

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// 1. 仓库根进 watchFolders:手机端直接 import ../src/shared/remote/ 里的**同一份**
//    文件(帧编解码、握手、密封流)。不加的话 metro 只认 mobile/ 里的东西,
//    那些 import 一律 "Unable to resolve"。
config.watchFolders = [repoRoot];

// mobile/node_modules 优先,再退到仓库根的。两处都要看:expo/react-native 在前者,
// @noble/* 在两处都装(根是 devDependency 给测试用,这里是运行时依赖)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// 2. 把 './x.js' 解析到 './x.ts'。
//
//    仓库按 ESM 的规矩写相对 import 的扩展名(`from "./events.js"`),而磁盘上
//    是 `.ts` —— tsc 与 node 都认这套(module: nodenext),metro 不认:
//    它会照字面去找 events.js,找不到就报 "Unable to resolve"。
//    这一条只对**相对路径**生效,不碰 node_modules 里任何东西。
//    .ts 和 .tsx 都要试:带 JSX 的模块(组件层)只能是 .tsx,而它的 import
//    写出来同样是 './ui.js' —— 只试 .ts 的话组件层永远解析不到。
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const stem = moduleName.slice(0, -3);
    for (const ext of [".ts", ".tsx"]) {
      try {
        return context.resolveRequest(context, stem + ext, platform);
      } catch {
        // 试下一个扩展名;都不中就照原样再走一遍,让 metro 自己报它本来会报的错
        // —— 别把解析失败伪装成"找不到 .ts"
      }
    }
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
