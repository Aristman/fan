// @fan/dashboard/components — <chat-view> element

import type { GetSessionResponse, SessionMessage } from "@fan/api-gateway/types";
import { html, LitElement, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
	AlertTriangle,
	Brain,
	Check,
	ChevronRight,
	Clock,
	Copy,
	FileText,
	Loader2,
	Send,
	Terminal,
	X,
} from "lucide";
import type { FanApiClient } from "../api/client.js";
import type { FanWsClient } from "../api/ws-client.js";
import { icon } from "../lib/icon.js";

// ---------------------------------------------------------------------------
// Local format helpers (avoid dependency on @seaagents/fan-web-ui internals)
// ---------------------------------------------------------------------------

function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("chat-view")
export class ChatView extends LitElement {
	// -----------------------------------------------------------------------
	// Properties (set by parent)
	// -----------------------------------------------------------------------

	@property({ attribute: false }) apiClient!: FanApiClient;
	@property({ attribute: false }) wsClient!: FanWsClient;
	@property({ attribute: false }) sessionId!: string;

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------

	@state() session: GetSessionResponse | null = null;
	@state() loading = false;
	@state() sendingMessage = false;
	@state() inputValue = "";
	@state() streamingContent = "";
	@state() thinkingContent = "";
	@state() isStreaming = false;
	@state() currentToolName: string | null = null;
	@state() isThinking = false;
	@state() copiedId: string | null = null;
	/** F-2.12: 1-based queue position when the message was queued (server busy), null otherwise */
	@state() queuePosition: number | null = null;
	/** F-2.15: queue capacity limit when the message was rejected (QUEUE_OVERFLOW), null otherwise */
	@state() queueFullLimit: number | null = null;

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private unsubMessage: (() => void) | null = null;
	private unsubStatus: (() => void) | null = null;
	private autoScrollEnabled = true;
	private loadVersion = 0;

	@query("#messages-container") private messagesContainer!: HTMLElement;
	@query("#message-input") private messageInput!: HTMLTextAreaElement;

	// -----------------------------------------------------------------------
	// No shadow DOM — Tailwind styles need to penetrate
	// -----------------------------------------------------------------------

	override createRenderRoot(): this {
		return this;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	override connectedCallback(): void {
		super.connectedCallback();
		this.loadSession();
		this.connectWs();
	}

	override disconnectedCallback(): void {
		// Unsubscribe WS handlers
		if (this.unsubMessage) {
			this.unsubMessage();
			this.unsubMessage = null;
		}
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}
		super.disconnectedCallback();
	}

	override willUpdate(changed: Map<string, unknown>): void {
		if (changed.has("sessionId") && this.sessionId) {
			// Reload session and reconnect WS when sessionId changes
			this.loadVersion++;
			this.session = null;
			this.streamingContent = "";
			this.thinkingContent = "";
			this.isStreaming = false;
			this.currentToolName = null;
			this.isThinking = false;
			this.queuePosition = null;
			this.queueFullLimit = null;
			this.loadSession();
			this.connectWs();
		}
	}

	override updated(): void {
		if (this.autoScrollEnabled) {
			this.scrollToBottom();
		}
	}

	// -----------------------------------------------------------------------
	// Data loading
	// -----------------------------------------------------------------------

	async loadSession(): Promise<void> {
		if (!this.sessionId || !this.apiClient) return;
		const expectedVersion = this.loadVersion;
		this.loading = true;
		try {
			const result = await this.apiClient.getSession(this.sessionId);
			// Discard stale response if sessionId changed while loading
			if (expectedVersion !== this.loadVersion) return;
			this.session = result;

			// Normalize message content: fan-agent-core returns content as array of objects,
			// but dashboard expects content as plain string
			if (this.session.messages) {
				this.session.messages = this.session.messages.map((msg) => {
					if (typeof msg.content === "object" && Array.isArray(msg.content)) {
						const blocks = msg.content as Array<Record<string, unknown>>;
						const textParts = blocks.filter((b) => b.type === "text").map((b) => (b.text as string) || "");
						return { ...msg, content: textParts.join("") };
					}
					return msg;
				});
			}

			this.autoScrollEnabled = true;
		} catch (err) {
			console.error("Failed to load session:", err);
		} finally {
			this.loading = false;
		}
	}

	// -----------------------------------------------------------------------
	// WebSocket
	// -----------------------------------------------------------------------

	async connectWs(): Promise<void> {
		// Clean up previous subscriptions
		if (this.unsubMessage) {
			this.unsubMessage();
			this.unsubMessage = null;
		}
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}

		if (!this.wsClient) return;

		this.unsubMessage = this.wsClient.onMessage((msg) => {
			this.handleWsMessage(msg);
		});

		this.unsubStatus = this.wsClient.onStatusChange((status) => {
			console.log("[chat-view] WS status:", status);
			if (status === "connected") {
				// Re-subscribe to this session on reconnect
				this.wsClient.send({ type: "subscribe", sessionId: this.sessionId });
			}
		});
	}

	private handleWsMessage(msg: unknown): void {
		// Debug: log all WS messages
		console.log("[chat-view] WS message:", JSON.stringify(msg));

		// Narrow to WsAgentEvent
		if (!msg || typeof msg !== "object") return;
		const m = msg as Record<string, unknown>;

		// F-2.12: message queued — show position indicator above the input
		if (m.type === "queued") {
			if (m.sessionId !== this.sessionId) return;
			this.queuePosition = typeof m.position === "number" ? m.position : null;
			return;
		}

		// F-2.15: queue overflow — message rejected, show warning
		if (m.type === "queue_full") {
			if (m.sessionId !== this.sessionId) return;
			this.queueFullLimit = typeof m.limit === "number" ? m.limit : null;
			return;
		}

		if (m.type !== "agent_event") return;
		if (m.sessionId !== this.sessionId) return;

		const event = m.event as Record<string, unknown> | undefined;
		if (!event) return;

		const eventType = event.type as string | undefined;
		if (!eventType) return;

		switch (eventType) {
			case "agent_start":
			case "turn_start":
				// Engine picked up this session — the queued message is being processed
				this.queuePosition = null;
				this.isThinking = true;
				break;

			case "message_start": {
				const msg = event.message as Record<string, unknown> | undefined;
				const role = (msg?.role as string) || "assistant";
				if (role === "assistant") {
					this.isThinking = false;
					this.isStreaming = true;
					this.streamingContent = "";
					this.thinkingContent = "";
					// Streaming response started — hide the queue indicator
					this.queuePosition = null;
				}
				break;
			}

			case "message_update": {
				// Agent events carry an assistantMessageEvent with sub-types
				const sub = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (!sub) break;
				const subType = sub.type as string | undefined;

				switch (subType) {
					case "thinking_start":
						this.thinkingContent = (sub.delta as string) || "";
						break;
					case "thinking_delta":
						this.thinkingContent += (sub.delta as string) || "";
						break;
					case "thinking_end":
						// Thinking done, content stays in thinkingContent for rendering
						break;
					case "text_start":
						// Start of text content block — streaming begins
						break;
					case "text_delta": {
						const delta = (sub.delta as string) || "";
						this.streamingContent += delta;
						break;
					}
					case "text_end":
						// Text block complete
						break;
					default:
						break;
				}
				break;
			}

			case "message_end": {
				const msg = event.message as Record<string, unknown> | undefined;
				const role = (msg?.role as string) || "";
				if (role !== "assistant") break; // Only process assistant messages
				// Finalize: build a complete assistant message from streaming content
				if (msg) {
					const contentBlocks = msg.content as Array<Record<string, unknown>> | undefined;
					// Extract text from content blocks [{type:"thinking",...},{type:"text",text:"..."}]
					let textContent = "";
					let _thinkingText = "";
					if (Array.isArray(contentBlocks)) {
						for (const block of contentBlocks) {
							if (block.type === "text") {
								textContent += (block.text as string) || "";
							} else if (block.type === "thinking") {
								_thinkingText += (block.thinking as string) || "";
							}
						}
					}
					// Use streaming content as fallback
					const finalContent = textContent || this.streamingContent;
					if (finalContent && this.session) {
						const newMsg: SessionMessage = {
							id: `stream-${Date.now()}`,
							role: "assistant",
							content: finalContent,
							model: (msg.model as string) || undefined,
							createdAt: new Date().toISOString(),
						};
						this.session = {
							...this.session,
							messages: [...this.session.messages, newMsg],
						};
					}
				}
				this.streamingContent = "";
				this.thinkingContent = "";
				this.isStreaming = false;
				break;
			}

			case "turn_end":
				// Turn complete
				break;

			case "agent_end":
				this.isThinking = false;
				this.isStreaming = false;
				this.streamingContent = "";
				this.thinkingContent = "";
				// Do NOT call loadSession() here — it replaces our locally-built
				// assistant message with server data in wrong format (content as array)
				// Notify sidebar to refresh message count
				this.dispatchEvent(
					new CustomEvent("fan:session-updated", {
						detail: { sessionId: this.sessionId },
						bubbles: true,
						composed: true,
					}),
				);
				break;

			case "tool_execution_start":
				this.currentToolName = (event.toolName as string) || "tool";
				break;

			case "tool_execution_end":
				this.currentToolName = null;
				break;

			default:
				// Ignore unknown event types (e.g. turn_start)
				break;
		}
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async sendMessage(): Promise<void> {
		if (!this.inputValue.trim() || this.sendingMessage) return;

		const text = this.inputValue.trim();
		this.sendingMessage = true;
		this.inputValue = "";

		// Reset textarea height
		if (this.messageInput) {
			this.messageInput.style.height = "auto";
		}

		// Add user message locally immediately (don't wait for WS round-trip)
		if (this.session) {
			const userMsg: SessionMessage = {
				id: `user-${Date.now()}`,
				role: "user",
				content: text,
				createdAt: new Date().toISOString(),
			};
			this.session = {
				...this.session,
				messages: [...this.session.messages, userMsg],
			};
		}

		try {
			await this.apiClient.sendMessage(this.sessionId, text);
			// WS will stream the response
		} catch (err) {
			console.error("Failed to send message:", err);
		} finally {
			this.sendingMessage = false;
		}
	}

	private handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.sendMessage();
		}
	}

	private handleTextareaInput(e: Event): void {
		const target = e.target as HTMLTextAreaElement;
		this.inputValue = target.value;

		// Auto-resize
		target.style.height = "auto";
		target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
	}

	// -----------------------------------------------------------------------
	// Scroll helpers
	// -----------------------------------------------------------------------

	private scrollToBottom(): void {
		if (this.messagesContainer) {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}
	}

	private isNearBottom(): boolean {
		if (!this.messagesContainer) return true;
		const { scrollTop, scrollHeight, clientHeight } = this.messagesContainer;
		return scrollHeight - scrollTop - clientHeight < 100;
	}

	private handleScroll(): void {
		this.autoScrollEnabled = this.isNearBottom();
	}

	// -----------------------------------------------------------------------
	// Copy
	// -----------------------------------------------------------------------

	private copyContent(text: string, id: string): void {
		navigator.clipboard.writeText(text).then(() => {
			this.copiedId = id;
			setTimeout(() => {
				this.copiedId = null;
			}, 2000);
		});
	}

	// -----------------------------------------------------------------------
	// Relative time
	// -----------------------------------------------------------------------

	private relativeTime(dateStr: string): string {
		try {
			const date = new Date(dateStr);
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffSec = Math.floor(diffMs / 1000);

			if (diffSec < 60) return "just now";
			const diffMin = Math.floor(diffSec / 60);
			if (diffMin < 60) return `${diffMin}m ago`;
			const diffHr = Math.floor(diffMin / 60);
			if (diffHr < 24) return `${diffHr}h ago`;
			const diffDay = Math.floor(diffHr / 24);
			return `${diffDay}d ago`;
		} catch {
			return "";
		}
	}

	// -----------------------------------------------------------------------
	// Simple markdown rendering
	// -----------------------------------------------------------------------

	private renderMarkdown(text: string) {
		// Escape HTML
		let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

		// Code blocks: ```lang\ncode\n```
		escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
			return `<pre class="bg-foreground/5 rounded-md p-3 my-2 overflow-x-auto text-xs font-mono"><code class="language-${lang}">${code.trim()}</code></pre>`;
		});

		// Inline code: `code`
		escaped = escaped.replace(
			/`([^`]+)`/g,
			"<code class='bg-foreground/10 px-1.5 py-0.5 rounded text-xs font-mono'>$1</code>",
		);

		// Bold: **text**
		escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

		// Italic: *text*
		escaped = escaped.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

		// Lists: - item or * item or 1. item
		escaped = escaped.replace(/^(\s*)([-*])\s+(.+)$/gm, "$1<li class='ml-4 list-disc'>$3</li>");
		escaped = escaped.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, "$1<li class='ml-4 list-decimal'>$3</li>");

		// Convert consecutive <li> elements into <ul> or <ol>
		escaped = escaped.replace(
			/((?:<li class='ml-4 list-disc'>.*<\/li>\n?)+)/g,
			"<ul class='my-1 space-y-0.5'>$1</ul>",
		);
		escaped = escaped.replace(
			/((?:<li class='ml-4 list-decimal'>.*<\/li>\n?)+)/g,
			"<ol class='my-1 space-y-0.5'>$1</ol>",
		);

		// Line breaks
		escaped = escaped.replace(/\n/g, "<br>");

		return unsafeHTML(escaped);
	}

	// -----------------------------------------------------------------------
	// Message renderers
	// -----------------------------------------------------------------------

	private renderUserMessage(msg: SessionMessage) {
		const isCopied = this.copiedId === msg.id;
		const copyIcon = isCopied ? icon(Check, "w-3.5 h-3.5") : icon(Copy, "w-3.5 h-3.5");

		return html`
      <div class="flex justify-end mb-1">
        <div class="max-w-[80%] flex flex-col items-end">
          <div
            class="bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap"
          >
            ${msg.content}
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-[10px] text-muted-foreground">
              ${this.relativeTime(msg.createdAt)}
            </span>
            <button
              class="p-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
              @click=${() => this.copyContent(msg.content, msg.id)}
              title="Copy"
            >
              ${copyIcon}
            </button>
          </div>
        </div>
      </div>
    `;
	}

	private renderAssistantMessage(msg: SessionMessage) {
		const isCopied = this.copiedId === msg.id;

		return html`
      <div class="flex justify-start mb-1">
        <div class="max-w-[80%]">
          <div class="text-sm leading-relaxed prose-sm">
            ${this.renderMarkdown(msg.content)}
          </div>
          <div class="flex items-center gap-2 mt-1.5">
            ${
					msg.model
						? html`<span
                  class="text-[10px] px-1.5 py-0.5 rounded bg-foreground/5 text-muted-foreground font-mono"
                >
                  ${msg.model}
                </span>`
						: nothing
				}
            ${
					msg.tokens
						? html`<span class="text-[10px] text-muted-foreground">
                  ${formatTokenCount(msg.tokens)} tokens
                </span>`
						: nothing
				}
            ${
					typeof msg.cost === "number" && msg.cost > 0
						? html`<span class="text-[10px] text-muted-foreground">
                  ${formatCost(msg.cost)}
                </span>`
						: nothing
				}
            <span class="text-[10px] text-muted-foreground">
              ${this.relativeTime(msg.createdAt)}
            </span>
            <button
              class="p-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
              @click=${() => this.copyContent(msg.content, msg.id)}
              title="Copy"
            >
              ${isCopied ? icon(Check, "w-3.5 h-3.5") : icon(Copy, "w-3.5 h-3.5")}
            </button>
          </div>
        </div>
      </div>
    `;
	}

	private renderToolMessage(msg: SessionMessage) {
		const toolName =
			msg.content
				.split("\n")[0]
				.replace(/^Tool:\s*/i, "")
				.trim() || "Tool";
		const toolOutput = msg.content.includes("\n") ? msg.content.substring(msg.content.indexOf("\n") + 1).trim() : "";

		return html`
      <div class="flex justify-start mb-1">
        <div class="max-w-[85%] w-full">
          <details class="group rounded-lg border border-border overflow-hidden">
            <summary
              class="flex items-center gap-2 px-3 py-2 text-xs font-medium cursor-pointer hover:bg-foreground/5 transition-colors select-none"
            >
              ${icon(Terminal, "w-3.5 h-3.5 text-muted-foreground")}
              <span class="font-mono">${toolName}</span>
              <span class="text-muted-foreground">
                ${icon(ChevronRight, "w-3 h-3 transition-transform group-open:rotate-90")}
              </span>
            </summary>
            ${
					toolOutput
						? html`<pre
                  class="px-3 py-2 text-xs bg-foreground/5 overflow-x-auto font-mono whitespace-pre-wrap border-t border-border"
                >${toolOutput}</pre>`
						: nothing
				}
          </details>
        </div>
      </div>
    `;
	}

	private renderStreamingMessage() {
		if (!this.streamingContent) return nothing;

		return html`
      <div class="flex justify-start mb-1">
        <div class="max-w-[80%]">
          <div class="text-sm leading-relaxed prose-sm">
            ${this.renderMarkdown(this.streamingContent)}
            <span
              class="inline-block w-2 h-4 bg-current ml-0.5 animate-pulse"
              style="vertical-align: text-bottom"
            ></span>
          </div>
        </div>
      </div>
    `;
	}

	private renderThinkingIndicator() {
		if (!this.isThinking && !this.thinkingContent) return nothing;

		const showText = this.thinkingContent || "";

		return html`
      <div class="flex items-start gap-2 py-2 text-muted-foreground text-sm">
        ${this.isThinking ? html`<span class="mt-0.5">${icon(Loader2, "w-4 h-4 animate-spin")}</span>` : html`<span class="mt-0.5">${icon(Brain, "w-4 h-4")}</span>`}
        <div class="flex-1 min-w-0">
          <details class="group">
            <summary class="cursor-pointer text-xs opacity-70 hover:opacity-100 transition-opacity">
              ${this.isThinking ? "Thinking..." : "Thoughts"}
            </summary>
            <div class="mt-1 text-xs opacity-60 italic leading-relaxed whitespace-pre-wrap break-words">${showText}</div>
          </details>
        </div>
      </div>
    `;
	}

	private renderToolIndicator() {
		if (!this.currentToolName) return nothing;

		return html`
      <div class="flex items-center gap-2 py-2 text-muted-foreground text-sm">
        ${icon(Terminal, "w-4 h-4")}
        <span class="font-mono text-xs">${this.currentToolName}</span>
        <span class="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
      </div>
    `;
	}

	private dismissQueueFull(): void {
		this.queueFullLimit = null;
	}

	// F-2.12 / F-2.15: queue position indicator and overflow warning above the input
	private renderQueueIndicator() {
		return html`
      ${
				this.queueFullLimit !== null
					? html`
            <div class="max-w-4xl mx-auto mb-2">
              <div
                data-testid="queue-full-alert"
                role="alert"
                class="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400"
              >
                ${icon(AlertTriangle, "w-4 h-4")}
                <span class="flex-1">Очередь заполнена (лимит ${this.queueFullLimit})</span>
                <button
                  class="p-0.5 rounded hover:bg-red-500/20 transition-colors"
                  @click=${() => this.dismissQueueFull()}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  ${icon(X, "w-3.5 h-3.5")}
                </button>
              </div>
            </div>
          `
					: nothing
			}
      ${
				this.queuePosition !== null
					? html`
            <div class="max-w-4xl mx-auto mb-2">
              <div
                data-testid="queue-position-alert"
                role="status"
                class="flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400"
              >
                ${icon(Clock, "w-4 h-4")}
                <span>В очереди, позиция ${this.queuePosition}</span>
              </div>
            </div>
          `
					: nothing
			}
    `;
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	override render() {
		const messages = this.session?.messages ?? [];

		return html`
      <div class="flex flex-col flex-1 min-h-0">
        <!-- ── Messages area ──────────────────────────────────────────── -->
        <div
          id="messages-container"
          class="flex-1 overflow-y-auto p-4 space-y-4"
          @scroll=${this.handleScroll}
        >
          ${
					this.loading
						? html`
                <div
                  class="flex items-center justify-center h-full text-muted-foreground text-sm"
                >
                  ${icon(Loader2, "w-5 h-5 animate-spin mr-2")}
                  Loading session…
                </div>
              `
						: messages.length === 0 && !this.isStreaming && !this.isThinking
							? html`
                  <div
                    class="flex flex-col items-center justify-center h-full text-muted-foreground gap-3"
                  >
                    ${icon(FileText, "w-10 h-10 opacity-30")}
                    <p class="text-sm">No messages yet. Start a conversation!</p>
                  </div>
                `
							: nothing
				}

          ${messages.map((msg) => {
					switch (msg.role) {
						case "user":
							return this.renderUserMessage(msg);
						case "assistant":
							return this.renderAssistantMessage(msg);
						case "tool":
							return this.renderToolMessage(msg);
						default:
							return nothing;
					}
				})}

          ${this.renderThinkingIndicator()}
          ${this.renderToolIndicator()}
          ${this.renderStreamingMessage()}
        </div>

        <!-- ── Input area ─────────────────────────────────────────────── -->
        <div class="border-t border-border p-4">
          ${this.renderQueueIndicator()}
          <div
            class="flex items-end gap-2 max-w-4xl mx-auto"
          >
            <textarea
              id="message-input"
              class="flex-1 resize-none rounded-xl border border-border bg-background px-4 py-2.5 text-sm
                     placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50
                     transition-shadow min-h-[40px] max-h-[200px]"
              rows="1"
              placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
              .value=${this.inputValue}
              @input=${this.handleTextareaInput}
              @keydown=${this.handleKeydown}
              ?disabled=${this.sendingMessage}
            ></textarea>
            <button
              class="flex items-center justify-center w-10 h-10 rounded-xl bg-primary text-primary-foreground
                     hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              @click=${() => this.sendMessage()}
              ?disabled=${!this.inputValue.trim() || this.sendingMessage}
              title="Send message"
              aria-label="Send message"
            >
              ${this.sendingMessage ? icon(Loader2, "w-4 h-4 animate-spin") : icon(Send, "w-4 h-4")}
            </button>
          </div>
        </div>
      </div>
    `;
	}
}

// Guard against double-registration
if (!customElements.get("chat-view")) {
	customElements.define("chat-view", ChatView);
}
