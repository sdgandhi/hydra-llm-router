import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Finder launcher uses the supported debug flag", async () => {
  const source = await readFile(new URL("../Hydra.command", import.meta.url), "utf8");
  assert.match(source, /serve --debug --codex-bin/);
  assert.doesNotMatch(source, /--debug-auth/);
});
