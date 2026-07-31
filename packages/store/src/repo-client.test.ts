import { describe, expect, it } from "vitest";
import { RepoClient } from "./repo-client.js";

// Access private static methods via cast for testing
const RC = RepoClient as unknown as {
	isFileUrl(url: string): boolean;
	toFileUrl(url: string): string;
	resolveDownloadUrl(pkg: { repoUrl?: string; downloadUrl: string }): string;
};

describe("RepoClient.isFileUrl", () => {
	it("recognizes file:// URLs", () => {
		expect(RC.isFileUrl("file:///C:/Users/User/fan-store")).toBe(true);
		expect(RC.isFileUrl("file:///home/user/store")).toBe(true);
		expect(RC.isFileUrl("file:///tmp/test")).toBe(true);
	});

	it("recognizes Windows absolute paths", () => {
		expect(RC.isFileUrl("C:\\Users\\User\\fan-store")).toBe(true);
		expect(RC.isFileUrl("C:/Users/User/fan-store")).toBe(true);
		expect(RC.isFileUrl("D:\\data\\store")).toBe(true);
	});

	it("recognizes POSIX absolute paths", () => {
		expect(RC.isFileUrl("/home/user/store")).toBe(true);
		expect(RC.isFileUrl("/tmp/test")).toBe(true);
	});

	it("rejects HTTP/HTTPS URLs", () => {
		expect(RC.isFileUrl("http://example.com")).toBe(false);
		expect(RC.isFileUrl("https://example.com")).toBe(false);
		expect(RC.isFileUrl("http://fan.sea-agents.ru/fan-store")).toBe(false);
	});

	it("rejects relative paths and network shares", () => {
		expect(RC.isFileUrl("relative/path")).toBe(false);
		expect(RC.isFileUrl("./local")).toBe(false);
		expect(RC.isFileUrl("//network-share")).toBe(false);
	});
});

describe("RepoClient.toFileUrl", () => {
	it("passes through file:// URLs unchanged", () => {
		expect(RC.toFileUrl("file:///C:/Users/User/fan-store")).toBe("file:///C:/Users/User/fan-store");
		expect(RC.toFileUrl("file:///home/user/store")).toBe("file:///home/user/store");
	});

	it("converts Windows paths to file:// URLs", () => {
		const result = RC.toFileUrl("C:\\Users\\User\\fan-store");
		expect(result).toMatch(/^file:\/\/\//);
		expect(result).toContain("C:");
		expect(result).not.toContain("\\");
	});

	it("converts Windows paths with forward slashes", () => {
		const result = RC.toFileUrl("C:/Users/User/fan-store");
		expect(result).toMatch(/^file:\/\/\//);
		expect(result).toContain("C:");
	});

	it("handles paths with special characters (#, ?)", () => {
		// # should be encoded as %23, not treated as URL fragment
		const result = RC.toFileUrl("C:\\tmp\\fan#store");
		expect(result).toMatch(/^file:\/\/\//);
		expect(result).toContain("%23");
	});

	it("returns non-file URLs unchanged", () => {
		expect(RC.toFileUrl("http://example.com")).toBe("http://example.com");
		expect(RC.toFileUrl("relative/path")).toBe("relative/path");
	});
});

describe("RepoClient.resolveDownloadUrl", () => {
	it("resolves remote downloadUrl to local path when repoUrl is a local path", () => {
		const pkg = {
			repoUrl: "C:\\Users\\User\\fan-store",
			downloadUrl: "https://fan.sea-agents.ru/fan-store/packages/fan-orchestrator-7.10.4.tar.gz",
		};
		const resolved = RC.resolveDownloadUrl(pkg);
		expect(resolved).toMatch(/^file:\/\/\//);
		expect(resolved).toContain("packages/fan-orchestrator-7.10.4.tar.gz");
		expect(RC.isFileUrl(resolved)).toBe(true);
	});

	it("resolves remote downloadUrl to local path when repoUrl is file://", () => {
		const pkg = {
			repoUrl: "file:///home/user/fan-store",
			downloadUrl: "https://example.com/packages/my-skill-1.0.0.tar.gz",
		};
		const resolved = RC.resolveDownloadUrl(pkg);
		expect(resolved).toContain("file:///home/user/fan-store/packages/my-skill-1.0.0.tar.gz");
	});

	it("leaves downloadUrl unchanged when repoUrl is remote", () => {
		const pkg = {
			repoUrl: "https://fan.sea-agents.ru/fan-store",
			downloadUrl: "https://fan.sea-agents.ru/fan-store/packages/ext-1.0.0.tar.gz",
		};
		expect(RC.resolveDownloadUrl(pkg)).toBe(pkg.downloadUrl);
	});

	it("leaves downloadUrl unchanged when it is already a file:// URL", () => {
		const pkg = {
			repoUrl: "C:\\Users\\User\\fan-store",
			downloadUrl: "file:///C:/Users/User/fan-store/packages/ext-1.0.0.tar.gz",
		};
		expect(RC.resolveDownloadUrl(pkg)).toBe(pkg.downloadUrl);
	});
});
