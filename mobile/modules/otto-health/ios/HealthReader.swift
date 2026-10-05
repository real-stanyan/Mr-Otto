import Foundation
import HealthKit

// 按天汇总（#1656，spec §3.3）：在手机当前时区按自然日切。
// · 累计类：HKStatisticsCollectionQuery .cumulativeSum
// · 心率 / 血氧：min / avg / max；静息心率、HRV：avg
// · 体重 / 体脂：每天最后一条
// · 站立小时：appleStandHour 里 stood 的样本数
// · 睡眠：样本按分期累加分钟，归到样本结束（醒来）那天；当天有 Apple Watch 来源时只用手表的（防手表 + 手机重复计）
// · 训练：HKWorkout 列表
// 输出 { days: [[String: Any]], workouts: [[String: Any]] }，键名对 src/shared/health.ts 的 HealthDay / HealthWorkout。
struct HealthReader {
  let store: HKHealthStore

  static let readTypes: Set<HKObjectType> = [
    HKQuantityType(.stepCount), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
    HKQuantityType(.flightsClimbed), HKQuantityType(.appleExerciseTime), HKCategoryType(.appleStandHour),
    HKCategoryType(.sleepAnalysis),
    HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKQuantityType(.heartRateVariabilitySDNN), HKQuantityType(.oxygenSaturation),
    HKQuantityType(.bodyMass), HKQuantityType(.bodyFatPercentage),
    HKObjectType.workoutType(),
  ]

  private var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    return c
  }

  private func dayKey(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = calendar
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
  }

  private func parseDay(_ s: String) throws -> Date {
    let f = DateFormatter()
    f.calendar = calendar
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: s) else { throw NSError(domain: "OttoHealth", code: 1, userInfo: [NSLocalizedDescriptionKey: "日期不对：\(s)"]) }
    return calendar.startOfDay(for: d)
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
      // 醒来那天算：取 [start-12h, end) 里结束于 [start, end) 的样本
      let raw = try await samples(HKCategoryType(.sleepAnalysis), start: start.addingTimeInterval(-12 * 3600), end: end) as? [HKCategorySample] ?? []
      let inRange = raw.filter { $0.endDate > start && $0.endDate <= end }
      let byDay = Dictionary(grouping: inRange) { dayKey($0.endDate.addingTimeInterval(-1)) }
      for (day, list) in byDay {
        let watch = list.filter { ($0.sourceRevision.productType ?? "").hasPrefix("Watch") }
        let use = watch.isEmpty ? list : watch
        var mins: [String: Double] = [:]
        for s in use {
          let m = s.endDate.timeIntervalSince(s.startDate) / 60
          guard let stage = HKCategoryValueSleepAnalysis(rawValue: s.value) else { continue }
          switch stage {
          case .inBed: mins["inBedMin", default: 0] += m
          case .awake: mins["awakeMin", default: 0] += m
          case .asleepCore: mins["coreMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepDeep: mins["deepMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepREM: mins["remMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepUnspecified: mins["asleepMin", default: 0] += m
          @unknown default: break
          }
        }
        if !mins.isEmpty { put(day, "sleep", mins.mapValues { $0.rounded() }) }
      }
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

    return ["days": days.keys.sorted().map { days[$0]! }, "workouts": workouts]
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
