# Quick Reference — pi Extension API

## Skeleton

```typescript
import type { ExtensionAPI } from "@fan/fan-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, subscribe to events, register commands
}
```

## Tool Registration

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@fan/fan-ai";

pi.registerTool({
  name: "my_tool",                    // lowercase, underscores ok
  label: "My Tool",                   // display name
  description: "What this tool does", // shown to LLM
  promptSnippet: "Short one-liner for system prompt",
  promptGuidelines: ["When to use this tool."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // USE StringEnum, NOT Type.Literal
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) { return args; },          // optional compat shim
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "result" }], details: {} };
  },
  renderCall(args, theme, context) { return new Text("...", 0, 0); },
  renderResult(result, options, theme, context) { return new Text("...", 0, 0); },
});
```

## Event Subscription

```typescript
import { isToolCallEventType } from "@fan/fan-coding-agent";

// Block/modify tool calls
pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input is mutable
    if (event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command" };
    }
  }
});

// Lifecycle events
pi.on("session_start", async (event, ctx) => { /* event.reason: "startup"|"reload"|"new"|"resume"|"fork" */ });
pi.on("session_shutdown", async (event, ctx) => { /* cleanup */ });
pi.on("before_agent_start", async (event, ctx) => {
  return { message: { customType: "my-ext", content: "...", display: false }, systemPrompt: event.systemPrompt + "..." };
});
pi.on("agent_start", async (event, ctx) => {});
pi.on("agent_end", async (event, ctx) => { /* event.messages */ });
pi.on("turn_start", async (event, ctx) => { /* event.turnIndex */ });
pi.on("turn_end", async (event, ctx) => { /* event.message, event.toolResults */ });
pi.on("context", async (event, ctx) => { return { messages: event.messages.filter(...) }; });
pi.on("tool_result", async (event, ctx) => { return { content: [...], details: {...} }; });

// Event bus for inter-extension communication
pi.events.on("my:event", (data) => {});
pi.events.emit("my:event", { data: 42 });
```

## Command Registration

```typescript
pi.registerCommand("my-cmd", {
  description: "What this command does",
  handler: async (args, ctx) => {
    ctx.ui.notify("Done!", "info");
  },
  getArgumentCompletions: (prefix: string) => {
    return [{ value: "opt1", label: "Option 1" }].filter(i => i.value.startsWith(prefix));
  },
});
```

## UI Interaction

```typescript
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);
const ok = await ctx.ui.confirm("Sure?", "Details");
const name = await ctx.ui.input("Name:", "placeholder");
const text = await ctx.ui.editor("Edit:", "prefilled");
ctx.ui.notify("Message", "info");    // "info" | "warning" | "error"
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);
ctx.ui.setWidget("my-ext", undefined);  // clear
```

## Custom UI Component

```typescript
import { Text, Component } from "@fan/fan-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("Press Enter to confirm, Escape to cancel", 1, 1);
  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };
  return text;
});
```

## State Persistence

```typescript
// Save
pi.appendEntry("my-state", { count: 42 });

// Restore
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // reconstruct state from entry.data
    }
  }
});
```

## File Mutation Safety

```typescript
import { withFileMutationQueue } from "@fan/fan-coding-agent";
import { resolve } from "node:path";

async execute(_toolCallId, params, signal, onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);
  return withFileMutationQueue(absolutePath, async () => {
    // read-modify-write — safe from parallel races
  });
}
```

## Output Truncation

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@fan/fan-coding-agent";

const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
if (truncation.truncated) {
  // inform LLM about truncation
}
```

## Skill Format

```markdown
---
name: my-skill
description: What this skill does and when to use it. Max 1024 chars.
---

# My Skill

## Setup
\`\`\`bash
cd /path/to/skill && npm install
\`\`\`

## Usage
...
```

**Naming rules:** lowercase, a-z, 0-9, hyphens only. No leading/trailing/consecutive hyphens. Must match parent directory name.
