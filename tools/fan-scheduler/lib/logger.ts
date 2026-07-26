type LogLevel = "info" | "warn" | "error" | "debug";

/**
 * Minimal logger skeleton (F-4.1).
 * Structured JSON logging with LOG_LEVEL filtering lands in F-4.11.
 */
function write(level: LogLevel, message: string): void {
	const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

export const logger = {
	info: (message: string): void => write("info", message),
	warn: (message: string): void => write("warn", message),
	error: (message: string): void => write("error", message),
	debug: (message: string): void => write("debug", message),
};
