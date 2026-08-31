#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DDGR_SHA256 = "98a8e06d283e58e676afa68daa686e6e6204f4132b2858084aef136c3dfcd28f";

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected a numeric semver version, received: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function artifactName(version, arch, release) {
  return `Hydra-${version}${release ? "" : "-dev"}-${arch}.dmg`;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function verifySha256(filePath, expected) {
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expected}, received ${actual}`);
}

function bumpVersion() {
  const packagePath = path.join(repoDir, "package.json");
  const lockPath = path.join(repoDir, "package-lock.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const lockJson = JSON.parse(readFileSync(lockPath, "utf8"));
  const version = nextPatchVersion(packageJson.version);
  packageJson.version = version;
  lockJson.version = version;
  lockJson.packages[""].version = version;
  writeJson(packagePath, packageJson);
  writeJson(lockPath, lockJson);
  return version;
}

export function releaseGitCommands(version) {
  return [
    ["add", "--", "package.json", "package-lock.json"],
    ["commit", "-m", `Release v${version}`],
    ["push"],
  ];
}

function ensureCleanReleaseTree() {
  const status = commandOutput("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoDir });
  if (status) throw new Error("Release builds require a clean Git worktree. Commit or stash changes first.");
}

function commitAndPushVersion(version) {
  for (const [command, ...args] of releaseGitCommands(version)) {
    run("git", [command, ...args], { cwd: repoDir });
  }
}

export function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Hydra</string>
  <key>CFBundleExecutable</key><string>Hydra</string>
  <key>CFBundleIconFile</key><string>Hydra</string>
  <key>CFBundleIdentifier</key><string>com.sdgandhi.hydra</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Hydra</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>HydraDebugLogging</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

function createIcon(source, output) {
  run("/usr/bin/sips", ["-s", "format", "icns", source, "--out", output]);
}

function sign(target, { identity, release, entitlements, hardened = release }) {
  const args = ["--force", "--sign", identity];
  if (hardened) args.push("--options", "runtime");
  if (release) args.push("--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  run("/usr/bin/codesign", args);
}

export function buildMacDmg({ release = false } = {}) {
  if (process.platform !== "darwin") throw new Error("Hydra DMGs can only be built on macOS.");
  const identity = process.env.HYDRA_SIGNING_IDENTITY || "-";
  const adHoc = identity === "-";
  if (release && adHoc && process.env.HYDRA_NOTARY_PROFILE) {
    throw new Error("Ad-hoc release builds cannot be notarized; unset HYDRA_NOTARY_PROFILE or provide a Developer ID identity.");
  }
  const distributionSigning = release && !adHoc;

  if (release) ensureCleanReleaseTree();

  const packageJson = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf8"));
  const version = release ? bumpVersion() : packageJson.version;
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  const target = `${arch}-apple-macosx13.0`;
  const distDir = path.join(repoDir, "dist");
  const buildDir = path.join(distDir, "build-macos");
  const appDir = path.join(buildDir, "Hydra.app");
  const contentsDir = path.join(appDir, "Contents");
  const macOSDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const binDir = path.join(resourcesDir, "bin");
  const licensesDir = path.join(resourcesDir, "licenses");
  const bundledAppDir = path.join(resourcesDir, "app");
  const dmgRoot = path.join(buildDir, "dmg-root");
  const dmgPath = path.join(distDir, artifactName(version, arch, release));
  const entitlements = path.join(repoDir, "macos/Hydra.entitlements");

  rmSync(buildDir, { recursive: true, force: true });
  rmSync(dmgPath, { force: true });
  mkdirSync(macOSDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });
  mkdirSync(bundledAppDir, { recursive: true });
  const moduleCache = path.join(buildDir, "module-cache");
  mkdirSync(moduleCache, { recursive: true });
  process.env.CLANG_MODULE_CACHE_PATH = moduleCache;
  process.env.SWIFT_MODULECACHE_PATH = moduleCache;

  run("/usr/bin/swiftc", ["-O", "-target", target, path.join(repoDir, "macos/HydraLauncher.swift"), "-o", path.join(macOSDir, "Hydra")]);
  run("/usr/bin/swiftc", ["-O", "-target", target, path.join(repoDir, "src/menubar.swift"), "-o", path.join(binDir, "HydraMenuBar")]);
  cpSync(process.execPath, path.join(binDir, "node"));
  const nodeLicense = path.resolve(path.dirname(process.execPath), "../LICENSE");
  if (!existsSync(nodeLicense)) throw new Error(`Could not find the bundled Node license at ${nodeLicense}.`);
  cpSync(nodeLicense, path.join(licensesDir, "Node-LICENSE"));
  cpSync(path.join(repoDir, "src"), path.join(bundledAppDir, "src"), { recursive: true });
  cpSync(path.join(repoDir, "package.json"), path.join(bundledAppDir, "package.json"));
  const ddgrSource = path.join(repoDir, "vendor/ddgr/ddgr");
  verifySha256(ddgrSource, DDGR_SHA256);
  cpSync(path.join(repoDir, "vendor/ddgr"), path.join(bundledAppDir, "vendor/ddgr"), { recursive: true });
  chmodSync(path.join(bundledAppDir, "vendor/ddgr/ddgr"), 0o755);
  cpSync(path.join(repoDir, "vendor/ddgr/LICENSE"), path.join(licensesDir, "ddgr-LICENSE"));
  const dependencyDir = path.join(repoDir, "node_modules/smol-toml");
  if (!existsSync(dependencyDir)) throw new Error("Run npm ci before building the macOS app.");
  mkdirSync(path.join(bundledAppDir, "node_modules"), { recursive: true });
  cpSync(dependencyDir, path.join(bundledAppDir, "node_modules/smol-toml"), { recursive: true });
  cpSync(path.join(dependencyDir, "LICENSE"), path.join(licensesDir, "smol-toml-LICENSE"));
  writeFileSync(path.join(contentsDir, "Info.plist"), infoPlist(version));
  createIcon(path.join(repoDir, "src/hydra-menubar.png"), path.join(resourcesDir, "Hydra.icns"));

  sign(path.join(binDir, "node"), { identity, release: distributionSigning, entitlements });
  sign(path.join(binDir, "HydraMenuBar"), { identity, release: distributionSigning });
  sign(path.join(macOSDir, "Hydra"), { identity, release: distributionSigning });
  sign(appDir, { identity, release: distributionSigning });
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appDir]);

  mkdirSync(dmgRoot, { recursive: true });
  cpSync(appDir, path.join(dmgRoot, "Hydra.app"), { recursive: true });
  symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
  run("/usr/bin/hdiutil", ["create", "-volname", "Hydra", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
  sign(dmgPath, { identity, release: distributionSigning, hardened: false });
  run("/usr/bin/codesign", ["--verify", "--verbose=2", dmgPath]);

  if (release && process.env.HYDRA_NOTARY_PROFILE) {
    run("/usr/bin/xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", process.env.HYDRA_NOTARY_PROFILE, "--wait"]);
    run("/usr/bin/xcrun", ["stapler", "staple", dmgPath]);
  }

  if (release) commitAndPushVersion(version);

  console.log(`Built ${dmgPath}`);
  console.log(`Version: ${version}`);
  console.log(`Signature: ${adHoc ? "ad-hoc (not notarizable)" : identity}`);
  return { appDir, dmgPath, version, arch };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--release") && args.has("--dev")) throw new Error("Choose either --release or --dev.");
  buildMacDmg({ release: args.has("--release") });
}
