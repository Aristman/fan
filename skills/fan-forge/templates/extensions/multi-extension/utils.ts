/**
 * Utils Module — Multi-File Extension Template
 *
 * Helper functions, types, and shared logic.
 */

export interface ProcessResult {
	success: boolean;
	message: string;
	timestamp: number;
}

/**
 * Process an item based on action.
 */
export function processItem(
	action: string,
	item: string,
	value?: string,
): ProcessResult {
	const timestamp = Date.now();

	switch (action) {
		case "create":
			return {
				success: true,
				message: `Created "${item}"${value ? ` with value "${value}"` : ""}`,
				timestamp,
			};
		case "update":
			return {
				success: true,
				message: `Updated "${item}"${value ? ` to "${value}"` : ""}`,
				timestamp,
			};
		case "delete":
			return {
				success: true,
				message: `Deleted "${item}"`,
				timestamp,
			};
		case "list":
			return {
				success: true,
				message: `Listing items (placeholder for "${item}")`,
				timestamp,
			};
		default:
			return {
				success: false,
				message: `Unknown action: ${action}`,
				timestamp,
			};
	}
}

/**
 * Format a process result for display.
 */
export function formatResult(result: ProcessResult): string {
	const status = result.success ? "✓" : "✗";
	return `${status} ${result.message}`;
}
