import { describe, expect, it } from "vitest";
import {
	AUTONOMOUS_BRANCH_NAME_REGEX,
	AUTONOMOUS_BRANCH_POLICY,
	BRANCH_PREFIX,
	formatBranchTimestamp,
	generateBranchName,
	isValidBranchName,
	MAX_SLUG_LENGTH,
	PROTECTED_BRANCHES,
	sanitizeTaskId,
} from "./branch-policy.js";

/** Fixed clock: 2026-07-25 09:00:00 UTC → "20260725-090000". */
const fixedNow = () => new Date(Date.UTC(2026, 6, 25, 9, 0, 0));

describe("TC-F-4.7-1: branch name matches the naming convention", () => {
	it("generates fan-auto/<task-id>-<YYYYMMDD-HHmmss> for task.id='review-1'", () => {
		const name = generateBranchName({ id: "review-1" }, fixedNow);
		expect(name).toBe("fan-auto/review-1-20260725-090000");
		expect(name).toMatch(AUTONOMOUS_BRANCH_NAME_REGEX);
	});

	it("matches the regex for arbitrary task ids", () => {
		for (const id of ["review-1", "fix_bug.42", "nightly scan", "Über wichtig!"]) {
			expect(generateBranchName({ id }, fixedNow)).toMatch(AUTONOMOUS_BRANCH_NAME_REGEX);
		}
	});

	it("falls back to task.name when id is absent", () => {
		expect(generateBranchName({ name: "code-review" }, fixedNow)).toBe("fan-auto/code-review-20260725-090000");
	});

	it("accepts a raw string identifier", () => {
		expect(generateBranchName("review-1", fixedNow)).toBe("fan-auto/review-1-20260725-090000");
	});

	it("uses the current time by default and still matches the regex", () => {
		expect(generateBranchName({ id: "review-1" })).toMatch(AUTONOMOUS_BRANCH_NAME_REGEX);
	});
});

describe("TC-F-4.7-2: never targets main/master", () => {
	it.each(["merge", "fix-master", "main", "master", "MAIN", "Master"])(
		"task name '%s' produces a branch that is not main/master",
		(taskName) => {
			const branch = generateBranchName({ name: taskName }, fixedNow);
			expect(branch).not.toBe("main");
			expect(branch).not.toBe("master");
			expect(branch).toMatch(AUTONOMOUS_BRANCH_NAME_REGEX);
		},
	);

	it("a slug equal to a protected branch is prefixed with 'task-'", () => {
		expect(sanitizeTaskId("main")).toBe("task-main");
		expect(sanitizeTaskId("master")).toBe("task-master");
		expect(generateBranchName({ id: "main" }, fixedNow)).toBe("fan-auto/task-main-20260725-090000");
	});

	it("protected branch constants cover main and master", () => {
		expect(PROTECTED_BRANCHES).toContain("main");
		expect(PROTECTED_BRANCHES).toContain("master");
	});
});

describe("sanitization: dangerous characters", () => {
	it("replaces spaces and slashes with dashes", () => {
		expect(sanitizeTaskId("fix/master bug")).toBe("fix-master-bug");
		expect(generateBranchName({ name: "fix/master bug" }, fixedNow)).toBe("fan-auto/fix-master-bug-20260725-090000");
	});

	it("collapses runs of special characters into a single dash", () => {
		expect(sanitizeTaskId("a  --  b!!c")).toBe("a-b-c");
	});

	it("keeps underscores and alphanumerics, lowercases everything", () => {
		expect(sanitizeTaskId("Fix_Bug-42X")).toBe("fix_bug-42x");
	});

	it("trims dashes and underscores at the edges", () => {
		expect(sanitizeTaskId("--weird--name__")).toBe("weird-name");
	});

	it("converts unicode to ASCII (diacritics stripped, non-ASCII removed)", () => {
		expect(sanitizeTaskId("Über-café")).toBe("uber-cafe");
		expect(sanitizeTaskId("задача №7")).toBe("no7"); // № (U+2116) decomposes to "No" in NFKD
	});

	it("falls back to 'task' when nothing usable remains", () => {
		expect(sanitizeTaskId("!!!")).toBe("task");
		expect(sanitizeTaskId("")).toBe("task");
		expect(generateBranchName({}, fixedNow)).toBe("fan-auto/task-20260725-090000");
	});

	it("truncates very long identifiers to a valid slug", () => {
		const longName = `x${"a".repeat(200)}`;
		const slug = sanitizeTaskId(longName);
		expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
		expect(generateBranchName({ name: longName }, fixedNow)).toMatch(AUTONOMOUS_BRANCH_NAME_REGEX);
	});

	it("trailing separator is removed after truncation", () => {
		const slug = sanitizeTaskId(`${"a".repeat(MAX_SLUG_LENGTH - 1)}-tail`);
		expect(slug.endsWith("-")).toBe(false);
		expect(slug).toBe("a".repeat(MAX_SLUG_LENGTH - 1));
	});
});

describe("helpers", () => {
	it("formatBranchTimestamp formats UTC as YYYYMMDD-HHmmss with zero padding", () => {
		expect(formatBranchTimestamp(fixedNow())).toBe("20260725-090000");
		expect(formatBranchTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("20260102-030405");
	});

	it("isValidBranchName accepts generated names and rejects foreign ones", () => {
		expect(isValidBranchName("fan-auto/review-1-20260725-090000")).toBe(true);
		expect(isValidBranchName("main")).toBe(false);
		expect(isValidBranchName("master")).toBe(false);
		expect(isValidBranchName("feature/review-1")).toBe(false);
		expect(isValidBranchName("fan-auto/review-1-20260725")).toBe(false);
		expect(isValidBranchName("fan-auto/review 1-20260725-090000")).toBe(false);
	});

	it("BRANCH_PREFIX is fan-auto", () => {
		expect(BRANCH_PREFIX).toBe("fan-auto");
	});
});

describe("AUTONOMOUS_BRANCH_POLICY prompt template", () => {
	it("contains the branch policy rules", () => {
		expect(AUTONOMOUS_BRANCH_POLICY).toContain("fan-auto/<task-id>-<YYYYMMDD-HHmmss>");
		expect(AUTONOMOUS_BRANCH_POLICY).toContain("NEVER commit or push directly to main/master");
		expect(AUTONOMOUS_BRANCH_POLICY).toContain("git push -u origin");
		expect(AUTONOMOUS_BRANCH_POLICY).toContain("gh pr create --base main");
	});
});
