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

let logURL = hydraURL.appendingPathComponent("hydra.log")
let maxLogBytes: UInt64 = 100 * 1024 * 1024
if !fileManager.fileExists(atPath: logURL.path) {
  fileManager.createFile(atPath: logURL.path, contents: nil)
}

guard let logHandle = try? FileHandle(forWritingTo: logURL) else {
  fail("Could not open \(logURL.path).")
}

func appendToLog(_ data: Data) {
  let output = data.count > Int(maxLogBytes) ? Data(data.suffix(Int(maxLogBytes))) : data
  do {
    let offset = try logHandle.seekToEnd()
    if offset + UInt64(output.count) > maxLogBytes {
      try logHandle.truncate(atOffset: 0)
      try logHandle.seek(toOffset: 0)
    }
    try logHandle.write(contentsOf: output)
  } catch {
    // Logging must never prevent Hydra from running.
  }
}

let process = Process()
process.executableURL = nodeURL
process.currentDirectoryURL = appURL
process.arguments = [cliURL.path, "serve", "--debug"]

var environment = ProcessInfo.processInfo.environment
environment["HYDRA_MENUBAR_BIN"] = menuBarURL.path
environment["HYDRA_LOG_STDERR"] = "1"
let extraPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
environment["PATH"] = [environment["PATH"], extraPath].compactMap { $0 }.joined(separator: ":")
process.environment = environment
let logPipe = Pipe()
process.standardOutput = logPipe
process.standardError = logPipe

do {
  try process.run()
} catch {
  try? logHandle.close()
  fail("Could not launch the bundled router: \(error.localizedDescription)")
}

DispatchQueue.global(qos: .utility).async {
  while true {
    let data = logPipe.fileHandleForReading.availableData
    if data.isEmpty { break }
    appendToLog(data)
  }
  process.waitUntilExit()
  try? logHandle.close()
  exit(process.terminationStatus)
}

dispatchMain()
