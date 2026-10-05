import Foundation
import HealthKit

// 按天汇总（#1656，spec §3.3）：在手机当前时区按自然日切。
// · 累计类：HKStatisticsCollectionQuery .cumulativeSum
// · 心率 / 血氧：min / avg / max；静息心率、HRV：avg
// · 体重 / 体脂：每天最后一条
// · 站立小时：appleStandHour 里 stood 的样本数
// · 睡眠：按一夜（相邻样本间隔 < 2 小时合为一段）归到醒来那天，段内按分期累加分钟；
//   一段里有 Apple Watch 来源时只用手表的（防手表 + 手机重复计）。
//   iOS 16 起手表把一夜写成很多短的分期小段，若逐条按各自结束时间归日，一夜会被午夜劈成两天。
// · 训练：HKWorkout 列表
// 输出 { days: [[String: Any]], workouts: [[String: Any]] }，键名对 src/shared/health.ts 的 HealthDay / HealthWorkout。
// 输出只含 [from, to] 范围内的日子。
struct HealthReader {
  let store: HKHealthStore
  private let calendar: Calendar
  private let dayFormatter: DateFormatter

  init(store: HKHealthStore) {
    self.store = store
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    self.calendar = c
    // 一个实例只建一次：睡眠几千条小段每条都要 dayKey，每次新建 DateFormatter 很贵
    let f = DateFormatter()
    f.calendar = c
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    self.dayFormatter = f
  }

  static let readTypes: Set<HKObjectType> = [
    HKQuantityType(.stepCount), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
    HKQuantityType(.flightsClimbed), HKQuantityType(.appleExerciseTime), HKCategoryType(.appleStandHour),
    HKCategoryType(.sleepAnalysis),
    HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKQuantityType(.heartRateVariabilitySDNN), HKQuantityType(.oxygenSaturation),
    HKQuantityType(.bodyMass), HKQuantityType(.bodyFatPercentage),
    HKObjectType.workoutType(),
  ]

  private func dayKey(_ d: Date) -> String {
    dayFormatter.string(from: d)
  }

  // 不走 DateFormatter 解析：有些时区（圣地亚哥、亚松森、开罗）夏令时在午夜跳过，当天 00:00 不存在，date(from:) 会回 nil。
  // 先拿 yyyy-MM-dd 的年月日拼成日期，再 startOfDay（它会落到当天真正的第一刻）。
  private func parseDay(_ s: String) throws -> Date {
    let bad = NSError(domain: "OttoHealth", code: 1, userInfo: [NSLocalizedDescriptionKey: "日期不对：\(s)"])
    let parts = s.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
          let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
          (1...12).contains(m), (1...31).contains(d),
          let date = calendar.date(from: DateComponents(year: y, month: m, day: d, hour: 12))
    else { throw bad }
    let day = calendar.startOfDay(for: date)
    guard dayKey(day) == s else { throw bad } // 2 月 30 日之类会被 Calendar 滚到下个月，不认
    return day
  }

  private static func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }

  func read(metrics: Set<String>, from: String, to: String) async throws -> [String: Any] {
    let start = try parseDay(from)
    let end = calendar.date(byAdding: .day, value: 1, to: try parseDay(to))!
    var days: [String: [String: Any]] = [:]
    func put(_ key: String, _ field: String, _ value: Any) { days[key, default: ["date": key]][field] = value }

    let sums: [(String, HKQuantityTypeIdentifier, HKUnit, String)] = [
      ("steps", .stepCount, .count(), "steps"),
      ("distance", .distanceWalkingRunning, .meter(), "distanceM"),
      ("activeEnergy", .activeEnergyBurned, .kilocalorie(), "activeKcal"),
      ("flights", .flightsClimbed, .count(), "flights"),
      ("exerciseMinutes", .appleExerciseTime, .minute(), "exerciseMin"),
    ]
    for (metric, id, unit, field) in sums where metrics.contains(metric) {
      for (day, s) in try await collection(id, .cumulativeSum, start: start, end: end) {
        if let q = s.sumQuantity() { put(day, field, Self.round1(q.doubleValue(for: unit))) }
      }
    }

    let bpm = HKUnit.count().unitDivided(by: .minute())
    if metrics.contains("heartRate") {
      for (day, s) in try await collection(.heartRate, [.discreteMin, .discreteAverage, .discreteMax], start: start, end: end) {
        if let mn = s.minimumQuantity(), let av = s.averageQuantity(), let mx = s.maximumQuantity() {
          put(day, "heartRate", ["min": Self.round1(mn.doubleValue(for: bpm)), "avg": Self.round1(av.doubleValue(for: bpm)), "max": Self.round1(mx.doubleValue(for: bpm))])
        }
      }
    }
    let averages: [(String, HKQuantityTypeIdentifier, HKUnit, String)] = [
      ("restingHeartRate", .restingHeartRate, bpm, "restingHeartRate"),
      ("hrv", .heartRateVariabilitySDNN, .secondUnit(with: .milli), "hrv"),
    ]
    for (metric, id, unit, field) in averages where metrics.contains(metric) {
      for (day, s) in try await collection(id, .discreteAverage, start: start, end: end) {
        if let q = s.averageQuantity() { put(day, field, Self.round1(q.doubleValue(for: unit))) }
      }
    }
    if metrics.contains("spo2") {
      for (day, s) in try await collection(.oxygenSaturation, [.discreteMin, .discreteAverage], start: start, end: end) {
        if let mn = s.minimumQuantity(), let av = s.averageQuantity() {
          put(day, "spo2", ["min": Self.round1(mn.doubleValue(for: .percent()) * 100), "avg": Self.round1(av.doubleValue(for: .percent()) * 100)])
        }
      }
    }

    let latest: [(String, HKQuantityTypeIdentifier, (HKQuantity) -> Double, String)] = [
      ("bodyMass", .bodyMass, { $0.doubleValue(for: .gramUnit(with: .kilo)) }, "bodyMassKg"),
      ("bodyFat", .bodyFatPercentage, { $0.doubleValue(for: .percent()) * 100 }, "bodyFatPct"),
    ]
    for (metric, id, value, field) in latest where metrics.contains(metric) {
      let samples = try await samples(HKQuantityType(id), start: start, end: end) as? [HKQuantitySample] ?? []
      for s in samples { put(dayKey(s.endDate), field, Self.round1(value(s.quantity))) } // 按 endDate 升序，后写的覆盖 = 当天最后一条
    }

    if metrics.contains("standHours") {
      let samples = try await samples(HKCategoryType(.appleStandHour), start: start, end: end) as? [HKCategorySample] ?? []
      var count: [String: Int] = [:]
      for s in samples where s.value == HKCategoryValueAppleStandHour.stood.rawValue { count[dayKey(s.startDate), default: 0] += 1 }
      for (day, n) in count { put(day, "standHours", n) }
    }

    if metrics.contains("sleep") {
      // 按一夜归日：多取前 12 小时，让头一天前一晚的前半夜也在手里；
      // 按开始时间排序，相邻样本间隔 <= 2 小时就并进同一段（段尾取见过的最大 endDate），段尾落在 (start, end] 的才要，
      // 以段尾 - 1 秒所在的日子为键（醒来那天；恰好 00:00 醒的算前一天结束）。
      let raw = try await samples(HKCategoryType(.sleepAnalysis), start: start.addingTimeInterval(-12 * 3600), end: end) as? [HKCategorySample] ?? []
      let sorted = raw.sorted { $0.startDate < $1.startDate }
      var sessions: [(end: Date, samples: [HKCategorySample])] = []
      for s in sorted {
        if let last = sessions.last, s.startDate <= last.end.addingTimeInterval(2 * 3600) {
          sessions[sessions.count - 1] = (end: max(last.end, s.endDate), samples: last.samples + [s])
        } else {
          sessions.append((end: s.endDate, samples: [s]))
        }
      }
      var sleepByDay: [String: [String: Double]] = [:]
      for session in sessions where session.end > start && session.end <= end {
        let watch = session.samples.filter { ($0.sourceRevision.productType ?? "").hasPrefix("Watch") }
        let use = watch.isEmpty ? session.samples : watch
        let key = dayKey(session.end.addingTimeInterval(-1))
        for s in use {
          let m = s.endDate.timeIntervalSince(s.startDate) / 60
          guard let stage = HKCategoryValueSleepAnalysis(rawValue: s.value) else { continue }
          switch stage {
          case .inBed: sleepByDay[key, default: [:]]["inBedMin", default: 0] += m
          case .awake: sleepByDay[key, default: [:]]["awakeMin", default: 0] += m
          case .asleepCore: sleepByDay[key, default: [:]]["coreMin", default: 0] += m; sleepByDay[key, default: [:]]["asleepMin", default: 0] += m
          case .asleepDeep: sleepByDay[key, default: [:]]["deepMin", default: 0] += m; sleepByDay[key, default: [:]]["asleepMin", default: 0] += m
          case .asleepREM: sleepByDay[key, default: [:]]["remMin", default: 0] += m; sleepByDay[key, default: [:]]["asleepMin", default: 0] += m
          case .asleepUnspecified: sleepByDay[key, default: [:]]["asleepMin", default: 0] += m
          @unknown default: break
          }
        }
      }
      for (day, mins) in sleepByDay where !mins.isEmpty { put(day, "sleep", mins.mapValues { $0.rounded() }) }
    }

    var workouts: [[String: Any]] = []
    if metrics.contains("workouts") {
      let iso = ISO8601DateFormatter()
      iso.timeZone = .current
      iso.formatOptions = [.withInternetDateTime]
      let list = try await samples(HKObjectType.workoutType(), start: start, end: end) as? [HKWorkout] ?? []
      for w in list {
        var o: [String: Any] = [
          "start": iso.string(from: w.startDate), "end": iso.string(from: w.endDate),
          "type": Self.typeName(w.workoutActivityType), "durationMin": Self.round1(w.duration / 60),
        ]
        for id in [HKQuantityTypeIdentifier.distanceWalkingRunning, .distanceCycling, .distanceSwimming] {
          if let q = w.statistics(for: HKQuantityType(id))?.sumQuantity() { o["distanceM"] = Self.round1(q.doubleValue(for: .meter())); break }
        }
        if let q = w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity() { o["activeKcal"] = Self.round1(q.doubleValue(for: .kilocalorie())) }
        workouts.append(o)
      }
    }

    // 只交 [from, to] 里的日子：统计桶、站立小时、睡眠的头一晚都可能在边上多出一天（yyyy-MM-dd 字符串比较即日期比较）
    let fromKey = dayKey(start)
    let toKey = dayKey(try parseDay(to))
    return ["days": days.keys.filter { $0 >= fromKey && $0 <= toKey }.sorted().map { days[$0]! }, "workouts": workouts]
  }

  private func collection(_ id: HKQuantityTypeIdentifier, _ options: HKStatisticsOptions, start: Date, end: Date) async throws -> [String: HKStatistics] {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    return try await withCheckedThrowingContinuation { cont in
      let q = HKStatisticsCollectionQuery(quantityType: HKQuantityType(id), quantitySamplePredicate: predicate, options: options,
                                          anchorDate: start, intervalComponents: DateComponents(day: 1))
      q.initialResultsHandler = { _, results, error in
        if let error {
          if (error as? HKError)?.code == .errorNoData { cont.resume(returning: [:]) } else { cont.resume(throwing: error) }
          return
        }
        var out: [String: HKStatistics] = [:]
        results?.enumerateStatistics(from: start, to: end) { s, _ in out[self.dayKey(s.startDate)] = s }
        cont.resume(returning: out)
      }
      store.execute(q)
    }
  }

  private func samples(_ type: HKSampleType, start: Date, end: Date) async throws -> [HKSample] {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
    return try await withCheckedThrowingContinuation { cont in
      let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]) { _, results, error in
        if let error {
          if (error as? HKError)?.code == .errorNoData { cont.resume(returning: []) } else { cont.resume(throwing: error) }
          return
        }
        cont.resume(returning: results ?? [])
      }
      store.execute(q)
    }
  }

  static func typeName(_ t: HKWorkoutActivityType) -> String {
    switch t {
    case .running: return "running"
    case .walking: return "walking"
    case .cycling: return "cycling"
    case .swimming: return "swimming"
    case .hiking: return "hiking"
    case .yoga: return "yoga"
    case .functionalStrengthTraining: return "functionalStrengthTraining"
    case .traditionalStrengthTraining: return "traditionalStrengthTraining"
    case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
    case .elliptical: return "elliptical"
    case .rowing: return "rowing"
    case .stairClimbing: return "stairClimbing"
    case .dance: return "dance"
    case .pilates: return "pilates"
    case .coreTraining: return "coreTraining"
    default: return "other(\(t.rawValue))"
    }
  }
}
