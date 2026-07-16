import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";

describe("F-2.6: --remote-tools CLI flag", () => {
	it("parses comma-separated list", () => {
		const result = parseArgs(["node", "fan", "--mode", "rpc", "--remote-tools", "t1,t2,t3"]);
		expect(result.remoteTools).toEqual(["t1", "t2", "t3"]);
	});

	it("trims whitespace and filters empty", () => {
		const result = parseArgs(["node", "fan", "--remote-tools", " t1 , t2 ,, t3 "]);
		expect(result.remoteTools).toEqual(["t1", "t2", "t3"]);
	});

	it("undefined when flag absent", () => {
		const result = parseArgs(["node", "fan", "--mode", "rpc"]);
		expect(result.remoteTools).toBeUndefined();
	});
});
