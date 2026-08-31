import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { artifactName, infoPlist, nextPatchVersion, releaseGitCommands } from "../scripts/build-macos.js";

test("macOS builds use patch versions and distinguish development artifacts", () => {
  assert.equal(nextPatchVersion("0.1.0"), "0.1.1");
  assert.equal(artifactName("0.1.0", "arm64", false), "Hydra-0.1.0-dev-arm64.dmg");
  assert.equal(artifactName("0.1.1", "arm64", true), "Hydra-0.1.1-arm64.dmg");
  assert.deepEqual(releaseGitCommands("0.1.1"), [
    ["add", "--", "package.json", "package-lock.json"],
    ["commit", "-m", "Release v0.1.1"],
    ["push"],
  ]);
});

test("the native macOS launcher replaces the Finder command file", async () => {
  await access(new URL("../macos/HydraLauncher.swift", import.meta.url));
  const buildSource = await readFile(new URL("../scripts/build-macos.js", import.meta.url), "utf8");
  const launcherSource = await readFile(new URL("../macos/HydraLauncher.swift", import.meta.url), "utf8");
  const menuSource = await readFile(new URL("../src/menubar.swift", import.meta.url), "utf8");
  assert.match(buildSource, /HYDRA_SIGNING_IDENTITY/);
  assert.match(buildSource, /ad-hoc \(not notarizable\)/);
  assert.match(buildSource, /Ad-hoc release builds cannot be notarized/);
  assert.match(buildSource, /vendor\/ddgr/);
  assert.match(buildSource, /DDGR_SHA256/);
  assert.match(buildSource, /HydraDebugLogging/);
  assert.match(buildSource, /ensureCleanReleaseTree\(\)/);
  assert.match(buildSource, /commitAndPushVersion\(version\)/);
  assert.match(infoPlist("0.1.0"), /<key>HydraDebugLogging<\/key><true\/>/);
  assert.match(launcherSource, /appendingPathComponent\("hydra\.log"\)/);
  assert.match(launcherSource, /HYDRA_LOG_STDERR/);
  assert.match(menuSource, /NSOpenPanel/);
  assert.match(menuSource, /withApplicationAt/);
  assert.match(menuSource, /Choose the lowest-numbered model/);
  assert.match(menuSource, /candidateOrder\.append/);
  assert.doesNotMatch(menuSource, /selectorContextParts/);
  await assert.rejects(access(new URL("../Hydra.command", import.meta.url)));
});
