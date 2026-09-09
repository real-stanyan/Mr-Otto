// swift-tools-version: 5.9
import PackageDescription

// MrOttoSpeech —— 群语音里「人说话」那一半（#1176，ADR-0273）：macOS 原生本机语音识别
// （SFSpeechRecognizer + AVAudioEngine），主进程 spawn 它，stdin/stdout 走 NDJSON
// （对照 MrOttoSimInput / MrOttoIsland 的桥）。单独一个包：一个第三方依赖都不要。
//
// Info.plist 用 -sectcreate 嵌进二进制：麦克风与语音识别的 TCC 授权要求进程自带
// NSMicrophoneUsageDescription / NSSpeechRecognitionUsageDescription，而 helper 是个
// 裸二进制、没有 .app 壳——嵌进 __TEXT,__info_plist 是 CLI 工具过 TCC 的标准做法。
// unsafeFlags 只在根包允许，这个包永远不会被当依赖用。
let package = Package(
  name: "MrOttoSpeech",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "MrOttoSpeech",
      exclude: ["Info.plist"],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate",
          "-Xlinker", "__TEXT",
          "-Xlinker", "__info_plist",
          "-Xlinker", Context.packageDirectory + "/Sources/MrOttoSpeech/Info.plist",
        ])
      ]
    ),
    .testTarget(name: "MrOttoSpeechTests", dependencies: ["MrOttoSpeech"]),
  ]
)
