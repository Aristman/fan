/**
 * Tests for initialIndex / initialValue resolution in the extension selector.
 *
 * Verifies:
 * - resolveInitialIndex: valid index passes through; out-of-range / non-integer / undefined → 0.
 * - resolveInitialIndexFromValue: found value → its index; not found → -1 (caller skips).
 */

import { describe, expect, it } from "vitest";
import {
	resolveInitialIndex,
	resolveInitialIndexFromValue,
} from "../src/modes/interactive/components/extension-selector.js";

describe("resolveInitialIndex", () => {
	const options = ["A", "B", "C", "D"];

	it("returns the given index when in range", () => {
		expect(resolveInitialIndex(options, 2)).toBe(2);
	});

	it("returns 0 when initialIndex is undefined", () => {
		expect(resolveInitialIndex(options, undefined)).toBe(0);
	});

	it("returns 0 when initialIndex is out of range (too large)", () => {
		expect(resolveInitialIndex(options, 99)).toBe(0);
	});

	it("returns 0 when initialIndex is negative", () => {
		expect(resolveInitialIndex(options, -1)).toBe(0);
	});

	it("returns 0 when initialIndex is non-integer", () => {
		expect(resolveInitialIndex(options, 1.5)).toBe(0);
	});

	it("returns 0 when initialIndex is NaN", () => {
		expect(resolveInitialIndex(options, Number.NaN)).toBe(0);
	});

	it("accepts boundary index (length - 1)", () => {
		expect(resolveInitialIndex(options, options.length - 1)).toBe(options.length - 1);
	});

	it("returns 0 for empty options array", () => {
		expect(resolveInitialIndex([], 0)).toBe(0);
		expect(resolveInitialIndex([], 5)).toBe(0);
	});
});

describe("resolveInitialIndexFromValue (used by showExtensionSelector)", () => {
	const options = ["☐ Alpha", "✔ Beta", "☐ Gamma", "---", "✔ Готово (1 выбрано)", "❌ Отмена"];

	it("returns the index when value is found", () => {
		expect(resolveInitialIndexFromValue(options, "✔ Beta")).toBe(1);
	});

	it("returns -1 when value is not found", () => {
		expect(resolveInitialIndexFromValue(options, "Missing")).toBe(-1);
	});

	it("returns -1 when initialValue is undefined", () => {
		expect(resolveInitialIndexFromValue(options, undefined)).toBe(-1);
	});

	it("matches the toggled label (☐ → ✔) for the same item", () => {
		// Simulates multiSelect: after toggling "✔ Beta" off, new label is "☐ Beta".
		// The fresh options list reflects the new state.
		const freshOptions = ["✔ Alpha", "☐ Beta", "☐ Gamma", "---", "✔ Готово (1 выбрано)", "❌ Отмена"];
		const toggledLabel = "☐ Beta";
		expect(resolveInitialIndexFromValue(freshOptions, toggledLabel)).toBe(1);
	});
});
