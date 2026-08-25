// swift-tools-version: 5.9
import PackageDescription

// MrOttoSimInput —— iOS 模拟器的输入/无障碍通道（issue #401）。
// 主进程 spawn 它，stdin/stdout 走 NDJSON（对照 MrOttoIsland 的桥）。
// 单独一个包而不是给 MrOttoIsland 加 target：岛依赖 DynamicNotchKit，
// 这个一个第三方依赖都不要——两者的构建面不该互相牵连。
let package = Package(
  name: "MrOttoSimInput",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "MrOttoSimInput"),
    .testTarget(name: "MrOttoSimInputTests", dependencies: ["MrOttoSimInput"]),
  ]
)
