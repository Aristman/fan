// F-Diag: extension-health — минимальная реализация (GREEN phase).
//
// Контракт (architecture.md §14 diagnostics):
//   checkExtensionHealth({ extensionId, checks? }) → { healthy, message }
//   formatErrorReply({ correlationId, error, attemptedEscalationTo? }) → string

export interface ExtensionHealthOpts {
	extensionId: string;
	checks?: Array<() => void | Promise<void>>;
}

export interface ExtensionHealthResult {
	healthy: boolean;
	message?: string;
}

export function checkExtensionHealth(opts: ExtensionHealthOpts): ExtensionHealthResult {
	if (!opts.checks || opts.checks.length === 0) {
		return { healthy: true };
	}

	for (const check of opts.checks) {
		try {
			const result = check();
			if (result instanceof Promise) {
			}
		} catch (err) {
			return {
				healthy: false,
				message: `${opts.extensionId} не загрузился — проверьте ~/.fan/agent/extensions/${opts.extensionId}/: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return { healthy: true };
}

export interface ErrorReplyOpts {
	correlationId: string;
	error: string;
	attemptedEscalationTo?: string;
}

export function formatErrorReply(opts: ErrorReplyOpts): string {
	const escalation = opts.attemptedEscalationTo
		? `; attempted escalation to grandparent=${opts.attemptedEscalationTo}`
		: "";
	return `[${opts.correlationId}] delegation failed: ${opts.error}${escalation}`;
}
