import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { artifactName, nextPatchVersion } from "../scripts/build-macos.js";

test("macOS builds use patch versions and distinguish development artifacts", () => {
  assert.equal(nextPatchVersion("0.1.0"), "0.1.1");
  assert.equal(artifactName("0.1.0", "arm64", false), "Hydra-0.1.0-dev-arm64.dmg");
  assert.equal(artifactName("0.1.1", "arm64", true), "Hydra-0.1.1-arm64.dmg");
});

test("the native macOS launcher replaces the Finder command file", async () => {
  await access(new URL("../macos/HydraLauncher.swift", import.meta.url));
  const buildSource = await readFile(new URL("../scripts/build-macos.js", import.meta.url), "utf8");
  assert.match(buildSource, /HYDRA_SIGNING_IDENTITY/);
  assert.match(buildSource, /HydraDebugLogging/);
  await assert.rejects(access(new URL("../Hydra.command", import.meta.url)));
});
