import type { DraftEntry, DraftStatus, Fact } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DRAFTS = 10;

export class DraftQueue {
	private drafts: Map<string, DraftEntry> = new Map();

	add(fact: Fact): string {
		this.autoExpire();

		if (this.pendingCount >= MAX_DRAFTS) {
			const pending = this.listPending();
			if (pending.length > 0) {
				const oldest = pending[pending.length - 1];
				this.drafts.delete(oldest.id);
			}
		}

		const id = crypto.randomUUID();
		const entry: DraftEntry = {
			id,
			fact,
			status: "pending",
			createdAt: Date.now(),
			expiresAt: Date.now() + DEFAULT_TTL_MS,
		};
		this.drafts.set(id, entry);
		return id;
	}

	approve(id: string): Fact | null {
		const entry = this.drafts.get(id);
		if (!entry || entry.status !== "pending") return null;
		entry.status = "approved";
		return entry.fact;
	}

	reject(id: string): boolean {
		const entry = this.drafts.get(id);
		if (!entry || entry.status !== "pending") return false;
		entry.status = "rejected";
		return true;
	}

	listPending(): DraftEntry[] {
		this.autoExpire();
		return Array.from(this.drafts.values())
			.filter((d) => d.status === "pending")
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): DraftEntry | undefined {
		return this.drafts.get(id);
	}

	private autoExpire(): void {
		const now = Date.now();
		for (const [id, entry] of this.drafts) {
			if (entry.status === "pending" && entry.expiresAt <= now) {
				entry.status = "rejected";
			}
		}
	}

	get pendingCount(): number {
		return Array.from(this.drafts.values()).filter((d) => d.status === "pending").length;
	}

	get totalCount(): number {
		return this.drafts.size;
	}

	clear(): void {
		this.drafts.clear();
	}
}
