// F-Diag: Diagnostics — RED-фаза TDD.
//
// Модули ../chat-logger.js и ../extension-health.js ещё НЕ существуют:
// весь файл обязан падать с ошибкой импорта (ERR_MODULE_NOT_FOUND).
// После реализации (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт (из architecture.md §14 diagnostics):
//   chat-logger.js:
//     formatSessionStart({ correlationId, role, roleProfile, depth, lineageLen }) → string
//     sendSessionStartMessage({ ...params, chatEmitter }) → void
//     formatHandlerEntry({ correlationId, packages, roleProfile? }) → string
//     logHandlerEntry({ ...params, chatEmitter }) → void
//   extension-health.js:
//     checkExtensionHealth({ extensionId, checks? }) → { healthy, message }
//     formatErrorReply({ correlationId, error, attemptedEscalationTo? }) → string

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSessionStartMessage, formatSessionStart } from "../chat-logger.js";
import { logHandlerEntry, formatHandlerEntry } from "../chat-logger.js";
import { checkExtensionHealth, formatErrorReply } from "../extension-health.js";

// ─── TC-FDiag-1: Session_start chat message ───────────────────────────────────

describe("TC-FDiag-1: Session_start chat message", () => {
  it("TC-FDiag-1a: formatSessionStart produces correct format", () => {
    const msg = formatSessionStart({
      correlationId: "abc123",
      role: "super-orchestrator",
      roleProfile: "backend",
      depth: 2,
      lineageLen: 2,
    });
    expect(msg).toBe("[abc123] super-orchestrator:backend initialized, depth=2, lineage_len=2");
  });

  it("TC-FDiag-1b: sendSessionStartMessage emits to chat + console", () => {
    const events = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = sendSessionStartMessage({
      correlationId: "abc123",
      role: "super-orchestrator",
      roleProfile: "backend",
      depth: 2,
      lineageLen: 2,
      chatEmitter: (msg) => events.push(msg),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("[abc123] super-orchestrator:backend initialized, depth=2, lineage_len=2");
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("[abc123]"));
    consoleLog.mockRestore();
  });

  it("TC-FDiag-1c: chat message has correlationId in expected format", () => {
    const msg = formatSessionStart({
      correlationId: "xyz789",
      role: "orchestrator",
      roleProfile: "qa",
      depth: 4,
      lineageLen: 4,
    });
    expect(msg).toMatch(/^\[xyz789\] orchestrator:qa initialized, depth=4, lineage_len=4$/);
  });
});

// ─── TC-FDiag-2: Handler entry chat message + console.error ───────────────────

describe("TC-FDiag-2: Handler entry chat message + console.error", () => {
  it("TC-FDiag-2a: formatHandlerEntry produces correct format", () => {
    const msg = formatHandlerEntry({
      correlationId: "xyz",
      packages: 3,
      roleProfile: "backend",
    });
    expect(msg).toBe("[handler:xyz] received packages=3, role_profile=backend");
  });

  it("TC-FDiag-2b: logHandlerEntry writes to chat + console.error", () => {
    const events = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    logHandlerEntry({
      correlationId: "xyz",
      packages: 5,
      roleProfile: "frontend",
      chatEmitter: (msg) => events.push(msg),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("[handler:xyz] received packages=5, role_profile=frontend");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[fan-super-orchestrator] delegate handler entered"));
    consoleError.mockRestore();
  });

  it("TC-FDiag-2c: logHandlerEntry with role_profile undefined (back-compat)", () => {
    const msg = formatHandlerEntry({
      correlationId: "legacy",
      packages: 1,
    });
    expect(msg).toBe("[handler:legacy] received packages=1, role_profile=undefined");
  });
});

// ─── TC-FDiag-3: Extension health-check + error-reply ─────────────────────────

describe("TC-FDiag-3: Extension health-check + error-reply", () => {
  it("TC-FDiag-3a: checkExtensionHealth passes on healthy", () => {
    const result = checkExtensionHealth({
      extensionId: "fan-super-orchestrator",
      // No checks provided → healthy by default
    });
    expect(result.healthy).toBe(true);
  });

  it("TC-FDiag-3b: checkExtensionHealth halts with actionable message on broken", () => {
    const result = checkExtensionHealth({
      extensionId: "fan-super-orchestrator",
      checks: [
        () => { throw new Error("initCircuit failed"); },
      ],
    });
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("проверьте");
    expect(result.message).toContain("fan-super-orchestrator");
  });

  it("TC-FDiag-3c: formatErrorReply with escalation info", () => {
    const msg = formatErrorReply({
      correlationId: "corr-123",
      error: "timeout",
      attemptedEscalationTo: "grandparent-corr",
    });
    expect(msg).toBe("[corr-123] delegation failed: timeout; attempted escalation to grandparent=grandparent-corr");
  });
});
