/**
 * Central timing instrumentation for startup profiling.
 * Enable with FAN_TIMING=1 environment variable.
 */

const ENABLED = process.env.FAN_TIMING === "1";
const timings: Array<{ label: string; ms: number; parallel: boolean }> = [];
let lastTime = Date.now();

export function resetTimings(): void {
	if (!ENABLED) return;
	timings.length = 0;
	lastTime = Date.now();
}

export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime, parallel: false });
	lastTime = now;
}

/**
 * Record a pre-measured duration (for use inside parallel branches
 * where calling time() would corrupt the sequential lastTime chain).
 */
export function timeWithDuration(label: string, ms: number, options?: { parallel?: boolean }): void {
	if (!ENABLED) return;
	timings.push({ label, ms, parallel: options?.parallel === true });
}

export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	const total = timings.reduce((a, b) => a + (b.parallel ? 0 : b.ms), 0);
	console.error(`  TOTAL: ${total}ms`);
	console.error("------------------------\n");
}
