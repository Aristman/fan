/**
 * F-3.2: structuredContent preservation — edge case tests.
 *
 * Covers preservation of structuredContent in result.details for:
 * - Object value
 * - Explicit null
 * - Absent (no structuredContent field)
 * - Complex nested structures
 * - Combined with isError
 * - Empty object
 */

import { describe, expect, it } from "vitest";
import { mapCallToolResult } from "../src/executor.js";

describe("F-3.2: structuredContent preservation", () => {
	it("structuredContent object preserved in details", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { foo: 1, bar: "baz" },
		});
		expect(result.details).toBeDefined();
		expect((result.details as any).structuredContent).toEqual({ foo: 1, bar: "baz" });
	});

	it("structuredContent null not preserved (same as undefined omission)", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "ok" }],
			structuredContent: null,
		});
		// null != null is false, so the key is omitted (same as undefined).
		expect(result.details).toBeDefined();
		expect("structuredContent" in result.details).toBe(false);
		// details may still exist if isError was present
		expect((result.details as any).isError).toBeUndefined();
	});

	it("no structuredContent → details absent or without structuredContent key", () => {
		const result = mapCallToolResult({
			content: [{ type: "text", text: "ok" }],
		});
		expect(result.details).toBeDefined();
		expect("structuredContent" in result.details).toBe(false);
	});

	it("structuredContent with nested arrays/objects", () => {
		const complex = {
			data: [1, 2, 3],
			meta: { timestamp: 12345, tags: ["a", "b"] },
			bool: true,
			nullable: null,
		};
		const result = mapCallToolResult({
			content: [],
			structuredContent: complex,
		});
		expect((result.details as any).structuredContent).toEqual(complex);
	});

	it("structuredContent + isError combine in details", () => {
		const result = mapCallToolResult({
			content: [],
			isError: true,
			structuredContent: { error: "validation failed" },
		});
		expect((result.details as any).isError).toBe(true);
		expect((result.details as any).structuredContent).toEqual({ error: "validation failed" });
	});

	it("structuredContent with empty object preserved", () => {
		const result = mapCallToolResult({
			content: [],
			structuredContent: {},
		});
		expect(result.details).toBeDefined();
		expect((result.details as any).structuredContent).toEqual({});
	});
});
