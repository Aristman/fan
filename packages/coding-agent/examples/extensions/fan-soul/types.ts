export type FactCategory = "preference" | "decision" | "instruction" | "context";
export type FactSignificance = "trivial" | "substantial";
export type UserSectionName = "profile" | "context" | "preferences" | "projects";

export interface Fact {
	content: string;
	category: FactCategory;
	tags: string[];
	section: UserSectionName;
}

export type DraftStatus = "pending" | "approved" | "rejected";

export interface DraftEntry {
	id: string;
	fact: Fact;
	status: DraftStatus;
	createdAt: number;
	expiresAt: number;
}

export interface UserSection {
	name: UserSectionName;
	marker: string;
	content: string;
}

export type MergeAction = "append" | "replace" | "remove";

export type SoulFileKey = "soul" | "user";
