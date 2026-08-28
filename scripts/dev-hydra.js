#!/usr/bin/env node
import process from "node:process";
import {
  developmentEnvironment,
  developmentPaths,
  hydraDevelopmentArgs,
  requireDevelopmentSetup,
  spawnAndWait,
} from "./dev-context.js";

const commands = new Set(["serve", "stop", "refresh", "status", "models", "route", "prompt", "session"]);

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!commands.has(command)) {
    throw new Error("Usage: dev-hydra <serve|stop|refresh|status|models|route|prompt|session> [...args]");
  }
  const paths = developmentPaths();
  await requireDevelopmentSetup(paths);
  const extra = command === "serve" ? ["--debug", "--no-menubar", ...args] : args;
  return spawnAndWait(process.execPath, hydraDevelopmentArgs(paths, command, extra), {
    env: developmentEnvironment(paths),
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
