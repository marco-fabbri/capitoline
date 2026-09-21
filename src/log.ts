import pino from "pino";
export type Logger = pino.Logger;

/**
 * The levels pino knows. A value outside this set makes `pino()` throw, which
 * on the host means the service crash-loops on a typo in the systemd
 * environment file instead of starting with less logging than asked for.
 */
const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/**
 * `dest` exists for the tests, which need to read the fallback warning back:
 * pino's default destination is file descriptor 1, not `process.stdout`.
 */
export function createLogger(name: string, dest?: pino.DestinationStream): Logger {
  // An unset or empty LOG_LEVEL is not a mistake (systemd writes an empty
  // value for `Environment=LOG_LEVEL=`); a non-empty unknown value is.
  const requested = process.env.LOG_LEVEL?.trim() ?? "";
  const invalid = requested !== "" && !LEVELS.has(requested);
  const level = invalid || requested === "" ? "info" : requested;
  const log = dest ? pino({ name, level }, dest) : pino({ name, level });
  if (invalid) log.warn({ requested }, `unknown LOG_LEVEL "${requested}", falling back to "info"`);
  return log;
}
