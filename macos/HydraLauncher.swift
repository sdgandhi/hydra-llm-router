import AppKit
import Foundation

func fail(_ message: String) -> Never {
  let alert = NSAlert()
  alert.messageText = "Hydra could not start"
  alert.informativeText = message
  alert.alertStyle = .critical
  alert.runModal()
  exit(1)
}

guard let resourcesURL = Bundle.main.resourceURL else {
  fail("The app bundle has no Resources directory.")
}

let fileManager = FileManager.default
let appURL = resourcesURL.appendingPathComponent("app", isDirectory: true)
let nodeURL = resourcesURL.appendingPathComponent("bin/node")
let menuBarURL = resourcesURL.appendingPathComponent("bin/HydraMenuBar")
let cliURL = appURL.appendingPathComponent("src/cli.js")
let hydraURL = fileManager.homeDirectoryForCurrentUser
  .appendingPathComponent(".hydra", isDirectory: true)

do {
  try fileManager.createDirectory(at: hydraURL, withIntermediateDirectories: true)
} catch {
  fail("Could not create \(hydraURL.path): \(error.localizedDescription)")
}

let logURL = hydraURL.appendingPathComponent("launcher.log")
if !fileManager.fileExists(atPath: logURL.path) {
  fileManager.createFile(atPath: logURL.path, contents: nil)
}

guard let logHandle = try? FileHandle(forWritingTo: logURL) else {
  fail("Could not open \(logURL.path).")
}
_ = try? logHandle.seekToEnd()

let process = Process()
process.executableURL = nodeURL
process.currentDirectoryURL = appURL
process.arguments = [cliURL.path, "serve"]
if Bundle.main.object(forInfoDictionaryKey: "HydraDebugLogging") as? Bool == true {
  process.arguments?.append("--debug")
}

var environment = ProcessInfo.processInfo.environment
environment["HYDRA_MENUBAR_BIN"] = menuBarURL.path
let extraPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
environment["PATH"] = [environment["PATH"], extraPath].compactMap { $0 }.joined(separator: ":")
process.environment = environment
process.standardOutput = logHandle
process.standardError = logHandle
process.terminationHandler = { child in
  try? logHandle.close()
  exit(child.terminationStatus)
}

do {
  try process.run()
} catch {
  try? logHandle.close()
  fail("Could not launch the bundled router: \(error.localizedDescription)")
}

dispatchMain()
