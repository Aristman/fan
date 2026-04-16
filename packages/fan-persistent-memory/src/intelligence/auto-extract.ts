import type { ExtensionContext } from "@itone/fan-coding-agent";
import type { MemoryCategory, MemoryDraft } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { DraftRepository, MemoryRepository } from "../storage/repositories.js";
import { randomUUID } from "node:crypto";

// ──────────────────────────────────────────────
// Auto-extract: passive learning from dialogue
// ──────────────────────────────────────────────

export class AutoExtractor {
  private turnsSinceExtract = 0;
  private draftCount = 0;

  constructor(
    private draftRepo: DraftRepository,
    private config: MemoryConfig
  ) {}

  /**
   * Called on turn_end. Analyzes recent messages and creates drafts.
   */
  async extract(ctx: ExtensionContext, messages: Array<{ role: string; content?: string }>): Promise<void> {
    if (!this.config.intelligence.autoExtract) return;

    this.turnsSinceExtract++;

    // Guard: minimum turns between extractions
    if (this.turnsSinceExtract < this.config.intelligence.extractMinTurns) return;

    // Guard: minimum messages in conversation
    if (messages.length < this.config.intelligence.extractMinMessages) return;

    // Guard: max drafts per session
    if (this.draftCount >= this.config.intelligence.maxDraftsPerSession) return;

    // Guard: check if any message is a command
    const recentMessages = messages.slice(-6);
    const hasCommand = recentMessages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("/")
    );
    if (hasCommand) return;

    // Sanitize and prepare messages for LLM
    const conversationText = recentMessages
      .map((m) => `${m.role}: ${(m.content ?? "").slice(0, 500)}`)
      .join("\n");

    // Check for sensitive content
    if (this.hasSensitiveContent(conversationText)) return;

    // Create draft via LLM analysis
    try {
      const facts = await this.analyzeConversation(ctx, conversationText);

      if (facts && facts.length > 0) {
        for (const fact of facts) {
          if (!fact.content || fact.content.length > 500) continue;

          this.draftRepo.create({
            content: fact.content,
            category: fact.category,
            tags: fact.tags,
            sourceTurn: `session_turn_${this.turnsSinceExtract}`,
            ttlHours: this.config.intelligence.draftTTLHours,
          });

          this.draftCount++;
        }

        if (facts.length > 0) {
          ctx.ui.notify(`💡 ${facts.length} new memory draft(s) created`, "info");
        }
      }
    } catch {
      // Silently fail — don't disrupt the workflow
    }

    this.turnsSinceExtract = 0;
  }

  /**
   * Analyze conversation via LLM to extract facts.
   * Uses pi.sendUserMessage to trigger a lightweight analysis.
   */
  private async analyzeConversation(
    ctx: ExtensionContext,
    conversationText: string
  ): Promise<Array<{ content: string; category: MemoryCategory; tags: string[] }> | null> {
    // We use a simple heuristic approach instead of an LLM call here
    // to avoid disrupting the main conversation flow.
    // The LLM-based approach will send a followUp message.
    return this.heuristicExtract(conversationText);
  }

  /**
   * Simple heuristic extraction for common patterns.
   */
  private heuristicExtract(
    text: string
  ): Array<{ content: string; category: MemoryCategory; tags: string[] }> | null {
    const facts: Array<{ content: string; category: MemoryCategory; tags: string[] }> = [];
    const lower = text.toLowerCase();

    // Pattern: "I prefer/use/like X"
    const preferMatch = text.match(
      /(?:i |we |operator )(?:prefer|use|like|always|usually|typically|love|hate|don't like|never use)\s+([^.!?\n]{10,200})/i
    );
    if (preferMatch) {
      facts.push({
        content: `Operator ${preferMatch[0].trim()}`,
        category: "preference",
        tags: extractTags(preferMatch[1]!),
      });
    }

    // Pattern: "chose X because" / "decided to use X"
    const decisionMatch = text.match(
      /(?:chose|decided|decided to use|went with|selected|picked)\s+([^.!?\n]{10,200})/i
    );
    if (decisionMatch && !facts.some((f) => f.content.includes(decisionMatch[1]!.slice(0, 20)))) {
      facts.push({
        content: `Decision: ${decisionMatch[0].trim()}`,
        category: "decision",
        tags: extractTags(decisionMatch[1]!),
      });
    }

    // Pattern: explicit instruction-like statements
    const instructionMatch = text.match(
      /(?:always|never|don't|make sure|remember to|important:)\s+([^.!?\n]{10,200})/i
    );
    if (instructionMatch && !facts.some((f) => f.content.includes(instructionMatch[1]!.slice(0, 20)))) {
      facts.push({
        content: `Instruction: ${instructionMatch[0].trim()}`,
        category: "instruction",
        tags: extractTags(instructionMatch[1]!),
      });
    }

    return facts.length > 0 ? facts : null;
  }

  private hasSensitiveContent(text: string): boolean {
    const patterns = [
      /password/i,
      /api[_-]?key/i,
      /secret/i,
      /token[:\s]/i,
      /sk-[a-zA-Z0-9]{20,}/,
      /Bearer\s+[a-zA-Z0-9._\-]+/i,
      /credentials/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  reset(): void {
    this.turnsSinceExtract = 0;
  }
}

function extractTags(text: string): string[] {
  // Simple keyword extraction
  const techKeywords = [
    "react", "vue", "angular", "node", "python", "typescript", "javascript",
    "sql", "postgres", "mysql", "mongodb", "redis", "docker", "kubernetes",
    "git", "github", "linux", "windows", "vscode", "vim", "jest", "vitest",
    "webpack", "vite", "eslint", "prettier", "pnpm", "npm", "yarn",
    "prisma", "drizzle", "express", "fastify", "next", "nuxt",
    "redux", "zustand", "mobx", "tailwind", "sass", "css",
  ];

  const words = text.toLowerCase().split(/[\s,;.!?()]+/);
  return words.filter((w) => techKeywords.includes(w)).slice(0, 5);
}
