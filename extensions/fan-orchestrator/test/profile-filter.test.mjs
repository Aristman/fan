import { describe, it, expect } from "vitest";
import { filterToolsByProfile, getPermissionLevel } from "../broker-handler.js";

const sampleTools = [
    { id: "mcp__fs__read_file", description: "read", annotations: { readOnly: true } },
    { id: "mcp__fs__write_file", description: "write", annotations: { destructive: true } },
    { id: "mcp__fs__list_dir", description: "list" }, // no annotations
    { id: "mcp__gh__create_issue", description: "create", annotations: { openWorld: true } },
];

describe("F-2.7: getPermissionLevel", () => {
    it("read-only profiles", () => {
        expect(getPermissionLevel("explore")).toBe("read-only");
        expect(getPermissionLevel("plan")).toBe("read-only");
        expect(getPermissionLevel("verify")).toBe("read-only");
        expect(getPermissionLevel("code-research")).toBe("read-only");
    });

    it("all-access profiles", () => {
        expect(getPermissionLevel("implement")).toBe("all");
        expect(getPermissionLevel("bug-fix")).toBe("all");
        expect(getPermissionLevel("tests-impl")).toBe("all");
    });

    it("unknown agent → default 'all'", () => {
        expect(getPermissionLevel("custom-thing")).toBe("all");
        expect(getPermissionLevel(undefined)).toBe("all");
    });
});

describe("F-2.7: filterToolsByProfile", () => {
    it("'all' returns everything", () => {
        expect(filterToolsByProfile(sampleTools, "all")).toHaveLength(4);
    });

    it("'none' returns empty", () => {
        expect(filterToolsByProfile(sampleTools, "none")).toEqual([]);
    });

    it("'read-only' includes only tools with annotations.readOnly=true", () => {
        const result = filterToolsByProfile(sampleTools, "read-only");
        expect(result.map(t => t.id)).toEqual(["mcp__fs__read_file"]);
    });

    it("null/undefined tools returns empty", () => {
        expect(filterToolsByProfile(null, "all")).toEqual([]);
        expect(filterToolsByProfile(undefined, "read-only")).toEqual([]);
    });
});
