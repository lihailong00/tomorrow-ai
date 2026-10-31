import Foundation
import CoreFoundation
import HealthKit
import React
import UIKit

/// Foreground, read-only HealthKit import. Does not persist, upload or alter samples.
@objc(TadaHealth)
final class HealthDataModule: NSObject {
  private let store = HKHealthStore()
  private static let allMetrics = Set(["steps", "heart_rate", "sleep", "workout", "weight"])
  private static let maxRecords = 2000
  private var authorizationPending = false
  private var readPending = false

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(availability:rejecter:)
  func availability(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let available = HKHealthStore.isHealthDataAvailable()
    resolve([
      "provider": "apple_health",
      "status": available ? "available" : "unavailable",
      "detail": available
        ? "可读取Apple健康中由你允许共享的数据；空记录不代表指标为零或已拒绝授权"
        : "此设备没有可用的Apple健康数据存储"
    ])
  }

  private func metrics(_ values: Any?) -> [String]? {
    guard let values = values as? [String], !values.isEmpty,
      values.count <= Self.allMetrics.count,
      Set(values).count == values.count,
      values.allSatisfy({ Self.allMetrics.contains($0) }) else { return nil }
    return values
  }

  private func sampleType(_ metric: String) -> HKSampleType {
    switch metric {
    case "steps": return HKQuantityType.quantityType(forIdentifier: .stepCount)!
    case "heart_rate": return HKQuantityType.quantityType(forIdentifier: .heartRate)!
    case "sleep": return HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
    case "weight": return HKQuantityType.quantityType(forIdentifier: .bodyMass)!
    default: return HKObjectType.workoutType()
    }
  }

  @objc(requestReadPermissions:resolver:rejecter:)
  func requestReadPermissions(_ values: NSArray, resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let selected = metrics(values) else {
      reject("E_HEALTH_INPUT", "请选择有效的健康数据类型", nil); return
    }
    guard HKHealthStore.isHealthDataAvailable() else {
      reject("E_HEALTH_UNAVAILABLE", "此设备不支持Apple健康", nil); return
    }
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState == .active else {
        reject("E_HEALTH_FOREGROUND", "请在应用前台申请健康权限", nil); return
      }
      guard !self.authorizationPending else {
        reject("E_HEALTH_BUSY", "已有健康权限请求正在进行", nil); return
      }
      self.authorizationPending = true
      let readTypes: Set<HKObjectType> = Set(selected.map { self.sampleType($0) as HKObjectType })
      self.store.requestAuthorization(toShare: [], read: readTypes) { success, _ in
        DispatchQueue.main.async {
          self.authorizationPending = false
          if success {
            // HealthKit intentionally hides whether read permissions were denied.
            resolve(["requested": selected])
          } else {
            reject("E_HEALTH_PERMISSION", "健康权限请求未完成，请在Apple健康设置中检查", nil)
          }
        }
      }
    }
  }

  @objc(readRecords:resolver:rejecter:)
  func readRecords(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState == .active else {
        reject("E_HEALTH_FOREGROUND", "请在应用前台读取健康数据", nil); return
      }
      guard !self.readPending else {
        reject("E_HEALTH_BUSY", "已有健康数据读取正在进行", nil); return
      }
      self.readPending = true
      self.performRead(options, resolver: { result in
        DispatchQueue.main.async { self.readPending = false; resolve(result) }
      }, rejecter: { code, message, error in
        DispatchQueue.main.async { self.readPending = false; reject(code, message, error) }
      })
    }
  }

  private func performRead(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let selected = metrics(options["metrics"]), let value = options["days"] as? NSNumber,
      CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
      value.doubleValue.rounded() == value.doubleValue, value.intValue >= 1, value.intValue <= 30 else {
      reject("E_HEALTH_INPUT", "请选择有效的数据类型和1至30天的范围", nil); return
    }
    guard HKHealthStore.isHealthDataAvailable() else {
      reject("E_HEALTH_UNAVAILABLE", "此设备不支持Apple健康", nil); return
    }
    let end = Date()
    let start = end.addingTimeInterval(-Double(value.intValue) * 86400)
    let datePredicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
    let queue = DispatchQueue(label: "com.tomorrowai.health.read.\(UUID().uuidString)")
    let limit = Self.maxRecords / selected.count
    var output = [[String: Any]]()
    var pending = selected.count
    var completed = false
    var truncated = false
    var queries = [HKSampleQuery]()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    for metric in selected {
      let predicate: NSPredicate
      if metric == "sleep" {
        var sleepValues = [HKCategoryValueSleepAnalysis.asleep.rawValue]
        if #available(iOS 16.0, *) {
          sleepValues += [HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                          HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                          HKCategoryValueSleepAnalysis.asleepREM.rawValue]
        }
        let stages = sleepValues.map { HKQuery.predicateForCategorySamples(with: .equalTo, value: $0) }
        predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
          datePredicate, NSCompoundPredicate(orPredicateWithSubpredicates: stages)
        ])
      } else {
        predicate = datePredicate
      }
      let query = HKSampleQuery(sampleType: sampleType(metric), predicate: predicate, limit: limit + 1,
                                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) {
        _, samples, error in
        queue.async {
          guard !completed else { return }
          if error != nil {
            completed = true
            queries.forEach { self.store.stop($0) }
            reject("E_HEALTH_READ", "无法读取健康数据，请检查Apple健康权限后重试", nil)
            return
          }
          let records = samples ?? []
          truncated = truncated || records.count > limit
          for sample in records.prefix(limit) {
            if let row = self.record(sample, metric: metric, formatter: formatter) {
              output.append(row)
            }
          }
          pending -= 1
          if pending == 0 {
            completed = true
            output.sort { ($0["end_at"] as? String ?? "") > ($1["end_at"] as? String ?? "") }
            resolve(["records": output, "synced_at": formatter.string(from: end), "truncated": truncated])
          }
        }
      }
      queries.append(query)
    }
    // Set up every query before executing so completion/timeout can stop the exact batch.
    queue.async {
      queries.forEach { self.store.execute($0) }
      queue.asyncAfter(deadline: .now() + 30) {
        guard !completed else { return }
        completed = true
        queries.forEach { self.store.stop($0) }
        reject("E_HEALTH_TIMEOUT", "健康数据读取超时，请缩小日期范围后重试", nil)
      }
    }
  }

  private func record(_ sample: HKSample, metric: String, formatter: ISO8601DateFormatter) -> [String: Any]? {
    let value: Double
    let unit: String
    switch metric {
    case "steps":
      guard let sample = sample as? HKQuantitySample else { return nil }
      value = sample.quantity.doubleValue(for: .count()); unit = "count"
    case "heart_rate":
      guard let sample = sample as? HKQuantitySample else { return nil }
      value = sample.quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute())); unit = "bpm"
    case "weight":
      guard let sample = sample as? HKQuantitySample else { return nil }
      value = sample.quantity.doubleValue(for: .gramUnit(with: .kilo)); unit = "kg"
    case "sleep":
      value = sample.endDate.timeIntervalSince(sample.startDate) / 60; unit = "min"
    case "workout":
      guard let sample = sample as? HKWorkout else { return nil }
      value = sample.duration / 60; unit = "min"
    default: return nil
    }
    guard value.isFinite && value >= 0 else { return nil }
    var row: [String: Any] = [
      "id": "apple_health:\(sample.uuid.uuidString)", "source": "apple_health", "metric": metric,
      "source_app": sample.sourceRevision.source.bundleIdentifier,
      "start_at": formatter.string(from: sample.startDate), "end_at": formatter.string(from: sample.endDate),
      "value": value, "unit": unit
    ]
    if let device = sample.device {
      row["source_device"] = String([device.manufacturer, device.model].compactMap { $0 }.joined(separator: " ").prefix(160))
    }
    if metric == "sleep" { row["sleep_basis"] = "asleep_stages" }
    if let workout = sample as? HKWorkout { row["exercise_type"] = workout.workoutActivityType.rawValue }
    return row
  }

  @objc(openSettings:rejecter:)
  func openSettings(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      // Public URL only; no undocumented x-apple-health:// deep links.
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        reject("E_HEALTH_SETTINGS", "请在Apple健康中管理妥啦的数据访问权限", nil); return
      }
      UIApplication.shared.open(url, options: [:]) { success in
        if success { resolve(nil) }
        else { reject("E_HEALTH_SETTINGS", "请在Apple健康中管理妥啦的数据访问权限", nil) }
      }
    }
  }
}
