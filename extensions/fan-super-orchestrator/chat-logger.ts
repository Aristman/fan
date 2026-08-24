// F-Diag: chat-logger — минимальная реализация (GREEN phase).
//
// Контракт (architecture.md §14 diagnostics):
//   formatSessionStart({ correlationId, role, roleProfile, depth, lineageLen }) → string
//   sendSessionStartMessage({ ...params, chatEmitter }) → string
//   formatHandlerEntry({ correlationId, packages, roleProfile? }) → string
//   logHandlerEntry({ ...params, chatEmitter }) → string

export interface SessionStartOpts {
	correlationId: string;
	role: "coordinator" | "super-orchestrator" | "orchestrator";
	roleProfile: string;
	depth: number;
	lineageLen: number;
	chatEmitter?: (msg: string) => void;
}

export function formatSessionStart(opts: SessionStartOpts): string {
	return `[${opts.correlationId}] ${opts.role}:${opts.roleProfile} initialized, depth=${opts.depth}, lineage_len=${opts.lineageLen}`;
}

export function sendSessionStartMessage(opts: SessionStartOpts): string {
	const msg = formatSessionStart(opts);
	console.log(
		`[${opts.correlationId}] ${opts.role}:${opts.roleProfile} initialized, depth=${opts.depth}, lineage_len=${opts.lineageLen}`,
	);
	if (opts.chatEmitter) {
		opts.chatEmitter(msg);
	}
	return msg;
}

export interface HandlerEntryOpts {
	correlationId: string;
	packages: number;
	roleProfile?: string;
	chatEmitter?: (msg: string) => void;
}

export function formatHandlerEntry(opts: HandlerEntryOpts): string {
	const profile = opts.roleProfile ?? "undefined";
	return `[handler:${opts.correlationId}] received packages=${opts.packages}, role_profile=${profile}`;
}

export function logHandlerEntry(opts: HandlerEntryOpts): string {
	const msg = formatHandlerEntry(opts);
	console.error(
		`[fan-super-orchestrator] delegate handler entered: corr=${opts.correlationId}, packages=${opts.packages}`,
	);
	if (opts.chatEmitter) {
		opts.chatEmitter(msg);
	}
	return msg;
}
