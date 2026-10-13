type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}`;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) out(line, extra instanceof Error ? extra.stack ?? extra.message : extra);
  else out(line);
}

export function logger(scope: string) {
  return {
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
  };
}
