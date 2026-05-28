type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVELS) return LEVELS[env as Level];
  if (process.env.DEBUG) return LEVELS.debug;
  return LEVELS.warn;
}

const threshold = resolveThreshold();

function emit(level: Level, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold) return;
  let line = `[pdf-toolkit-mcp] ${level.toUpperCase()} ${message}`;
  if (meta !== undefined) {
    try {
      line += ` ${JSON.stringify(meta)}`;
    } catch {
      line += " [unserializable meta]";
    }
  }
  // CRITICAL: stderr ONLY. stdout is the MCP stdio transport channel; writing
  // there corrupts the protocol and crashes the client (CLAUDE.md Rule 1).
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
