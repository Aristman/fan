import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Mutex } from "./mutex.js";

/**
 * InMemoryMessageQueue — per-session FIFO message queue (F-2.4).
 *
 * Each `sessionId` owns an independent queue (`Array<QueuedMessage>`) guarded
 * by its own {@link Mutex}, so concurrent `enqueue`/`dequeue` calls from the
 * WebSocket handler (F-2.5) are async-safe and never corrupt the order.
 *
 * Semantics:
 * - FIFO: `dequeue()` returns messages in the exact order they were enqueued.
 * - Empty queue: `dequeue()` and `peek()` return `null` (documented contract).
 * - `peek()` reads the head WITHOUT removing it.
 * - `size()` returns the queue length for the session (0 if the session has
 *   no queue).
 *
 * Known limitations (MVP):
 * - **In-memory only**: all queued messages are LOST on server restart.
 *   Persistence is out of scope for MVP.
 *
 * Overflow protection (F-2.15):
 * - Each session's queue is capped at `maxSize` messages (default
 *   {@link DEFAULT_QUEUE_MAX_SIZE} = 50, configurable via the constructor).
 * - When the queue is full, `enqueue()` REJECTS the message and returns
 *   `null` (documented refusal contract — see the interface below). The
 *   WS dispatcher (F-2.5) translates this into a `queue_full` notification
 *   with error code `QUEUE_OVERFLOW`.
 */

/** A single queued message with its enqueue timestamp (ms since epoch). */
export interface QueuedMessage<T = unknown> {
	/** The raw message payload (WS message from the client). */
	message: T;
	/** Timestamp (Date.now()) when the message was enqueued. */
	timestamp: number;
	/** Monotonic global insertion counter — breaks timestamp ties so the
	 *  global dequeue order is a true FIFO even for same-millisecond enqueues. */
	seq: number;
}

/** Default per-session queue capacity (F-2.15). */
export const DEFAULT_QUEUE_MAX_SIZE = 50;

/** Options for {@link InMemoryMessageQueue}. */
export interface InMemoryMessageQueueOptions {
	/** Maximum number of queued messages per session (F-2.15).
	 *  `enqueue()` rejects (returns `null`) once this limit is reached.
	 *  Default: {@link DEFAULT_QUEUE_MAX_SIZE} (50). */
	maxSize?: number;
}

/** Message queue interface — per-session FIFO operations. */
export interface MessageQueue<T = unknown> {
	/** Append a message to the tail of the session's queue.
	 *  Returns the 1-based position of the message in the session's queue,
	 *  or `null` when the queue is full (overflow, F-2.15) and the message
	 *  was rejected. */
	enqueue(sessionId: string, message: T): Promise<number | null>;
	/** Remove and return the head message, or `null` if the queue is empty. */
	dequeue(sessionId: string): Promise<QueuedMessage<T> | null>;
	/** Return the head message WITHOUT removing it, or `null` if empty. */
	peek(sessionId: string): Promise<QueuedMessage<T> | null>;
	/** Number of queued messages for the session (0 if none). */
	size(sessionId: string): Promise<number>;
}

/**
 * Drainable message queue contract consumed by the WS dispatcher (F-2.5).
 *
 * Extends the per-session {@link MessageQueue} operations with the global
 * `dequeueOldest()` drain used by the dispatcher's background processor and
 * the `maxSize` capacity read for `queue_full` notifications. Both
 * {@link InMemoryMessageQueue} (F-2.4) and {@link PersistentMessageQueue}
 * (F-5.5) satisfy this contract, so the dispatcher can work with either
 * (drop-in).
 */
export interface DrainableMessageQueue<T = unknown> extends MessageQueue<T> {
	/** Remove and return the globally-oldest queued message across ALL
	 *  sessions (global FIFO by enqueue timestamp), or `null` when every
	 *  queue is empty. */
	dequeueOldest(): Promise<{ sessionId: string; item: QueuedMessage<T> } | null>;
	/** Per-session queue capacity (F-2.15). */
	readonly maxSize: number;
}

export class InMemoryMessageQueue<T = unknown> implements DrainableMessageQueue<T> {
	private readonly queues = new Map<string, Array<QueuedMessage<T>>>();
	private readonly mutexes = new Map<string, Mutex>();
	private seq = 0;

	/** Per-session queue capacity (F-2.15). Read by the WS dispatcher to
	 *  report the limit in `queue_full` notifications. */
	readonly maxSize: number;

	constructor(options: InMemoryMessageQueueOptions = {}) {
		const maxSize = options.maxSize ?? DEFAULT_QUEUE_MAX_SIZE;
		if (!Number.isInteger(maxSize) || maxSize < 1) {
			throw new Error(`InMemoryMessageQueue: maxSize must be a positive integer, got ${maxSize}`);
		}
		this.maxSize = maxSize;
	}

	/** Get (or lazily create) the mutex guarding the session's queue. */
	private mutexFor(sessionId: string): Mutex {
		let mutex = this.mutexes.get(sessionId);
		if (!mutex) {
			mutex = new Mutex();
			this.mutexes.set(sessionId, mutex);
		}
		return mutex;
	}

	/** Append `message` to the tail of the session's queue (FIFO).
	 *  Returns the 1-based position of the message in the session's queue.
	 *  Overflow (F-2.15): when the session's queue already holds `maxSize`
	 *  messages, the message is REJECTED (not stored) and `null` is
	 *  returned — callers must handle the refusal (the F-2.5 dispatcher
	 *  sends a `queue_full` notification in that case). */
	async enqueue(sessionId: string, message: T): Promise<number | null> {
		return this.mutexFor(sessionId).withLock(() => {
			let queue = this.queues.get(sessionId);
			if (!queue) {
				queue = [];
				this.queues.set(sessionId, queue);
			}
			if (queue.length >= this.maxSize) {
				return null;
			}
			queue.push({ message, timestamp: Date.now(), seq: this.seq++ });
			return queue.length;
		});
	}

	/** Remove and return the head of the session's queue, or `null` if empty. */
	async dequeue(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(() => {
			const queue = this.queues.get(sessionId);
			if (!queue || queue.length === 0) {
				return null;
			}
			const item = queue.shift() ?? null;
			// Housekeeping: drop the array once drained so the map does not
			// accumulate empty queues for long-lived servers. The mutex entry
			// is kept (it is cheap and avoids re-creation races).
			if (queue.length === 0) {
				this.queues.delete(sessionId);
			}
			return item;
		});
	}

	/** Return the head of the session's queue WITHOUT removing it, or `null` if empty. */
	async peek(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(() => {
			const queue = this.queues.get(sessionId);
			if (!queue || queue.length === 0) {
				return null;
			}
			return queue[0];
		});
	}

	/** Number of queued messages for the session (0 if the session has no queue). */
	async size(sessionId: string): Promise<number> {
		return this.mutexFor(sessionId).withLock(() => {
			return this.queues.get(sessionId)?.length ?? 0;
		});
	}

	/**
	 * Remove and return the globally-oldest queued message across ALL sessions
	 * (smallest insertion sequence wins — global FIFO). Returns `null` when
	 * every queue is empty.
	 *
	 * Added for F-2.5: the background dequeue processor in ws-handler drains
	 * queued messages in global FIFO-by-timestamp order (NOT per-session), so a
	 * message for project A enqueued before a message for project B is always
	 * executed first.
	 *
	 * Race-safety note: the head scan reads `this.queues` without holding every
	 * per-session mutex. This is safe for the intended usage because (a)
	 * concurrent `enqueue()` calls only APPEND — they never replace the head of
	 * a non-empty queue — and (b) the only concurrent dequeuer is the single
	 * drain loop in ws-handler, serialized by its `draining` flag. The actual
	 * removal is mutex-guarded via {@link dequeue}.
	 */
	async dequeueOldest(): Promise<{ sessionId: string; item: QueuedMessage<T> } | null> {
		let oldestSessionId: string | null = null;
		let oldestSeq = Number.POSITIVE_INFINITY;
		for (const [sessionId, queue] of this.queues) {
			if (queue.length > 0 && queue[0].seq < oldestSeq) {
				oldestSeq = queue[0].seq;
				oldestSessionId = sessionId;
			}
		}
		if (!oldestSessionId) return null;
		const item = await this.dequeue(oldestSessionId);
		return item ? { sessionId: oldestSessionId, item } : null;
	}
}

// ============================================================================
// PersistentMessageQueue (F-5.5)
// ============================================================================

/**
 * Default queue directory for {@link PersistentMessageQueue} (F-5.5):
 * `<agentDir>/queues`, where agentDir honors FAN_CODING_AGENT_DIR /
 * FAN_AGENT_DIR ("~" and "~/…" expanded) and falls back to `~/.fan/agent`
 * — the same resolution pattern as the project-budgets store (F-4.9) in
 * `http-server.ts`. Overridable via `PersistentMessageQueueOptions.queuesDir`
 * (tests / custom agent dirs).
 */
export function resolveQueuesDir(): string {
	const envDir = process.env.FAN_CODING_AGENT_DIR ?? process.env.FAN_AGENT_DIR;
	let agentDir: string;
	if (envDir !== undefined && envDir.trim().length > 0) {
		if (envDir === "~") agentDir = homedir();
		else if (envDir.startsWith("~/")) agentDir = resolvePath(homedir(), envDir.slice(2));
		else agentDir = envDir;
	} else {
		agentDir = resolvePath(homedir(), ".fan", "agent");
	}
	return join(agentDir, "queues");
}

/** On-disk JSONL entry format (F-5.5), one line per queued message:
 *  `{"sessionId":"clxxx","message":<payload>,"createdAt":"<ISO>","timestamp":<ms>,"priority":"normal"}` */
interface StoredQueueEntry {
	sessionId: string;
	message: unknown;
	/** ISO 8601 enqueue time (informational; `timestamp` is authoritative). */
	createdAt: string;
	/** Enqueue time in ms since epoch — FIFO ordering key. */
	timestamp: number;
	/** Reserved for future prioritization; currently always "normal". */
	priority: string;
}

/** Options for {@link PersistentMessageQueue}. */
export interface PersistentMessageQueueOptions {
	/** Directory holding `<sessionId>.queue.jsonl` files and `queue-index.json`.
	 *  Default: {@link resolveQueuesDir} (`<agentDir>/queues`). */
	queuesDir?: string;
	/** Maximum number of queued messages per session (F-2.15 semantics).
	 *  `enqueue()` rejects (returns `null`) once this limit is reached.
	 *  Default: {@link DEFAULT_QUEUE_MAX_SIZE} (50). */
	maxSize?: number;
	/** Number of I/O retries after the initial attempt before an operation
	 *  fails (F-5.5: "retry up to 3 times before failing"). Default: 3
	 *  (i.e. up to 4 attempts total). */
	maxRetries?: number;
	/** Delay between I/O retries (ms). Default: 25. */
	retryDelayMs?: number;
	/** Test hook: overrides the JSONL append operation (used to simulate I/O
	 *  failures for retry tests). Default: `fs.promises.appendFile`. */
	appendFn?: (filePath: string, line: string) => Promise<void>;
}

/** Map a sessionId to a safe file name component. Characters outside
 *  `[A-Za-z0-9._-]` are replaced with `_` (Windows-safe). Collisions between
 *  ids differing only in unsafe characters are accepted (session ids are
 *  generated, CUID-style). */
function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * PersistentMessageQueue — JSONL-file-backed per-session FIFO queue (F-5.5).
 *
 * Drop-in replacement for {@link InMemoryMessageQueue}: implements the same
 * {@link DrainableMessageQueue} contract consumed by the WS dispatcher
 * (enqueue/dequeue/peek/size/dequeueOldest + maxSize), plus
 * persistence-specific operations ({@link peekAll}, {@link clear},
 * {@link getAllActive}).
 *
 * Storage layout (under `queuesDir`, default `<agentDir>/queues`):
 * - `<sessionId>.queue.jsonl` — append-only log, one JSON entry per line
 *   (see {@link StoredQueueEntry}). FIFO order IS file order; `createdAt`/
 *   `timestamp` are the ordering keys after recovery.
 * - `queue-index.json` — `{ <sessionId>: boolean }` map of sessions with
 *   pending messages, for fast `getAllActive()` without scanning files.
 *   Written atomically (tmp file + rename). Missing/corrupted index reads
 *   as empty (treated as "no active queues"; the flag is re-set on the next
 *   enqueue, so a lost index never loses messages — files are the truth).
 *
 * Write design (documented decisions):
 * - **enqueue** = ensure dir → `appendFile` of one JSONL line → (on the
 *   inactive→active transition) atomic index update. The message is
 *   persisted BEFORE it becomes visible in memory, so a crash mid-enqueue
 *   never reports success for a message that is not durable.
 * - **dequeue** = atomic REWRITE of the queue file without the head line
 *   (tmp file + rename); when the queue drains, the file is deleted and the
 *   index flag flips to `false`. Cost: O(file size) per dequeue — bounded
 *   by `maxSize` (default 50 entries), so the worst case is rewriting ~50
 *   short JSON lines. This keeps reads trivially consistent (the file
 *   always contains exactly the pending messages) and avoids a separate
 *   compaction pass. Chosen over append+tombstone compaction because the
 *   queue depth is small and rewrite is atomic and crash-safe.
 * - **Recovery**: entries are loaded lazily from disk on first access, so a
 *   fresh instance (server restart) transparently sees all pending
 *   messages left by a previous process (TC-F-5.5-3).
 *
 * Concurrency: per-session {@link Mutex} (F-2.3) guards each queue; a
 * separate mutex guards index updates (lock order is always session →
 * index, never reversed, so no deadlock). Within a single process this,
 * plus atomic tmp+rename for rewrites, makes all file operations safe.
 * Cross-process safety is NOT provided (single-server architecture).
 *
 * I/O errors: every mutating file operation is retried up to `maxRetries`
 * times (default 3) with `retryDelayMs` between attempts. After the last
 * retry the operation THROWS — for `enqueue` this means the error
 * propagates to the caller instead of being mistaken for an overflow
 * refusal (`null` is reserved for the F-2.15 overflow contract only).
 * Malformed JSONL lines encountered during load are logged and skipped.
 */
export class PersistentMessageQueue<T = unknown> implements DrainableMessageQueue<T> {
	private readonly queuesDir: string;
	private readonly cache = new Map<string, Array<QueuedMessage<T>>>();
	private readonly mutexes = new Map<string, Mutex>();
	private readonly indexMutex = new Mutex();
	/** Sessions whose index flag is known to be `true` on disk for THIS
	 *  instance — avoids re-writing the index on every enqueue while still
	 *  repairing a missing flag (e.g. corrupted index) on the first enqueue
	 *  after a restart. */
	private readonly indexEnsured = new Set<string>();
	private seq = 0;
	private tmpCounter = 0;
	private dirReady: Promise<void> | null = null;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly appendFn: (filePath: string, line: string) => Promise<void>;

	/** Per-session queue capacity (F-2.15). Read by the WS dispatcher to
	 *  report the limit in `queue_full` notifications. */
	readonly maxSize: number;

	constructor(options: PersistentMessageQueueOptions = {}) {
		const maxSize = options.maxSize ?? DEFAULT_QUEUE_MAX_SIZE;
		if (!Number.isInteger(maxSize) || maxSize < 1) {
			throw new Error(`PersistentMessageQueue: maxSize must be a positive integer, got ${maxSize}`);
		}
		this.maxSize = maxSize;
		this.queuesDir = options.queuesDir ?? resolveQueuesDir();
		this.maxRetries = options.maxRetries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 25;
		this.appendFn = options.appendFn ?? ((filePath, line) => appendFile(filePath, line, "utf-8"));
	}

	/** Get (or lazily create) the mutex guarding the session's queue. */
	private mutexFor(sessionId: string): Mutex {
		let mutex = this.mutexes.get(sessionId);
		if (!mutex) {
			mutex = new Mutex();
			this.mutexes.set(sessionId, mutex);
		}
		return mutex;
	}

	private filePathFor(sessionId: string): string {
		return join(this.queuesDir, `${sanitizeSessionId(sessionId)}.queue.jsonl`);
	}

	private get indexPath(): string {
		return join(this.queuesDir, "queue-index.json");
	}

	/** Create queuesDir once (lazily). A failure resets the cached promise so
	 *  the next retry re-attempts the mkdir. */
	private ensureDir(): Promise<void> {
		if (!this.dirReady) {
			this.dirReady = mkdir(this.queuesDir, { recursive: true }).then(
				() => undefined,
				(err) => {
					this.dirReady = null;
					throw err;
				},
			);
		}
		return this.dirReady;
	}

	/** Run `op` with I/O retry: up to `maxRetries` retries after the initial
	 *  attempt, then rethrow (logged). */
	private async withRetry<R>(op: () => Promise<R>, what: string): Promise<R> {
		let attempt = 0;
		for (;;) {
			try {
				return await op();
			} catch (err) {
				attempt++;
				// Durability: an ENOENT means the queues directory (or a parent)
				// vanished at runtime — the cached ensureDir() promise is stale,
				// so retrying the same operation could never succeed. Drop the
				// cache; the next attempt re-creates the directory (mkdir -p)
				// instead of failing all retries with the same ENOENT.
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					this.dirReady = null;
				}
				if (attempt > this.maxRetries) {
					console.error(`[PersistentMessageQueue] ${what} failed after ${attempt} attempts:`, err);
					throw err;
				}
				if (this.retryDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
				}
			}
		}
	}

	/** Serialize in-memory entries back to JSONL (lossless: createdAt is
	 *  derived from the stored ms timestamp). */
	private serializeEntries(sessionId: string, entries: Array<QueuedMessage<T>>): string {
		return entries
			.map((e) => {
				const stored: StoredQueueEntry = {
					sessionId,
					message: e.message,
					createdAt: new Date(e.timestamp).toISOString(),
					timestamp: e.timestamp,
					priority: "normal",
				};
				return JSON.stringify(stored);
			})
			.join("\n")
			.concat("\n");
	}

	/** Atomic file write: tmp file + rename (crash-safe).
	 *
	 * F-5.5 safety: if the rename fails, the temporary file is removed
	 * best-effort before the error propagates so the queues directory does
	 * not leak `.tmp-<pid>-<n>` files. */
	private async writeFileAtomic(filePath: string, data: string): Promise<void> {
		await this.ensureDir();
		const tmpPath = `${filePath}.tmp-${process.pid}-${this.tmpCounter++}`;
		try {
			await writeFile(tmpPath, data, "utf-8");
			await rename(tmpPath, filePath);
		} catch (err) {
			await rm(tmpPath, { force: true }).catch(() => {});
			throw err;
		}
	}

	/** Load (once per instance) the session's entries from disk; returns the
	 *  live in-memory array. Malformed lines are logged and skipped. */
	private async loadSession(sessionId: string): Promise<Array<QueuedMessage<T>>> {
		const cached = this.cache.get(sessionId);
		if (cached) return cached;

		const entries: Array<QueuedMessage<T>> = [];
		try {
			const raw = await readFile(this.filePathFor(sessionId), "utf-8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const stored = JSON.parse(trimmed) as StoredQueueEntry;
					entries.push({
						message: stored.message as T,
						timestamp: stored.timestamp ?? (Date.parse(stored.createdAt) || 0),
						seq: this.seq++,
					});
				} catch {
					console.error(`[PersistentMessageQueue] skipping malformed line in ${this.filePathFor(sessionId)}`);
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		this.cache.set(sessionId, entries);
		return entries;
	}

	private async readIndex(): Promise<Record<string, boolean>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.indexPath, "utf-8"));
			if (parsed !== null && typeof parsed === "object") {
				return parsed as Record<string, boolean>;
			}
			return {};
		} catch {
			// Missing/corrupted index → empty (files remain the truth; the flag
			// is re-set on the next enqueue for the session).
			return {};
		}
	}

	/** Set the session's active flag in queue-index.json (atomic tmp+rename,
	 *  serialized by a dedicated index mutex). */
	private async setIndexFlag(sessionId: string, active: boolean): Promise<void> {
		await this.indexMutex.withLock(async () => {
			await this.withRetry(async () => {
				await this.ensureDir();
				const index = await this.readIndex();
				index[sessionId] = active;
				await this.writeFileAtomic(this.indexPath, JSON.stringify(index, null, 2));
			}, `index update (${sessionId}=${active})`);
		});
	}

	/** Append `message` durably (JSONL) and to the in-memory queue (FIFO).
	 *  Returns the 1-based position in the session's queue, or `null` on
	 *  overflow (F-2.15 semantics — same refusal contract as the in-memory
	 *  queue). I/O failure after retries THROWS (never reported as overflow). */
	async enqueue(sessionId: string, message: T): Promise<number | null> {
		return this.mutexFor(sessionId).withLock(async () => {
			const entries = await this.loadSession(sessionId);
			if (entries.length >= this.maxSize) {
				return null;
			}
			const now = Date.now();
			const stored: StoredQueueEntry = {
				sessionId,
				message,
				createdAt: new Date(now).toISOString(),
				timestamp: now,
				priority: "normal",
			};
			// Persist FIRST: the message is queued only once it is durable.
			await this.withRetry(async () => {
				await this.ensureDir();
				await this.appendFn(this.filePathFor(sessionId), `${JSON.stringify(stored)}\n`);
			}, `enqueue(${sessionId})`);

			entries.push({ message, timestamp: now, seq: this.seq++ });

			// Index flip on the inactive → active transition, or on the first
			// enqueue of this instance when the flag's on-disk state is unknown
			// (repairs a lost/corrupted index — files remain the truth).
			if (entries.length === 1 || !this.indexEnsured.has(sessionId)) {
				await this.setIndexFlag(sessionId, true);
				this.indexEnsured.add(sessionId);
			}
			return entries.length;
		});
	}

	/** Remove and return the head message, or `null` if empty. Removes the
	 *  head line from disk via an atomic rewrite of the file without it
	 *  (O(file size) per dequeue — see the class docblock for the documented
	 *  cost/design trade-off); deletes the file and flips the index flag when
	 *  the queue drains. */
	async dequeue(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(async () => {
			const entries = await this.loadSession(sessionId);
			if (entries.length === 0) {
				return null;
			}
			const head = entries.shift() as QueuedMessage<T>;
			if (entries.length === 0) {
				await this.withRetry(() => rm(this.filePathFor(sessionId), { force: true }), `dequeue(${sessionId})`);
				await this.setIndexFlag(sessionId, false);
			} else {
				await this.withRetry(
					() => this.writeFileAtomic(this.filePathFor(sessionId), this.serializeEntries(sessionId, entries)),
					`dequeue(${sessionId})`,
				);
			}
			return head;
		});
	}

	/** Return the head message WITHOUT removing it, or `null` if empty. */
	async peek(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(async () => {
			const entries = await this.loadSession(sessionId);
			return entries.length === 0 ? null : entries[0];
		});
	}

	/** Number of queued messages for the session (0 if none). */
	async size(sessionId: string): Promise<number> {
		return this.mutexFor(sessionId).withLock(async () => {
			return (await this.loadSession(sessionId)).length;
		});
	}

	/** F-5.5: all pending messages for the session, in FIFO order, WITHOUT
	 *  removing them (used to report recovered queues after a restart). */
	async peekAll(sessionId: string): Promise<Array<QueuedMessage<T>>> {
		return this.mutexFor(sessionId).withLock(async () => {
			return [...(await this.loadSession(sessionId))];
		});
	}

	/** F-5.5: remove ALL pending messages for the session — deletes the JSONL
	 *  file and flips the index flag to `false`. */
	async clear(sessionId: string): Promise<void> {
		return this.mutexFor(sessionId).withLock(async () => {
			const entries = await this.loadSession(sessionId);
			entries.length = 0;
			await this.withRetry(() => rm(this.filePathFor(sessionId), { force: true }), `clear(${sessionId})`);
			await this.setIndexFlag(sessionId, false);
		});
	}

	/** Scan the queues directory and recover active session ids from the
	 *  JSONL files themselves. The first valid line in each
	 *  `<sessionId>.queue.jsonl` file yields the original session id, so even
	 *  sanitized file names map back correctly. */
	private async scanActiveSessions(): Promise<Set<string>> {
		const active = new Set<string>();
		const files = await readdir(this.queuesDir).catch(() => [] as string[]);
		for (const file of files) {
			if (!file.endsWith(".queue.jsonl")) continue;
			const filePath = join(this.queuesDir, file);
			try {
				const raw = await readFile(filePath, "utf-8");
				for (const line of raw.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const stored = JSON.parse(trimmed) as StoredQueueEntry;
						if (stored.sessionId) {
							active.add(stored.sessionId);
							break;
						}
					} catch {
						// skip malformed line
					}
				}
			} catch {
				// ignore unreadable files
			}
		}
		return active;
	}

	/** F-5.5 index repair: synchronize queue-index.json with the actual
	 *  *.queue.jsonl files on disk. Adds missing active flags, removes stale
	 *  true flags for sessions whose queue file is missing or empty, and
	 *  recovers from a missing/corrupted index by rebuilding it from files.
	 *  The repair is serialized by the index mutex. */
	private async repairIndex(): Promise<string[]> {
		const activeFromFiles = await this.scanActiveSessions();
		await this.indexMutex.withLock(async () => {
			await this.withRetry(async () => {
				await this.ensureDir();
				const index = await this.readIndex();
				let changed = false;
				for (const sessionId of activeFromFiles) {
					if (index[sessionId] !== true) {
						index[sessionId] = true;
						changed = true;
					}
				}
				for (const sessionId of Object.keys(index)) {
					if (index[sessionId] === true && !activeFromFiles.has(sessionId)) {
						index[sessionId] = false;
						changed = true;
					}
				}
				if (changed) {
					await this.writeFileAtomic(this.indexPath, JSON.stringify(index, null, 2));
				}
			}, "repairIndex");
		});
		for (const sessionId of activeFromFiles) {
			this.indexEnsured.add(sessionId);
		}
		return Array.from(activeFromFiles);
	}

	/** F-5.5: session ids with at least one pending message.
	 *
	 *  The result is reconciled against the actual `*.queue.jsonl` files, so a
	 *  missing/corrupted index or stale phantom flag never hides messages
	 *  from the global drain. */
	async getAllActive(): Promise<string[]> {
		await this.repairIndex();
		const index = await this.readIndex();
		return Object.entries(index)
			.filter(([, active]) => active)
			.map(([sessionId]) => sessionId);
	}

	/**
	 * Remove and return the globally-oldest queued message across ALL active
	 * sessions (global FIFO by enqueue timestamp — same contract as
	 * {@link InMemoryMessageQueue.dequeueOldest}). Loads every active session
	 * from disk first, so a fresh instance drains recovered messages too.
	 *
	 * Race-safety note: identical to the in-memory implementation — the head
	 * scan runs without holding every per-session mutex; safe because
	 * concurrent `enqueue()` calls only append and the single drain loop in
	 * ws-handler is serialized. The actual removal is mutex-guarded via
	 * {@link dequeue}.
	 */
	async dequeueOldest(): Promise<{ sessionId: string; item: QueuedMessage<T> } | null> {
		// Ensure every active session's head is visible (lazy disk load).
		for (const sessionId of await this.getAllActive()) {
			await this.mutexFor(sessionId).withLock(async () => {
				await this.loadSession(sessionId);
			});
		}
		let oldestSessionId: string | null = null;
		let oldestTimestamp = Number.POSITIVE_INFINITY;
		let oldestSeq = Number.POSITIVE_INFINITY;
		for (const [sessionId, entries] of this.cache) {
			if (entries.length === 0) continue;
			const head = entries[0];
			if (head.timestamp < oldestTimestamp || (head.timestamp === oldestTimestamp && head.seq < oldestSeq)) {
				oldestTimestamp = head.timestamp;
				oldestSeq = head.seq;
				oldestSessionId = sessionId;
			}
		}
		if (!oldestSessionId) return null;
		const item = await this.dequeue(oldestSessionId);
		return item ? { sessionId: oldestSessionId, item } : null;
	}
}
