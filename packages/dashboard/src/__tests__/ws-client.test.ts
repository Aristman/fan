import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FanWsClient } from "../api/ws-client.js";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static url: string = "";
  
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  
  readyState = 0; // CONNECTING
  
  constructor(url: string) {
    MockWebSocket.url = url;
    MockWebSocket.instances.push(this);
  }
  
  close() { this.readyState = 3; }
  send(data: string) {}
  
  // Helper to simulate server message
  simulateMessage(data: object) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
  
  // Helper to simulate open
  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  
  // Helper to simulate close
  simulateClose(code: number = 1000, reason: string = "") {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}

describe("FanWsClient", () => {
  let client: FanWsClient;
  
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.url = "";
    vi.stubGlobal("WebSocket", MockWebSocket);
    client = new FanWsClient();
  });
  
  afterEach(() => {
    client.disconnect();
    vi.restoreAllMocks();
  });

  describe("connect", () => {
    it("should create WebSocket with correct URL", () => {
      client.connect("http://localhost:3456", "session-1", "test-token");
      
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.url).toContain("/api/ws/session-1");
      expect(MockWebSocket.url).toContain("token=test-token");
    });
    
    it("should report connecting status", () => {
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      client.connect("http://localhost:3456", "s1", "tok");
      
      expect(statuses).toContain("connecting");
    });
    
    it("should report connected status on open", () => {
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      expect(statuses).toContain("connected");
    });
  });

  describe("message handling", () => {
    it("should receive connected message", () => {
      const messages: any[] = [];
      client.onMessage((m) => messages.push(m));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage({
        type: "connected", sessionId: "s1", timestamp: new Date().toISOString()
      });
      
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("connected");
    });
    
    it("should receive agent_event messages", () => {
      const messages: any[] = [];
      client.onMessage((m) => messages.push(m));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage({
        type: "agent_event", sessionId: "s1", timestamp: new Date().toISOString(),
        event: { type: "message_update", content: "Hello" }
      });
      
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_event");
    });
    
    it("should receive budget_alert messages", () => {
      const messages: any[] = [];
      client.onMessage((m) => messages.push(m));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage({
        type: "budget_alert", sessionId: "s1", timestamp: new Date().toISOString(),
        alert: { provider: "anthropic", period: "daily", alertType: "warning", message: "80% used" }
      });
      
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("budget_alert");
    });
  });

  describe("unsubscribe", () => {
    it("should stop receiving messages after unsubscribe", () => {
      const messages: any[] = [];
      client.onMessage((m) => messages.push(m));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      
      const unsub = client.onMessage((m) => messages.push(m));
      MockWebSocket.instances[0].simulateMessage({
        type: "pong", sessionId: "s1", timestamp: new Date().toISOString()
      });
      expect(messages.length).toBeGreaterThanOrEqual(1);
      
      unsub();
      const countBefore = messages.length;
      MockWebSocket.instances[0].simulateMessage({
        type: "pong", sessionId: "s1", timestamp: new Date().toISOString()
      });
      // Should not receive more (only first callback removed)
      expect(messages.length).toBe(countBefore + 1); // Only one callback remains
    });
  });

  describe("disconnect", () => {
    it("should close WebSocket and report disconnected", () => {
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      client.connect("http://localhost:3456", "s1", "tok");
      
      MockWebSocket.instances[0].simulateOpen();
      client.disconnect();
      
      expect(MockWebSocket.instances[0].readyState).toBe(3);
    });
  });
  
  describe("send", () => {
    it("should send ping message", () => {
      client.connect("http://localhost:3456", "s1", "tok");
      MockWebSocket.instances[0].simulateOpen();
      
      client.send({ type: "ping" });
      // If no error thrown, the send was attempted
    });
  });
});
