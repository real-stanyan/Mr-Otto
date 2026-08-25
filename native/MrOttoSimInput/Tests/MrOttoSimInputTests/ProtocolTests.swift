import XCTest

@testable import MrOttoSimInput

// 只测纯函数：找窗口/发事件那部分要真 Simulator + 真授权，进不了 CI
final class ProtocolTests: XCTestCase {
  func testComboTable() {
    XCTAssertEqual(comboFor(button: "home"), KeyCombo(keyCode: 4, modifiers: ["command", "shift"]))
    XCTAssertEqual(comboFor(button: "lock"), KeyCombo(keyCode: 37, modifiers: ["command"]))
    XCTAssertNil(comboFor(button: "volumeUp"))
  }

  func testInterpolateEndsOnTarget() {
    let pts = interpolate(from: (x: 0, y: 0), to: (x: 10, y: 20), steps: 5)
    XCTAssertEqual(pts.count, 5)
    XCTAssertEqual(pts.last!.x, 10, accuracy: 0.0001)
    XCTAssertEqual(pts.last!.y, 20, accuracy: 0.0001)
  }

  func testDecodeRequest() throws {
    let r = try JSONDecoder().decode(
      Request.self, from: #"{"id":7,"type":"tap","x":1.5,"y":2}"#.data(using: .utf8)!)
    XCTAssertEqual(r.id, 7)
    XCTAssertEqual(r.type, "tap")
    XCTAssertEqual(r.x, 1.5)
  }
}

extension ProtocolTests {
  func testFitCenteredKeepsAspectAndCenters() {
    // 实测:iPhone-test 的窗口 456x972,截图 1206x2622
    let r = fitCentered(shot: (width: 1206, height: 2622), box: Rect(x: 636, y: 61, width: 456, height: 972))
    XCTAssertEqual(r.height, 972, accuracy: 0.5)          // 高度吃满
    XCTAssertEqual(r.width, 972 * 1206 / 2622, accuracy: 0.5)
    XCTAssertEqual(r.x, 636 + (456 - r.width) / 2, accuracy: 0.5)  // 水平居中
  }
}
