import AppKit
import Foundation

final class Bridge {
  private let outLock = NSLock()

  /// 后台线程逐行读 stdin,解出 IslandSnapshot 就回调(主线程由调用方切)
  func start(onSnapshot: @escaping (IslandSnapshot) -> Void) {
    let handle = FileHandle.standardInput
    DispatchQueue.global(qos: .userInitiated).async {
      var buffer = Data()
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break } // EOF:主进程退了
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
          let lineData = buffer.subdata(in: buffer.startIndex..<nl)
          buffer.removeSubrange(buffer.startIndex...nl)
          guard !lineData.isEmpty else { continue }
          do {
            let inbound = try JSONDecoder().decode(Inbound.self, from: lineData)
            onSnapshot(inbound.state)
          } catch {
            FileHandle.standardError.write("岛 helper:解码失败 \(error)\n".data(using: .utf8)!)
          }
        }
      }
      // stdin EOF → 主进程没了,退出
      DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
    }
  }

  func send(_ out: Outbound) {
    outLock.lock(); defer { outLock.unlock() }
    FileHandle.standardOutput.write(out.jsonLine().data(using: .utf8)!)
  }
}
