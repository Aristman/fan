// @fan/dashboard/api — FAN WebSocket client
import type { WsOutgoingMessage, WsMessage } from "@fan/api-gateway/types";

// ---------------------------------------------------------------------------
// WsServerMessage — union of all messages the server may send
// ---------------------------------------------------------------------------

/** { type: "connected", sessionId, timestamp } — sent on successful WS handshake */
export interface WsConnected extends WsMessage {
  type: "connected";
}

/** { type: "pong", sessionId, timestamp } — reply to client ping */
export interface WsPong extends WsMessage {
  type: "pong";
}

/** Union of every server→client message */
export type WsServerMessage =
  | WsConnected
  | WsPong
  | WsOutgoingMessage;

// ---------------------------------------------------------------------------
// FanWsClient
// ---------------------------------------------------------------------------

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export class FanWsClient {
  private ws: WebSocket | null = null;

  // Reconnect state
  private baseUrl = "";
  private sessionId = "";
  private token = "";
  private retries = 0;
  private maxRetries = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  // Keep-alive
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly PING_INTERVAL_MS = 30_000;

  // Subscribers
  private readonly messageCallbacks = new Set<(msg: WsServerMessage) => void>();
  private readonly statusCallbacks = new Set<(status: ConnectionStatus) => void>();

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Open a WebSocket connection.
   * If already connected to the same session this is a no-op.
   */
  connect(baseUrl: string, sessionId: string, token: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sessionId = sessionId;
    this.token = token;
    this.intentionalClose = false;
    this.retries = 0;
    this._open();
  }

  /** Subscribe to server messages. Returns an unsubscribe function. */
  onMessage(callback: (msg: WsServerMessage) => void): () => void {
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusCallbacks.add(callback);
    return () => {
      this.statusCallbacks.delete(callback);
    };
  }

  /** Send a message to the server. */
  send(message: { type: "ping" } | { type: "subscribe"; sessionId: string }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Close the connection and stop reconnect attempts. */
  disconnect(): void {
    this.intentionalClose = true;
    this._stopPing();
    this._clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect logic from firing
      this.ws.close();
      this.ws = null;
    }
    this._setStatus("disconnected");
  }

  // -------------------------------------------------------------------
  // Internal — connection management
  // -------------------------------------------------------------------

  private _open(): void {
    this._setStatus("connecting");
    this._clearReconnectTimer();

    const url = `${this.baseUrl}/api/ws/${this.sessionId}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.retries = 0;
      this._setStatus("connected");
      this._startPing();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data && typeof data.type === "string") {
          this._dispatchMessage(data as WsServerMessage);
        }
      } catch {
        // Ignore malformed frames
      }
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this._stopPing();

      if (this.intentionalClose) return;

      // Treat code 1008 (policy violation) or 4001+ as auth errors
      if (ev.code === 1008 || ev.code >= 4000) {
        window.dispatchEvent(new CustomEvent("fan:auth-error"));
      }

      this._setStatus("disconnected");
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onerror fires before onclose with no useful info; status set in onclose
      this._setStatus("error");
    };
  }

  private _scheduleReconnect(): void {
    if (this.intentionalClose || this.retries >= this.maxRetries) return;

    const base = 1000;
    const max = 30_000;
    const delay = Math.min(base * Math.pow(2, this.retries), max);
    this.retries++;

    this.reconnectTimer = setTimeout(() => {
      this._open();
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------
  // Internal — keep-alive
  // -------------------------------------------------------------------

  private _startPing(): void {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, this.PING_INTERVAL_MS);
  }

  private _stopPing(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // -------------------------------------------------------------------
  // Internal — dispatching
  // -------------------------------------------------------------------

  private _dispatchMessage(msg: WsServerMessage): void {
    for (const cb of this.messageCallbacks) {
      try {
        cb(msg);
      } catch {
        // Swallow callback errors so one bad listener doesn't break others
      }
    }
  }

  private _setStatus(status: ConnectionStatus): void {
    for (const cb of this.statusCallbacks) {
      try {
        cb(status);
      } catch {
        // Swallow
      }
    }
  }
}
