// Narrows or widens the Herdr window through Accessibility, in one AX call.
// main.js builds this to data/tabs-git/winsize and calls it as
//   winsize '<json>'          (same spec as window.js)
// It prints one JSON line. Any failure leaves the window alone.
//
// window.js does the same through AppleScript, which costs a few hundred
// milliseconds of `osascript` startup before the window even moves. The panel
// must be gone before the window changes (`spaces`/`git` closing), and that
// only looks instant if the resize lands in the same frame, so this exists.
import AppKit
import ApplicationServices
import Foundation

func emit(_ value: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: value),
     let text = String(data: data, encoding: .utf8) {
    print(text)
  } else {
    print("{\"ok\":false,\"reason\":\"encode-failed\"}")
  }
  exit(0)
}

func fail(_ reason: String, _ extra: [String: Any] = [:]) -> Never {
  var out: [String: Any] = ["ok": false, "reason": reason]
  out.merge(extra) { _, new in new }
  emit(out)
}

func number(_ spec: [String: Any], _ key: String, _ fallback: Double = 0) -> Double {
  (spec[key] as? NSNumber)?.doubleValue ?? fallback
}

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
  var value: AnyObject?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func position(_ element: AXUIElement) -> CGPoint? {
  guard let raw = attribute(element, kAXPositionAttribute as CFString),
        CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
  return point
}

func size(_ element: AXUIElement) -> CGSize? {
  guard let raw = attribute(element, kAXSizeAttribute as CFString),
        CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
  var box = CGSize.zero
  guard AXValueGetValue(raw as! AXValue, .cgSize, &box) else { return nil }
  return box
}

// The screen a window's middle sits on, in the top-left coordinates that
// Accessibility uses (NSScreen's origin is bottom-left).
func screenVisible(_ windowPosition: CGPoint, _ windowSize: CGSize) -> (x: CGFloat, width: CGFloat)? {
  let screens = NSScreen.screens
  guard let primary = screens.first else { return nil }
  let middleX = windowPosition.x + windowSize.width / 2
  let middleY = windowPosition.y + windowSize.height / 2
  for screen in screens {
    let frame = screen.frame
    let top = primary.frame.height - frame.maxY
    if middleX >= frame.minX && middleX < frame.maxX &&
       middleY >= top && middleY < top + frame.height {
      return (screen.visibleFrame.minX, screen.visibleFrame.width)
    }
  }
  return (primary.visibleFrame.minX, primary.visibleFrame.width)
}

let text = CommandLine.arguments.dropFirst().joined(separator: " ")
// main.js asks which build this is so a changed source rebuilds it.
if text == "--version" {
  print("1")
  exit(0)
}
guard let data = text.data(using: .utf8),
      let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
  fail("bad-args")
}

guard AXIsProcessTrusted() else { fail("not-trusted") }

let pid: pid_t
if let given = spec["pid"] as? NSNumber, given.int32Value > 0 {
  pid = given.int32Value
} else {
  pid = NSWorkspace.shared.runningApplications.first {
    $0.localizedName == "Herdr" && $0.activationPolicy == .regular
  }?.processIdentifier ?? 0
}
guard pid > 0 else { fail("no-app") }

let app = AXUIElementCreateApplication(pid)
guard let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement],
      !windows.isEmpty else { fail("no-window") }

// Popovers, tooltips and sheets are windows too: take the largest one,
// which is the app's main window.
var main: AXUIElement?
var origin = CGPoint.zero
var bounds = CGSize.zero
var best: CGFloat = -1
for window in windows {
  guard let point = position(window), let box = size(window) else { continue }
  let area = box.width * box.height
  if area > best {
    best = area
    main = window
    origin = point
    bounds = box
  }
}
guard let window = main else { fail("no-window") }

func resize(to width: CGFloat) -> Bool {
  var box = CGSize(width: width, height: bounds.height)
  guard let value = AXValueCreate(.cgSize, &box) else { return false }
  return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) == .success
}

let minimum = CGFloat(number(spec, "min", 640))
let delta = CGFloat(number(spec, "delta"))
let mode = spec["mode"] as? String ?? ""

if mode == "grow" {
  guard delta.isFinite, delta > 0 else { fail("bad-delta") }
  // After a restart the window may still be at the width it had with the
  // panel open. Then there is nothing to grow.
  let base = CGFloat(number(spec, "base"))
  let known = CGFloat(number(spec, "grown"))
  if known > 0 && abs(bounds.width - known) <= 2 {
    emit(["ok": true, "noop": true, "from": bounds.width, "to": bounds.width,
          "applied": 0, "grownBy": base > 0 ? max(0, bounds.width - base) : 0])
  }
  // Widen to the right, but no further than the screen's visible edge.
  let visible = screenVisible(origin, bounds)
  let right = visible.map { $0.x + $0.width } ?? (origin.x + bounds.width)
  let limit = max(minimum, (right - origin.x).rounded())
  let target = min((bounds.width + delta).rounded(), limit)
  let applied = target - bounds.width
  guard applied >= 1 else { fail("no-room", ["width": bounds.width]) }
  guard resize(to: target) else { fail("set-failed", ["width": bounds.width]) }
  emit(["ok": true, "from": bounds.width, "to": target, "applied": applied])
}

if mode == "shrink" {
  let expected = CGFloat(number(spec, "expected"))
  if expected > 0 && abs(bounds.width - expected) > 2 {
    fail("width-changed", ["width": bounds.width])
  }
  guard delta.isFinite, delta > 0 else { fail("bad-delta") }
  let target = max(minimum, (bounds.width - delta).rounded())
  let applied = bounds.width - target
  guard applied >= 1 else { fail("no-room", ["width": bounds.width]) }
  guard resize(to: target) else { fail("set-failed", ["width": bounds.width]) }
  emit(["ok": true, "from": bounds.width, "to": target, "applied": applied])
}

fail("bad-mode")
