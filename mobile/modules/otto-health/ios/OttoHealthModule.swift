import ExpoModulesCore
import HealthKit

// Apple 健康（#1656）：三个入口——有没有健康数据、请求读取授权、按天汇总查询。只读：toShare 永远是空集。
// 读权限被拒时 HealthKit 不告诉 App（查询照常成功、只是空），所以这里不区分「没授权」与「没数据」，交给模型照实说。
public class OttoHealthModule: Module {
  private let store = HKHealthStore()

  public func definition() -> ModuleDefinition {
    Name("OttoHealth")

    Function("isAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }

    AsyncFunction("requestAuthorization") { (promise: Promise) in
      guard HKHealthStore.isHealthDataAvailable() else {
        promise.reject("E_UNAVAILABLE", "这台设备没有健康数据")
        return
      }
      self.store.requestAuthorization(toShare: [], read: HealthReader.readTypes) { ok, error in
        if let error {
          promise.reject("E_AUTH", error.localizedDescription)
        } else {
          promise.resolve(ok)
        }
      }
    }

    AsyncFunction("query") { (metrics: [String], from: String, to: String) async throws -> [String: Any] in
      try await HealthReader(store: self.store).read(metrics: Set(metrics), from: from, to: to)
    }
  }
}
