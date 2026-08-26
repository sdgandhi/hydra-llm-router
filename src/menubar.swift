import AppKit
import Foundation
import UniformTypeIdentifiers

final class HydraMenuDelegate: NSObject, NSApplicationDelegate {
  private var info: [String: Any]
  private var statusItem: NSStatusItem?

  init(info: [String: Any]) {
    self.info = info
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    configureStatusButton(item.button)

    item.menu = buildMenu()
    statusItem = item
    listenForUpdates()
    emit(["type": "ready"])
  }

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()
    for statusItem in statusItems() {
      addStatusItem(statusItem, to: menu)
    }
    menu.addItem(NSMenuItem.separator())

    let quit = NSMenuItem(title: "Quit Hydra & Restore Codex", action: #selector(quitHydra), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    return menu
  }

  @objc private func quitHydra() {
    emit(["type": "quit"])
    NSApp.terminate(nil)
  }

  @objc private func performMenuAction(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    if id == "open_config" {
      chooseApplicationAndOpenConfig()
      return
    }
    emit(["type": "action", "id": id])
  }

  private func chooseApplicationAndOpenConfig() {
    let configURL = URL(fileURLWithPath: stringValue("configPath"))
    guard FileManager.default.fileExists(atPath: configURL.path) else {
      showError("Hydra config not found", detail: "No config exists at \(configURL.path).")
      return
    }

    let panel = NSOpenPanel()
    panel.title = "Open Hydra Config With"
    panel.message = "Choose an application to open config.toml."
    panel.prompt = "Open"
    panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
    panel.allowedContentTypes = [UTType.application]
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.treatsFilePackagesAsDirectories = false

    guard panel.runModal() == .OK, let applicationURL = panel.url else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    NSWorkspace.shared.open(
      [configURL],
      withApplicationAt: applicationURL,
      configuration: configuration
    ) { [weak self] _, error in
      guard let error else { return }
      DispatchQueue.main.async {
        self?.showError("Could not open Hydra config", detail: error.localizedDescription)
      }
    }
  }

  private func showError(_ title: String, detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.alertStyle = .warning
    alert.runModal()
  }

  private func addDisabled(_ title: String, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func addStatusItem(_ statusItem: [String: Any], to menu: NSMenu) {
    let kind = statusItem["kind"] as? String ?? "info"
    let title = statusItem["title"] as? String ?? ""

    switch kind {
    case "separator":
      menu.addItem(NSMenuItem.separator())
    case "submenu":
      let submenuItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let submenu = NSMenu(title: title)
      for child in statusItem["items"] as? [[String: Any]] ?? [] {
        addStatusItem(child, to: submenu)
      }
      if submenu.items.isEmpty {
        addDisabled("No models detected", to: submenu)
      }
      submenuItem.submenu = submenu
      menu.addItem(submenuItem)
    case "action":
      let item = NSMenuItem(title: title, action: #selector(performMenuAction(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = statusItem["id"] as? String ?? ""
      menu.addItem(item)
    default:
      addDisabled(title, to: menu)
    }
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

  private func statusItems() -> [[String: Any]] {
    return info["statusItems"] as? [[String: Any]] ?? []
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

  private func listenForUpdates() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine() {
        guard
          let data = line.data(using: .utf8),
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          message["type"] as? String == "update",
          let nextInfo = message["info"] as? [String: Any]
        else { continue }
        DispatchQueue.main.async {
          self?.info = nextInfo
          self?.statusItem?.menu = self?.buildMenu()
        }
      }
    }
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
