import Foundation

// stdin 一行一条 Command；stdout 一行一条 Event（识别结果自己冒出来，不配对）。
// 读 stdin 的线程只负责解析，所有状态在主线程上动（识别回调也 hop 到 main）。
// stdin 关了 = 主进程没了：收掉麦克风就退出，不留一个占着麦克风的孤儿。

setbuf(stdout, nil)

// 让自己成为 TCC 的「责任进程」（#1180）。麦克风 / 语音识别的授权归到责任进程，而 TCC 沿进程树
// 一路归到**最顶上的 GUI app**：dev 是从终端起的，那就是终端（cmux / iTerm / Terminal，谁都不带
// NSSpeechRecognitionUsageDescription），TCC 于是把**这个进程**杀掉（EXC_CRASH，namespace TCC——
// 2026-09-09 真机就是这么死的，崩溃报告里 responsibleProc = cmux）。给 Electron.app 补 plist 没用：
// 它不是顶上那个。
// responsibility_spawnattrs_setdisclaim 是 libSystem 的私有接口（Chromium 给 helper 进程用的就是它），
// 配 POSIX_SPAWN_SETEXEC = 原地 exec 自己一遍、不多一个进程；stdin/stdout 原样继承。成了之后 TCC 读
// 嵌在二进制里的那份 Info.plist（Package.swift 的 -sectcreate），弹窗写的是 MrOttoSpeech。
// 真机验过：setdisclaim rc=0 → 4 秒内 speech/mic 都 authorized。
// 失败（接口没了 / exec 被拒）就原样往下跑——那时授权归爹，打包的 app 有 extendInfo 兜着。
@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private func disclaimResponsibility() {
  let marker = "MROTTO_SPEECH_DISCLAIMED"
  if ProcessInfo.processInfo.environment[marker] == "1" { return }
  var attrs: posix_spawnattr_t? = nil
  guard posix_spawnattr_init(&attrs) == 0 else { return }
  defer { posix_spawnattr_destroy(&attrs) }
  guard posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETEXEC)) == 0 else { return }
  guard responsibility_spawnattrs_setdisclaim(&attrs, 1) == 0 else { return }
  let exe = CommandLine.arguments[0]
  var env = ProcessInfo.processInfo.environment
  env[marker] = "1"
  let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
  let cArgs = CommandLine.arguments.map { strdup($0) } + [nil]
  defer {
    cEnv.forEach { free($0) }
    cArgs.forEach { free($0) }
  }
  var pid: pid_t = 0
  // SETEXEC：成功就不会回来；回来 = 失败，照旧往下跑
  _ = posix_spawn(&pid, exe, nil, &attrs, cArgs, cEnv)
}
disclaimResponsibility()

let encoder = JSONEncoder()
func emit(_ e: Event) {
  guard let data = try? encoder.encode(e), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

let recognizer = Recognizer(emit: emit)

func handle(_ cmd: Command) {
  switch cmd.type {
  case "start":
    recognizer.start(locale: cmd.locale ?? "zh-CN", silenceMs: cmd.silenceMs ?? 1500, completeMs: cmd.completeMs ?? 700, midMs: cmd.midMs ?? 1500)
  case "stop":
    recognizer.stop()
  case "pause":
    recognizer.pause()
  case "resume":
    recognizer.resume()
  case "status":
    emit(recognizer.status())
  default:
    break  // 认不出的命令直接丢（同 SimInput）
  }
}

let reader = Thread {
  let decoder = JSONDecoder()
  while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8), let cmd = try? decoder.decode(Command.self, from: data) else {
      continue
    }
    DispatchQueue.main.async { handle(cmd) }
  }
  DispatchQueue.main.async {
    recognizer.stop()
    exit(0)
  }
}
reader.start()
RunLoop.main.run()
