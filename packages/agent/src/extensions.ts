/**
 * Extension system types for @seaagents/fan-agent-core.
 *
 * These types define the extension API that extensions (FAN Store packages)
 * use to interact with the agent runtime. They are minimal and
 * agent-runtime-agnostic — no coding-agent specifics.
 *
 * The concrete implementations live in `@seaagents/fan-coding-agent`.
 * These are structural type definitions only; TypeScript's structural
 * type system ensures compatibility at the property level.
 */

import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
} from "@seaagents/fan-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "./types.js";

// ── TUI type forward declarations ────────────────────────────
// These are structural placeholders. The actual implementations
// are in @seaagents/fan-tui. We use `any` for parameter/return
// types to avoid hard-coding the TUI type dependency.

// ── Extension UI Context ─────────────────────────────────────

export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export interface ExtensionUIContext {
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput(handler: TerminalInputHandler): () => void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setHiddenThinkingLabel(label?: string): void;
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(key: string, content: any | undefined, options?: ExtensionWidgetOptions): void;
	setFooter(factory: any | undefined): void;
	setHeader(factory: any | undefined): void;
	setTitle(title: string): void;
	custom<T>(
		factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
		options?: any,
	): Promise<T>;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	setEditorComponent(factory: any | undefined): void;
	readonly theme: any;
	getAllThemes(): { name: string; path: string | undefined }[];
	getTheme(name: string): any | undefined;
	setTheme(theme: string | any): { success: boolean; error?: string };
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

// ── Context Types ────────────────────────────────────────────

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	model: Model<any> | undefined;
	isIdle(): boolean;
	signal: AbortSignal | undefined;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getContextUsage(): ContextUsage | undefined;
	compact(options?: {
		customInstructions?: string;
		onComplete?: (result: any) => void;
		onError?: (error: Error) => void;
	}): void;
	getSystemPrompt(): string;
}

export interface ExtensionCommandContext extends ExtensionContext {
	waitForIdle(): Promise<void>;
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: any) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	fork(entryId: string): Promise<{ cancelled: boolean }>;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
}

// ── Tool Types ───────────────────────────────────────────────

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, _TState = any> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TParams;
	prepareArguments?: (args: unknown) => Static<TParams>;
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;
	renderCall?: (args: Static<TParams>, theme: any, context: any) => any;
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: any,
		context: any,
	) => any;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function defineTool<TParams extends TSchema, TDetails = unknown, _TState = any>(
	tool: ToolDefinition<TParams, TDetails, _TState>,
): ToolDefinition<TParams, TDetails, _TState> & AnyToolDefinition {
	return tool;
}

// ── Tool Info ────────────────────────────────────────────────

export interface ToolInfo extends Pick<ToolDefinition, "name" | "description" | "parameters"> {
	sourceInfo: SourceInfo;
}

// ── Source Info ──────────────────────────────────────────────

export interface SourceInfo {
	path: string;
	type: "extension" | "built-in";
	extensionName?: string;
}

// ── Resource Events ──────────────────────────────────────────

export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ── Session Events ───────────────────────────────────────────

export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
}

export type SessionEvent = SessionStartEvent | SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionShutdownEvent;

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

// ── Agent Events ─────────────────────────────────────────────

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
}

export interface AgentStartEvent {
	type: "agent_start";
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

// ── Model Events ─────────────────────────────────────────────

export type ModelSelectSource = "set" | "cycle" | "restore";

export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

// ── User Bash Events ─────────────────────────────────────────

export interface UserBashEvent {
	type: "user_bash";
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

// ── Input Events ─────────────────────────────────────────────

export type InputSource = "interactive" | "rpc" | "extension";

export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: InputSource;
}

export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ── Event Results ────────────────────────────────────────────

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

export interface UserBashEventResult {
	operations?: any;
	result?: any;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface BeforeAgentStartEventResult {
	message?: { customType?: string; content?: string; display?: string; details?: unknown };
	systemPrompt?: string;
}

// ── Message Rendering ────────────────────────────────────────

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<TMessage = unknown> = (
	message: TMessage,
	options: MessageRenderOptions,
	theme: any,
) => any | undefined;

// ── Command Registration ─────────────────────────────────────

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => any;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: string;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}

// ── Extension Handler ────────────────────────────────────────

// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

// ── Event Bus ────────────────────────────────────────────────

export interface EventBus {
	emit(event: string, data: unknown): void;
	on(event: string, handler: (data: unknown) => void): () => void;
	off(event: string, handler: (data: unknown) => void): void;
}

// ── Provider Registration ────────────────────────────────────

export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

// ── Extension API ────────────────────────────────────────────

export interface ExtensionAPI {
	// Event Subscription
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// Tool Registration
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// Command, Shortcut, Flag Registration
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
	registerShortcut(
		shortcut: string,
		options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
	): void;
	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void;
	getFlag(name: string): boolean | string | undefined;

	// Message Rendering
	registerMessageRenderer<TMessage>(customType: string, renderer: MessageRenderer<TMessage>): void;

	// Actions
	sendMessage<T = unknown>(
		message: { customType?: string; content?: string; display?: string; details?: T },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
	setSessionName(name: string): void;
	getSessionName(): string | undefined;
	setLabel(entryId: string, label: string | undefined): void;
	getActiveTools(): string[];
	getAllTools(): ToolInfo[];
	setActiveTools(toolNames: string[]): void;
	getCommands(): any[];

	// Model and Thinking Level
	setModel(model: Model<any>): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;

	// Provider Registration
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;

	events: EventBus;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// Re-export common agent-core types for convenience
export type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "./types.js";

// Backward compatibility aliases
export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: any) => void;
	onError?: (error: Error) => void;
}

export type KeyId = string;
export interface AutocompleteItem {
	label: string;
	value: string;
	description?: string;
}

export interface ReadonlyFooterDataProvider {
	getStatus(key: string): string | undefined;
	readonly gitBranch: string | undefined;
	readonly modelInfo: string;
	readonly tokenInfo: string;
}

export interface KeybindingsManager {
	handleInput(data: string): boolean;
	getBindings(): Array<{ key: KeyId; description?: string }>;
}

// Union of all event types that agent-core defines (subset of full ExtensionEvent)
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| UserBashEvent
	| InputEvent;

export interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	[key: string]: unknown;
}
