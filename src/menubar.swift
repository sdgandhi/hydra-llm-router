import AppKit
import Foundation

final class HydraMenuDelegate: NSObject, NSApplicationDelegate {
  private let info: [String: Any]
  private var statusItem: NSStatusItem?

  init(info: [String: Any]) {
    self.info = info
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    configureStatusButton(item.button)

    let menu = NSMenu()
    addDisabled("Hydra Running", to: menu)
    menu.addItem(NSMenuItem.separator())
    addDisabled("Router: \(stringValue("routerUrl"))", to: menu)
    addDisabled("Cloud: \(stringValue("openaiBaseUrl"))", to: menu)
    addDisabled("Ollama: \(stringValue("ollamaBaseUrl"))", to: menu)

    if boolValue("debugAuth") {
      addDisabled("Debug log: \(stringValue("logPath"))", to: menu)
    } else {
      addDisabled("Debug logging: off", to: menu)
    }

    addDisabled("Codex config: \(stringValue("codexConfigPath"))", to: menu)
    menu.addItem(NSMenuItem.separator())

    let quit = NSMenuItem(title: "Quit Hydra", action: #selector(quitHydra), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)

    item.menu = menu
    statusItem = item
    emit(["type": "ready"])
  }

  @objc private func quitHydra() {
    emit(["type": "quit"])
    NSApp.terminate(nil)
  }

  private func addDisabled(_ title: String, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func configureStatusButton(_ button: NSStatusBarButton?) {
    guard let button else {
      return
    }

    button.toolTip = "Hydra"
    button.setAccessibilityLabel("Hydra")

    if let image = NSImage(contentsOfFile: stringValue("iconPath")) {
      image.isTemplate = true
      image.size = NSSize(width: 18, height: 18)
      button.image = image
      button.imagePosition = .imageOnly
    } else {
      button.title = stringValue("title", fallback: "Hydra")
    }
  }

  private func stringValue(_ key: String, fallback: String = "") -> String {
    return info[key] as? String ?? fallback
  }

  private func boolValue(_ key: String) -> Bool {
    return info[key] as? Bool ?? false
  }

  private func emit(_ value: [String: String]) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: value),
      let line = String(data: data, encoding: .utf8)
    else {
      return
    }

    print(line)
    fflush(stdout)
  }
}

func decodeInfo() -> [String: Any] {
  guard CommandLine.arguments.count > 1 else {
    return [:]
  }

  let raw = CommandLine.arguments[1]
  guard
    let data = raw.data(using: .utf8),
    let object = try? JSONSerialization.jsonObject(with: data),
    let info = object as? [String: Any]
  else {
    return [:]
  }

  return info
}

let app = NSApplication.shared
let delegate = HydraMenuDelegate(info: decodeInfo())
app.delegate = delegate
app.run()
