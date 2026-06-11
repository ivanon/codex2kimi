export type LogLevel = "debug" | "info" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, error: 2 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const line = JSON.stringify({ level: lvl, msg, ...fields });
    if (lvl === "error") console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
