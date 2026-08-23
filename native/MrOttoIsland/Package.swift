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
      dependencies: [.product(name: "DynamicNotchKit", package: "DynamicNotchKit")]
    ),
    .testTarget(name: "MrOttoIslandTests", dependencies: ["MrOttoIsland"]),
  ]
)
