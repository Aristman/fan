import { describe, expect, it } from "vitest";
import { isDangerousCommand } from "../permissions.js";

describe("isDangerousCommand", () => {
	// Category 1: rm -rf variants
	it("detects rm -rf", () => {
		expect(isDangerousCommand("rm -rf /tmp/test")).toContain("rm -rf");
	});

	it("detects rm -r -f (separate flags)", () => {
		expect(isDangerousCommand("rm -r -f /tmp/test")).toContain("rm -rf");
	});

	it("detects rm --recursive --force", () => {
		expect(isDangerousCommand("rm --recursive --force /tmp/test")).toContain("rm -rf");
	});

	// Category 2: git push force variants
	it("detects git push --force", () => {
		expect(isDangerousCommand("git push --force origin main")).toBe("Force push to remote");
	});

	it("detects git push -f", () => {
		expect(isDangerousCommand("git push -f origin main")).toBe("Force push to remote");
	});

	it("detects git push --force-with-lease", () => {
		expect(isDangerousCommand("git push --force-with-lease origin main")).toBe("Force push to remote");
	});

	// Category 3: publish commands
	it("detects npm publish", () => {
		expect(isDangerousCommand("npm publish")).toBe("Publishing package to registry");
	});

	it("detects yarn publish", () => {
		expect(isDangerousCommand("yarn publish")).toBe("Publishing package to registry");
	});

	// Category 4: SQL destructive operations
	it("detects DROP TABLE users", () => {
		expect(isDangerousCommand("DROP TABLE users")).toBe("Destructive SQL operation");
	});

	it("detects TRUNCATE TABLE", () => {
		expect(isDangerousCommand("TRUNCATE TABLE sessions")).toBe("Destructive SQL operation");
	});

	it("detects DELETE FROM users", () => {
		expect(isDangerousCommand("DELETE FROM users WHERE id = 1")).toBe("Destructive SQL operation");
	});

	// Category 5: Disk format operations
	it("detects mkfs", () => {
		expect(isDangerousCommand("mkfs ext4 /dev/sda1")).toBe("Disk format/partition operation");
	});

	it("detects format C:", () => {
		expect(isDangerousCommand("format C:")).toBe("Disk format/partition operation");
	});

	// Category 6: System power operations
	it("detects shutdown", () => {
		expect(isDangerousCommand("shutdown -h now")).toBe("System power operation");
	});

	it("detects reboot", () => {
		expect(isDangerousCommand("reboot")).toBe("System power operation");
	});

	// Category 7: Recursive chmod/chown on root
	it("detects chmod -R 777 /", () => {
		expect(isDangerousCommand("chmod -R 777 /")).toBe("Recursive permission change on root directory");
	});

	it("detects chown -R root /", () => {
		expect(isDangerousCommand("chown -R root /")).toBe("Recursive permission change on root directory");
	});

	// Category 8: find -delete
	it("detects find /tmp -delete", () => {
		expect(isDangerousCommand("find /tmp -name '*.log' -delete")).toBe("Find with delete operation");
	});

	// Safe commands
	it("returns null for safe commands (ls, cat, echo, grep)", () => {
		expect(isDangerousCommand("ls -la")).toBeNull();
		expect(isDangerousCommand("cat file.txt")).toBeNull();
		expect(isDangerousCommand("echo hello")).toBeNull();
		expect(isDangerousCommand("grep -r 'pattern' src/")).toBeNull();
	});

	it('returns null for quoted dangerous strings (grep "rm -rf")', () => {
		expect(isDangerousCommand('grep "rm -rf" file.txt')).toBeNull();
	});

	it('returns null for echo "DROP TABLE"', () => {
		expect(isDangerousCommand('echo "DROP TABLE users"')).toBeNull();
	});

	it("returns null for safe shutdown-related commands (systemctl service restart)", () => {
		expect(isDangerousCommand("systemctl restart nginx")).toBeNull();
		expect(isDangerousCommand("systemctl service restart myapp")).toBeNull();
	});
});
