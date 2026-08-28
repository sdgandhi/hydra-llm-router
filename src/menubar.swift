import AppKit
import Foundation
import UniformTypeIdentifiers

final class PlaceholderTextView: NSTextView {
  var placeholder = "" { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard string.isEmpty, !placeholder.isEmpty else { return }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize),
      .foregroundColor: NSColor.placeholderTextColor,
    ]
    placeholder.draw(at: NSPoint(x: textContainerInset.width + 2, y: textContainerInset.height), withAttributes: attributes)
  }
}

final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

final class NewSyntheticModelController: NSObject, NSTextFieldDelegate, NSTextViewDelegate {
  private let window: NSWindow
  private let nameField = NSTextField()
  private let fallbackPopup = NSPopUpButton()
  private let selectorPopup = NSPopUpButton()
  private let promptView = PlaceholderTextView()
  private var contextButtons: [NSButton] = []
  private let scopePopup = NSPopUpButton()
  private let timeoutField = NSTextField(string: "0")
  private let retryCountField = NSTextField(string: "2")
  private let retryDelayField = NSTextField(string: "1000")
  private let saveButton = NSButton(title: "Save", target: nil, action: nil)
  private let errorLabel = NSTextField(labelWithString: "")
  private var candidateButtons: [NSButton] = []
  private let existingSlugs: Set<String>
  private let submit: ([String: Any], String) -> Void
  private var pendingRequestID: String?

  init(models: [[String: Any]], existingSlugs: Set<String>, submit: @escaping ([String: Any], String) -> Void) {
    self.existingSlugs = existingSlugs
    self.submit = submit
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 700, height: 820),
      styleMask: [.titled],
      backing: .buffered,
      defer: false
    )
    super.init()
    window.title = "New Hydra synthetic model"
    window.isReleasedWhenClosed = false
    configure(models: models)
  }

  func run() {
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    NSApp.runModal(for: window)
  }

  func handleResult(_ message: [String: Any]) {
    guard let requestID = message["requestId"] as? String, requestID == pendingRequestID else { return }
    pendingRequestID = nil
    if message["ok"] as? Bool == true {
      NSApp.stopModal(withCode: .OK)
      window.orderOut(nil)
      return
    }
    errorLabel.stringValue = message["error"] as? String ?? "Could not create synthetic model."
    updateValidation()
  }

  private func configure(models: [[String: Any]]) {
    nameField.placeholderString = "Model name"
    nameField.delegate = self

    for popup in [fallbackPopup, selectorPopup] {
      popup.addItem(withTitle: "Select a model…")
      for model in models {
        guard let slug = model["slug"] as? String else { continue }
        popup.addItem(withTitle: model["title"] as? String ?? slug)
        popup.lastItem?.representedObject = slug
      }
      popup.target = self
      popup.action = #selector(valueChanged)
    }

    let candidates = NSStackView()
    candidates.orientation = .vertical
    candidates.alignment = .leading
    candidates.spacing = 5
    for model in models {
      guard let slug = model["slug"] as? String else { continue }
      let button = NSButton(checkboxWithTitle: model["title"] as? String ?? slug, target: self, action: #selector(valueChanged))
      button.identifier = NSUserInterfaceItemIdentifier(slug)
      candidates.addArrangedSubview(button)
      candidateButtons.append(button)
    }
    if candidateButtons.isEmpty {
      candidates.addArrangedSubview(NSTextField(labelWithString: "No server or local models are available."))
    }
    let candidateDocument = FlippedView()
    candidateDocument.translatesAutoresizingMaskIntoConstraints = false
    candidates.translatesAutoresizingMaskIntoConstraints = false
    candidateDocument.addSubview(candidates)
    NSLayoutConstraint.activate([
      candidates.leadingAnchor.constraint(equalTo: candidateDocument.leadingAnchor, constant: 6),
      candidates.trailingAnchor.constraint(equalTo: candidateDocument.trailingAnchor, constant: -6),
      candidates.topAnchor.constraint(equalTo: candidateDocument.topAnchor, constant: 6),
      candidates.bottomAnchor.constraint(equalTo: candidateDocument.bottomAnchor, constant: -6),
    ])
    let candidateScroll = NSScrollView()
    candidateScroll.hasVerticalScroller = true
    candidateScroll.borderType = .bezelBorder
    candidateScroll.documentView = candidateDocument
    candidateScroll.heightAnchor.constraint(equalToConstant: 170).isActive = true
    candidateDocument.widthAnchor.constraint(equalTo: candidateScroll.contentView.widthAnchor).isActive = true

    promptView.placeholder = "For a simple query choose gpt-5.4-mini, otherwise choose gpt-5.6-sol"
    promptView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
    promptView.isRichText = false
    promptView.isAutomaticQuoteSubstitutionEnabled = false
    promptView.delegate = self
    let promptScroll = NSScrollView()
    promptScroll.hasVerticalScroller = true
    promptScroll.borderType = .bezelBorder
    promptScroll.documentView = promptView
    promptScroll.heightAnchor.constraint(equalToConstant: 100).isActive = true

    let contextChoices: [(String, String)] = [
      ("system", "System and developer prompts"),
      ("history", "Message history"),
      ("latest_user", "Latest user message"),
      ("tools", "Tool calls and results"),
      ("metadata", "Token and capability metadata"),
    ]
    let contextStack = NSStackView()
    contextStack.orientation = .vertical
    contextStack.alignment = .leading
    contextStack.spacing = 4
    for (key, title) in contextChoices {
      let button = NSButton(checkboxWithTitle: title, target: self, action: #selector(valueChanged))
      button.identifier = NSUserInterfaceItemIdentifier(key)
      button.state = .on
      contextStack.addArrangedSubview(button)
      contextButtons.append(button)
    }

    scopePopup.addItems(withTitles: ["user_turn", "conversation"])
    scopePopup.selectItem(withTitle: "user_turn")
    scopePopup.target = self
    scopePopup.action = #selector(valueChanged)

    for field in [timeoutField, retryCountField, retryDelayField] {
      field.delegate = self
      field.alignment = .right
    }

    let form = NSStackView()
    form.orientation = .vertical
    form.alignment = .leading
    form.spacing = 12
    form.addArrangedSubview(row("Name", nameField))
    form.addArrangedSubview(row("Candidate models", candidateScroll, alignTop: true))
    form.addArrangedSubview(row("Fallback model", fallbackPopup))
    form.addArrangedSubview(row("Selector model", selectorPopup))
    form.addArrangedSubview(row("Selector prompt", promptScroll, alignTop: true))
    form.addArrangedSubview(row("Selector context", contextStack, alignTop: true))
    form.addArrangedSubview(row("Scope", scopePopup))
    form.addArrangedSubview(row("Timeout (seconds)", timeoutField))

    let retryFields = NSStackView()
    retryFields.orientation = .horizontal
    retryFields.spacing = 8
    retryCountField.widthAnchor.constraint(equalToConstant: 70).isActive = true
    retryDelayField.widthAnchor.constraint(equalToConstant: 90).isActive = true
    retryFields.addArrangedSubview(retryCountField)
    retryFields.addArrangedSubview(NSTextField(labelWithString: "retries,"))
    retryFields.addArrangedSubview(retryDelayField)
    retryFields.addArrangedSubview(NSTextField(labelWithString: "ms between retries"))
    form.addArrangedSubview(row("Retries", retryFields))

    errorLabel.textColor = .systemRed
    errorLabel.lineBreakMode = .byWordWrapping
    errorLabel.maximumNumberOfLines = 2
    errorLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
    cancelButton.keyEquivalent = "\u{1b}"
    saveButton.target = self
    saveButton.action = #selector(save)
    saveButton.keyEquivalent = "\r"
    saveButton.isEnabled = false
    let actions = NSStackView(views: [errorLabel, cancelButton, saveButton])
    actions.orientation = .horizontal
    actions.spacing = 10
    errorLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true

    let content = NSStackView(views: [form, actions])
    content.orientation = .vertical
    content.spacing = 16
    content.translatesAutoresizingMaskIntoConstraints = false
    content.alignment = .trailing
    window.contentView?.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
      content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20),
      content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
      content.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -20),
      form.widthAnchor.constraint(equalTo: content.widthAnchor),
      actions.widthAnchor.constraint(equalTo: content.widthAnchor),
    ])
  }

  private func row(_ title: String, _ control: NSView, alignTop: Bool = false) -> NSStackView {
    let label = NSTextField(labelWithString: title)
    label.alignment = .right
    label.widthAnchor.constraint(equalToConstant: 140).isActive = true
    let row = NSStackView(views: [label, control])
    row.orientation = .horizontal
    row.alignment = alignTop ? .top : .centerY
    row.spacing = 10
    control.widthAnchor.constraint(greaterThanOrEqualToConstant: 480).isActive = true
    return row
  }

  @objc private func valueChanged() { updateValidation() }
  func controlTextDidChange(_ obj: Notification) { updateValidation() }
  func textDidChange(_ notification: Notification) {
    promptView.needsDisplay = true
    updateValidation()
  }

  private func canonicalSlug(_ value: String) -> String? {
    var name = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if name.hasPrefix("hydra/") { name.removeFirst("hydra/".count) }
    name = name.replacingOccurrences(of: "[^a-z0-9._-]+", with: "-", options: .regularExpression)
    name = name.replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
    name = name.replacingOccurrences(of: "^[._-]+|[._-]+$", with: "", options: .regularExpression)
    return name.isEmpty ? nil : "hydra/\(name)"
  }

  private func nonnegativeNumber(_ field: NSTextField, integer: Bool) -> Bool {
    guard let value = Double(field.stringValue), value >= 0 else { return false }
    return !integer || value.rounded() == value
  }

  private func updateValidation() {
    let slug = canonicalSlug(nameField.stringValue)
    let valid = slug != nil
      && !existingSlugs.contains(slug!)
      && candidateButtons.contains(where: { $0.state == .on })
      && fallbackPopup.selectedItem?.representedObject is String
      && selectorPopup.selectedItem?.representedObject is String
      && !promptView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && contextButtons.contains(where: { $0.state == .on })
      && nonnegativeNumber(timeoutField, integer: false)
      && nonnegativeNumber(retryCountField, integer: true)
      && nonnegativeNumber(retryDelayField, integer: true)
    saveButton.isEnabled = valid && pendingRequestID == nil
    if let slug, existingSlugs.contains(slug) {
      errorLabel.stringValue = "A synthetic model named \(slug) already exists."
    } else if pendingRequestID == nil && errorLabel.stringValue.hasPrefix("A synthetic model named") {
      errorLabel.stringValue = ""
    }
  }

  @objc private func cancel() {
    guard pendingRequestID == nil else { return }
    NSApp.stopModal(withCode: .cancel)
    window.orderOut(nil)
  }

  @objc private func save() {
    updateValidation()
    guard saveButton.isEnabled,
      let fallbackModel = fallbackPopup.selectedItem?.representedObject as? String,
      let selectorModel = selectorPopup.selectedItem?.representedObject as? String
    else { return }
    errorLabel.stringValue = ""
    let requestID = UUID().uuidString
    pendingRequestID = requestID
    saveButton.isEnabled = false
    let payload: [String: Any] = [
      "name": nameField.stringValue,
      "candidates": candidateButtons.filter { $0.state == .on }.compactMap { $0.identifier?.rawValue },
      "fallbackModel": fallbackModel,
      "selectorModel": selectorModel,
      "selectorPrompt": promptView.string,
      "selectorContextParts": contextButtons.filter { $0.state == .on }.compactMap { $0.identifier?.rawValue },
      "routingScope": scopePopup.titleOfSelectedItem ?? "user_turn",
      "timeoutSeconds": Double(timeoutField.stringValue) ?? 0,
      "retryCount": Int(retryCountField.stringValue) ?? 2,
      "retryDelayMs": Int(retryDelayField.stringValue) ?? 1000,
    ]
    submit(payload, requestID)
  }
}

final class HydraMenuDelegate: NSObject, NSApplicationDelegate {
  private var info: [String: Any]
  private var statusItem: NSStatusItem?
  private var newSyntheticController: NewSyntheticModelController?

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
    if id == "new_synthetic" {
      openNewSyntheticModel()
      return
    }
    if id == "open_config" {
      chooseApplicationAndOpenConfig()
      return
    }
    emit(["type": "action", "id": id])
  }

  private func openNewSyntheticModel() {
    guard newSyntheticController == nil else { return }
    let controller = NewSyntheticModelController(
      models: info["availableModels"] as? [[String: Any]] ?? [],
      existingSlugs: Set(info["existingSyntheticSlugs"] as? [String] ?? []),
      submit: { [weak self] model, requestID in
        self?.emit(["type": "create_synthetic", "requestId": requestID, "model": model])
      }
    )
    newSyntheticController = controller
    controller.run()
    newSyntheticController = nil
  }

  @objc private func revealFile(_ sender: NSMenuItem) {
    guard let filePath = sender.representedObject as? String else { return }
    let url = URL(fileURLWithPath: filePath)
    guard FileManager.default.fileExists(atPath: url.path) else {
      showError("Selector not found", detail: "No selector exists at \(url.path).")
      return
    }
    NSWorkspace.shared.activateFileViewerSelecting([url])
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
    case "reveal":
      let item = NSMenuItem(title: title, action: #selector(revealFile(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = statusItem["path"] as? String ?? ""
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

  private func emit(_ value: [String: Any]) {
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
        guard let data = line.data(using: .utf8),
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        DispatchQueue.main.async {
          if message["type"] as? String == "update", let nextInfo = message["info"] as? [String: Any] {
            self?.info = nextInfo
            self?.statusItem?.menu = self?.buildMenu()
          } else if message["type"] as? String == "create_synthetic_result" {
            self?.newSyntheticController?.handleResult(message)
          }
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
