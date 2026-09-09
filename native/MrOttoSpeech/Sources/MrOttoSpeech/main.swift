import Foundation

// stdin 一行一条 Command；stdout 一行一条 Event（识别结果自己冒出来，不配对）。
// 读 stdin 的线程只负责解析，所有状态在主线程上动（识别回调也 hop 到 main）。
// stdin 关了 = 主进程没了：收掉麦克风就退出，不留一个占着麦克风的孤儿。

setbuf(stdout, nil)

// TCC 授权归到**责任进程**——这个裸二进制是主 app spawn 的，责任进程是它爹：开发时是
// node_modules 里的 Electron.app（build-speech.mjs --debug 给它补 NSSpeechRecognitionUsageDescription），
// 打包后是 Mr Otto.app（electron-builder.yml 的 extendInfo）。爹的 Info.plist 少那一句的话 TCC 会把
// **这个进程**杀掉（EXC_CRASH，namespace TCC，2026-09-09 从终端直接起就是这么死的——终端没那句）。
// 试过 responsibility_spawnattrs_setdisclaim + POSIX_SPAWN_SETEXEC 让它自己当责任进程：不再被杀，
// 但 60 秒内授权框一次都没弹出来（notDetermined 到底），放弃；二进制里嵌的那份 Info.plist 留着，
// 命令行调试时至少不崩。

let encoder = JSONEncoder()
func emit(_ e: Event) {
  guard let data = try? encoder.encode(e), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

let recognizer = Recognizer(emit: emit)

func handle(_ cmd: Command) {
  switch cmd.type {
  case "start":
    recognizer.start(locale: cmd.locale ?? "zh-CN", silenceMs: cmd.silenceMs ?? 1500)
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
