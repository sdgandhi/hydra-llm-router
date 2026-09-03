import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input_tokens: finiteNumber(value.input_tokens),
    cached_input_tokens: finiteNumber(value.cached_input_tokens),
    cache_write_input_tokens: finiteNumber(value.cache_write_input_tokens),
    output_tokens: finiteNumber(value.output_tokens),
    reasoning_output_tokens: finiteNumber(value.reasoning_output_tokens),
    total_tokens: finiteNumber(value.total_tokens),
  };
}

function occurredAt(record, fallback) {
  const candidates = [record?.timestamp, record?.payload?.completed_at, record?.payload?.started_at];
  for (const candidate of candidates) {
    if (candidate && !Number.isNaN(new Date(candidate).valueOf())) return new Date(candidate).toISOString();
  }
  return fallback;
}

function itemMetric(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type ?? "").toLowerCase();
  const base = {
    status: item.status ?? null,
    duration_ms: finiteNumber(item.duration_ms ?? item.durationMs ?? item.duration),
  };
  if (type === "commandexecution") {
    return { ...base, tool_type: "command_execution", exit_code: finiteNumber(item.exit_code ?? item.exitCode) };
  }
  if (type === "filechange") return { ...base, tool_type: "file_change" };
  if (type === "mcptoolcall") {
    return { ...base, tool_type: "mcp", server: item.server ?? null, tool: item.tool ?? null };
  }
  if (type === "dynamictoolcall") return { ...base, tool_type: "dynamic", tool: item.tool ?? null };
  if (type === "websearch") return { ...base, tool_type: "web_search" };
  return null;
}

export function createCodexFileContext(saved = {}) {
  return {
    sessionId: saved.sessionId ?? null,
    turnId: saved.turnId ?? null,
    model: saved.model ?? null,
    project: saved.project ?? null,
    cliVersion: saved.cliVersion ?? null,
  };
}

export function normalizeCodexRecord(record, context, { observedAt = new Date().toISOString(), eventId } = {}) {
  if (!record || typeof record !== "object") return [];
  const payload = record.payload ?? {};
  if (record.type === "session_meta") {
    context.sessionId = payload.session_id ?? payload.id ?? context.sessionId;
    context.cliVersion = payload.cli_version ?? context.cliVersion;
    context.project = typeof payload.cwd === "string" ? path.basename(payload.cwd) || null : context.project;
    return [];
  }
  if (record.type === "turn_context") {
    context.turnId = payload.turn_id ?? context.turnId;
    context.model = payload.model ?? context.model;
    return [];
  }
  if (record.type !== "event_msg") return [];

  const base = {
    eventId,
    source: "codex",
    observedAt,
    occurredAt: occurredAt(record, observedAt),
    sessionId: context.sessionId,
    turnId: payload.turn_id ?? context.turnId,
    completeness: "reconciled",
  };
  const common = { model: context.model, project: context.project, cli_version: context.cliVersion };

  if (payload.type === "task_started") {
    context.turnId = payload.turn_id ?? context.turnId;
    return [{
      ...base,
      turnId: context.turnId,
      type: "turn.started",
      data: {
        ...common,
        context_window: finiteNumber(payload.model_context_window),
        collaboration_mode: payload.collaboration_mode_kind ?? null,
      },
    }];
  }
  if (payload.type === "task_complete") {
    return [{
      ...base,
      type: "turn.completed",
      data: {
        ...common,
        status: payload.error ? "failed" : "completed",
        duration_ms: finiteNumber(payload.duration_ms),
        time_to_first_output_ms: finiteNumber(payload.time_to_first_token_ms),
        has_error: Boolean(payload.error),
      },
    }];
  }
  if (payload.type === "turn_aborted") {
    return [{
      ...base,
      type: "turn.completed",
      data: { ...common, status: "interrupted", duration_ms: finiteNumber(payload.duration_ms) },
    }];
  }
  if (payload.type === "token_count") {
    const last = tokenUsage(payload.info?.last_token_usage);
    if (!last) return [];
    return [{ ...base, type: "turn.usage", data: { ...common, ...last } }];
  }
  if (payload.type === "item_completed") {
    const metric = itemMetric(payload.item);
    if (!metric) return [];
    return [{ ...base, type: "tool.completed", data: { ...common, ...metric } }];
  }
  if (payload.type === "mcp_tool_call_end") {
    return [{
      ...base,
      type: "tool.completed",
      data: {
        ...common,
        tool_type: "mcp",
        tool: payload.action_name ?? null,
        status: payload.result?.isError ? "failed" : "completed",
        duration_ms: finiteNumber(payload.duration),
      },
    }];
  }
  if (payload.type === "patch_apply_end") {
    return [{
      ...base,
      type: "tool.completed",
      data: {
        ...common,
        tool_type: "file_change",
        status: payload.success ? "completed" : "failed",
      },
    }];
  }
  return [];
}

async function listJsonlFiles(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(target);
    }
  }
  await visit(root);
  return found.sort();
}

async function loadCursors(cursorPath) {
  try {
    return JSON.parse(await readFile(cursorPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, files: {} };
    return { version: 1, files: {} };
  }
}

async function saveCursors(cursorPath, cursors) {
  await mkdir(path.dirname(cursorPath), { recursive: true, mode: 0o700 });
  const temporary = `${cursorPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, cursorPath);
}

function lineEventId(context, offset, line) {
  return createHash("sha256").update(`${context.sessionId ?? "unknown"}:${offset}:`).update(line).digest("hex");
}

export function createCodexTailer({
  codexHome,
  cursorPath,
  store,
  pollIntervalMs = 2000,
  startAtEnd = true,
  since = null,
  clock = () => new Date(),
}) {
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  let cursors;
  let initialized = false;
  let scanning = null;
  let timer = null;
  const watchers = [];

  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      cursors ??= await loadCursors(cursorPath);
      const files = (await Promise.all(roots.map(listJsonlFiles))).flat();
      const existingByInode = new Map(
        Object.entries(cursors.files).map(([file, value]) => [String(value.inode ?? ""), { file, value }]),
      );
      for (const file of files) {
        const details = await stat(file);
        let saved = cursors.files[file];
        if (!saved && details.ino && existingByInode.has(String(details.ino))) {
          const moved = existingByInode.get(String(details.ino));
          saved = moved.value;
          delete cursors.files[moved.file];
          cursors.files[file] = saved;
        }
        if (!saved) {
          saved = {
            inode: details.ino,
            offset: startAtEnd && !initialized ? details.size : 0,
            ...createCodexFileContext(),
          };
          cursors.files[file] = saved;
        }
        if (details.size < saved.offset) saved.offset = 0;
        if (details.size === saved.offset) continue;

        const handle = await open(file, "r");
        try {
          const length = details.size - saved.offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, saved.offset);
          const lastNewline = buffer.lastIndexOf(0x0a);
          if (lastNewline < 0) continue;
          const complete = buffer.subarray(0, lastNewline + 1).toString("utf8");
          const context = createCodexFileContext(saved);
          let relativeOffset = 0;
          for (const raw of complete.split("\n")) {
            const bytes = Buffer.byteLength(raw) + 1;
            if (raw.trim()) {
              try {
                const record = JSON.parse(raw);
                const id = lineEventId(context, saved.offset + relativeOffset, raw);
                const events = normalizeCodexRecord(record, context, {
                  observedAt: clock().toISOString(),
                  eventId: id,
                });
                for (const event of events) {
                  if (since == null || new Date(event.occurredAt).valueOf() >= new Date(since).valueOf()) {
                    await store.emit(event);
                  }
                }
              } catch {
                // Skip malformed persisted records without blocking later lines.
              }
            }
            relativeOffset += bytes;
          }
          Object.assign(saved, context, { inode: details.ino, offset: saved.offset + lastNewline + 1 });
        } finally {
          await handle.close();
        }
      }
      initialized = true;
      await saveCursors(cursorPath, cursors);
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  function start() {
    if (timer) return;
    void scan();
    timer = setInterval(() => void scan(), pollIntervalMs);
    timer.unref?.();
    for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => void scan());
        watcher.on("error", () => {});
        watchers.push(watcher);
      } catch {
        // Polling remains the portable fallback when a directory is absent or unwatchable.
      }
    }
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const watcher of watchers.splice(0)) watcher.close();
    await scanning;
    await store.flush();
  }

  return { scan, start, stop };
}
