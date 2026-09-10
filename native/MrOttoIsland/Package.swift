// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MrOttoIsland",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/MrKai77/DynamicNotchKit", branch: "main"),
  ],
  targets: [
    .executableTarget(
      name: "MrOttoIsland",
      dependencies: [.product(name: "DynamicNotchKit", package: "DynamicNotchKit")],
      // otto.png:compact 态与展开态顶栏的 logo(#201)。厂商 logo 那一批随
      // 用量表一起删了(#1229——那张表是 BYOK 时代的产物)。
      // .copy 原样进资源 bundle;bundle 必须跟二进制同目录(dev 的 .build/
      // 自动如此,打包由 afterPack 拷)
      resources: [.copy("Resources/otto.png")]
    ),
    .testTarget(name: "MrOttoIslandTests", dependencies: ["MrOttoIsland"]),
  ]
)
