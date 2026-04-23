/**
 * Tests for permissions.ts
 */
import { describe, it, expect } from "vitest";
import { isDangerousCommand } from "../permissions.js";

describe("isDangerousCommand", () => {
  it("should detect rm -rf with force", () => {
    expect(isDangerousCommand("rm -rf /")).toBe("rm recursive+force");
    expect(isDangerousCommand("rm -f -r /")).toBe("rm recursive+force");
    expect(isDangerousCommand("rm --recursive --force /tmp")).toBe("rm recursive+force");
    expect(isDangerousCommand("rm -r -f .")).toBe("rm recursive+force");
  });

  it("should NOT flag plain rm without force", () => {
    expect(isDangerousCommand("rm file.txt")).toBeNull();
    expect(isDangerousCommand("rm -r dir")).toBeNull();
    expect(isDangerousCommand("rm -f file.txt")).toBeNull();
  });

  it("should detect git push --force", () => {
    expect(isDangerousCommand("git push --force origin main")).toBe("git push --force");
    expect(isDangerousCommand("git push -f")).toBe("git push --force");
  });

  it("should detect npm/yarn/pnpm publish", () => {
    expect(isDangerousCommand("npm publish")).toBe("package publish");
    expect(isDangerousCommand("yarn publish")).toBe("package publish");
    expect(isDangerousCommand("pnpm publish")).toBe("package publish");
  });

  it("should detect SQL destructive ops", () => {
    expect(isDangerousCommand("DROP TABLE users")).toBe("SQL destructive");
    expect(isDangerousCommand("TRUNCATE TABLE sessions")).toBe("SQL destructive");
    expect(isDangerousCommand("DELETE FROM users")).toBe("SQL destructive");
  });

  it("should detect disk format", () => {
    expect(isDangerousCommand("format C:")).toBe("disk format");
    expect(isDangerousCommand("mkfs.ext4 /dev/sda1")).toBe("disk format");
  });

  it("should detect system shutdown", () => {
    expect(isDangerousCommand("shutdown now")).toBe("system shutdown");
    expect(isDangerousCommand("reboot")).toBe("system shutdown");
  });

  it("should detect chmod on root", () => {
    expect(isDangerousCommand("chmod 777 /")).toBe("chmod on /");
    expect(isDangerousCommand("chmod -R 755 /etc")).toBe("chmod on /");
  });

  it("should detect find -delete", () => {
    expect(isDangerousCommand("find / -name '*.log' -delete")).toBe("find -delete");
  });

  it("should allow safe commands", () => {
    expect(isDangerousCommand("ls -la")).toBeNull();
    expect(isDangerousCommand("git status")).toBeNull();
    expect(isDangerousCommand("npm install")).toBeNull();
    expect(isDangerousCommand("cat README.md")).toBeNull();
    expect(isDangerousCommand("npm run build")).toBeNull();
    expect(isDangerousCommand("echo hello")).toBeNull();
  });

  it("should be case-insensitive", () => {
    expect(isDangerousCommand("DROP TABLE users")).toBe("SQL destructive");
    expect(isDangerousCommand("drop table users")).toBe("SQL destructive");
  });
});
