import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATION_MODELS, VARIANTS } from "./variants.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const hydraHome = path.resolve((process.env.HYDRA_DEV_HOME ?? "~/.hydra-dev").replace(/^~/, homedir()));
const configPath = path.join(hydraHome, "config.toml");
const lmStudioUrl = process.env.HYDRA_BENCH_LMSTUDIO_URL ?? "http://127.0.0.1:11239";
const begin = "# BEGIN synthetic-selector-benchmark";
const end = "# END synthetic-selector-benchmark";

let config = await readFile(configPath, "utf8");
config = config.replace(new RegExp(`${begin}[\\s\\S]*?${end}\\n?`, "g"), "");
config = config.replace(
  /(\[providers\.lmstudio\][\s\S]*?\bbase_url\s*=\s*)"[^"]*"/,
  `$1${JSON.stringify(lmStudioUrl)}`,
);
const selectorPath = path.join(root, "selector.js");
const definitions = VARIANTS.map((variant) => `[synthetic_models."bench-${variant.id}"]
display_name = "Benchmark: ${variant.id}"
description = "Synthetic selector benchmark fixture."
selector = ${JSON.stringify(selectorPath)}
selector_model = ${JSON.stringify(variant.selectorModel)}
selector_context = ["system", "history", "latest_user", "tools", "metadata"]
candidates = [${JSON.stringify(GENERATION_MODELS.low)}, ${JSON.stringify(GENERATION_MODELS.medium)}]
fallback_model = ${JSON.stringify(GENERATION_MODELS.high)}
routing_scope = "user_turn"
sticky_tool_continuations = true
selector_timeout_ms = 60000
retry_count = 0
retry_delay_ms = 0`).join("\n\n");
config = `${config.trimEnd()}\n\n${begin}\n${definitions}\n${end}\n`;
await writeFile(configPath, config, { mode: 0o600 });
console.log(`Prepared ${VARIANTS.length} variants in ${configPath}`);
