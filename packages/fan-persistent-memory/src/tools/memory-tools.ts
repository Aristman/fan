import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@itone/fan-coding-agent";
import { sanitizeContent, type MemoryCategory, type MemoryScope } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { MemoryRepository } from "../storage/repositories.js";
import { invalidateResultCache } from "../rag/retriever.js";
import { generateEmbedding } from "../rag/embeddings.js";
import { Retriever } from "../rag/retriever.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

const Categories = ["operator", "preference", "project", "event", "instruction", "decision"] as const;

const MEMORY_CATEGORIES = Type.Union(
  Categories.map((c) => Type.Literal(c))
);

const MEMORY_SCOPES = Type.Union([Type.Literal("global"), Type.Literal("project")]);

// ──────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────

export function registerMemoryTools(
  pi: ExtensionAPI,
  getRepos: () => { global: MemoryRepository; project: MemoryRepository | null },
  getConfig: () => MemoryConfig,
  getRetriever: () => Retriever | null
) {
  // ─── memory_remember ───────────────────────

  pi.registerTool({
    name: "memory_remember",
    label: "Remember",
    description:
      "Save information to persistent memory for future sessions. Use when you learn something about the operator, project, or decisions made.",
    promptSnippet:
      "Save facts, preferences, decisions, or observations to persistent memory across sessions",
    promptGuidelines: [
      "Use this tool to persist important information between sessions.",
      "Be concise: summarize into one clear statement.",
      "Tag with relevant keywords for future retrieval.",
      "Default scope is 'project'. Use 'global' for cross-project facts.",
      "Ask before saving uncertain or sensitive information.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description: "Information to remember (1-10000 chars)",
        minLength: 1,
        maxLength: 10000,
      }),
      category: Type.String({
        description: "Category of the memory",
        enum: [...Categories],
      }),
      tags: Type.Optional(
        Type.Array(Type.String({ maxLength: 50 }), { maxItems: 20 })
      ),
      scope: Type.Optional(
        Type.String({
          description: "Memory scope (default: project)",
          enum: ["global", "project"],
        })
      ),
      confidence: Type.Optional(
        Type.Number({
          description:
            "Confidence in accuracy (0.0-1.0, default: 0.8 for manual, 0.5 for auto)",
          minimum: 0,
          maximum: 1,
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { global, project } = getRepos();
      const config = getConfig();

      try {
        // Sanitize content
        const content = sanitizeContent(params.content.slice(0, 10000));
        const category = params.category as MemoryCategory;
        const scope = (params.scope ?? "project") as MemoryScope;
        const confidence = params.confidence ?? 0.8;
        const tags = (params.tags ?? []).slice(0, 20).map((t) => t.slice(0, 50));

        // Generate embedding
        onUpdate?.({
          content: [{ type: "text", text: "Generating embedding..." }],
        });

        let embedding: Float32Array | undefined;
        try {
          embedding = (await generateEmbedding(content, config)) ?? undefined;
        } catch {
          // FTS-only mode
        }

        // Select repo
        const repo = scope === "global" ? global : project ?? global;

        // Create memory
        const memory = repo.create({
          content,
          category,
          tags,
          scope,
          projectPath: scope === "project" ? ctx.cwd ?? null : null,
          confidence,
          ...(embedding !== undefined && { embedding }),
          ...(embedding && { embeddingModel: config.embeddings.model }),
        });

        invalidateResultCache();
        return {
          content: [
            {
              type: "text",
              text: `Memory saved: ${memory.id}\n  Category: ${memory.category}\n  Scope: ${memory.scope}\n  Confidence: ${memory.confidence}`,
            },
          ],
          details: {
            id: memory.id,
            status: "saved",
            scope: memory.scope,
            category: memory.category,
            hasEmbedding: !!embedding,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { status: "error" },
        };
      }
    },
  });

  // ─── memory_search ────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description:
      "Searches persistent memory using hybrid RAG: keyword (FTS5) + semantic (embeddings) + recency/frequency/confidence scoring. Falls back to FTS-only substring matching if embeddings are unavailable.",
    promptSnippet:
      "Search persistent memory for operator preferences, project knowledge, past decisions, or instructions",
    promptGuidelines: [
      "Use this tool when you need information from previous sessions.",
      "Good for recalling preferences, architecture decisions, or project context.",
      "Uses hybrid search: keyword (FTS5) + semantic (embeddings) + recency/frequency/confidence scoring.",
      "Falls back to FTS-only substring matching if embeddings are unavailable.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query", minLength: 1 }),
      category: Type.Optional(
        Type.String({
          description: "Filter by category",
          enum: [...Categories],
        })
      ),
      scope: Type.Optional(
        Type.String({
          description: "Search scope (default: both)",
          enum: ["global", "project", "both"],
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results (default: 10, max: 20)",
          minimum: 1,
          maximum: 20,
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { global, project } = getRepos();

      const cat = params.category as MemoryCategory | undefined;
      const scope = params.scope as MemoryScope | "both" | undefined;
      const limit = Math.min(params.limit ?? 10, 20);

      // Try retriever (hybrid RAG: FTS5 + semantic + scoring)
      const retriever = getRetriever();
      if (retriever) {
        try {
          const results = await retriever.retrieve(params.query, {
            scope: scope as any,
            category: cat as any,
            limit: limit ?? 10,
          });

          const formatted = results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content,
            summary: r.memory.summary,
            tags: r.memory.tags,
            score: r.score,
            category: r.memory.category,
            scope: r.memory.scope,
            confidence: r.memory.confidence,
            createdAt: r.memory.createdAt,
          }));

          if (formatted.length === 0) {
            return {
              content: [{ type: "text", text: "No matching memories found." }],
              details: { count: 0, source: "hybrid_rag" },
            };
          }

          const text = formatted
            .map(
              (m) =>
                `[${m.category.toUpperCase()}] [${m.scope}] ${m.summary ?? m.content}\n  Tags: ${m.tags.join(", ")} | Score: ${m.score.toFixed(3)} | Confidence: ${m.confidence.toFixed(2)}`
            )
            .join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: {
              count: formatted.length,
              source: "hybrid_rag",
              results: formatted.map((r) => ({
                id: r.id,
                category: r.category,
                scope: r.scope,
                score: r.score,
                confidence: r.confidence,
              })),
            },
          };
        } catch (err) {
          console.error("[memory_search] Retriever failed, falling back to substring matching:", err);
          // Fall through to substring matching below
        }
      }

      // ── Fallback: substring matching ──
      try {
        // Search both repos
        const globalResults = global.findActive({
          ...(cat !== undefined && { category: cat }),
          limit,
        });
        const projectResults = project
          ?.findActive({ ...(cat !== undefined && { category: cat }), limit })
          ?? [];

        // Merge and deduplicate
        const seen = new Set<string>();
        const all = [...globalResults, ...projectResults].filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        // Simple keyword filter (full RAG runs in retriever)
        const queryLower = params.query.toLowerCase();
        const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2);

        const filtered = keywords.length > 0
          ? all.filter(
              (m) =>
                m.content.toLowerCase().includes(queryLower) ||
                m.summary?.toLowerCase().includes(queryLower) ||
                m.tags.some((t) => keywords.some((k) => t.toLowerCase().includes(k)))
            )
          : all;

        const results = filtered.slice(0, limit);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matching memories found." }],
            details: { count: 0, source: "substring_fallback" },
          };
        }

        const text = results
          .map(
            (m) =>
              `[${m.category.toUpperCase()}] [${m.scope}] ${m.summary ?? m.content}\n  Tags: ${m.tags.join(", ")} | Confidence: ${m.confidence.toFixed(2)}`
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text }],
          details: {
            count: results.length,
            source: "substring_fallback",
            results: results.map((r) => ({
              id: r.id,
              category: r.category,
              scope: r.scope,
              confidence: r.confidence,
            })),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { status: "error" },
        };
      }
    },
  });

  // ─── memory_update ────────────────────────

  pi.registerTool({
    name: "memory_update",
    label: "Update Memory",
    description:
      "Update an existing memory entry. Use to correct, refine, or add information to a saved memory.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to update" }),
      content: Type.Optional(Type.String({ maxLength: 10000 })),
      category: Type.Optional(Type.String({ enum: [...Categories] })),
      tags: Type.Optional(
        Type.Array(Type.String({ maxLength: 50 }), { maxItems: 20 })
      ),
      confidence: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1 })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { global, project } = getRepos();
      const config = getConfig();

      const changedFields: string[] = [];

      // Try global first, then project
      let repo = global;
      let mem = global.findById(params.id);
      if (!mem && project) {
        repo = project;
        mem = project.findById(params.id);
      }
      if (!mem) {
        return {
          content: [{ type: "text", text: `Memory not found: ${params.id}` }],
          details: { status: "not_found" },
        };
      }

      // Build update params
      const updateParams: Parameters<typeof repo.update>[1] = {};

      if (params.content !== undefined) {
        updateParams.content = sanitizeContent(params.content);
        changedFields.push("content");
      }
      if (params.category !== undefined) {
        updateParams.category = params.category as MemoryCategory;
        changedFields.push("category");
      }
      if (params.tags !== undefined) {
        updateParams.tags = params.tags.slice(0, 20);
        changedFields.push("tags");
      }
      if (params.confidence !== undefined) {
        updateParams.confidence = params.confidence;
        changedFields.push("confidence");
      }

      // Re-generate embedding if content changed
      if (params.content !== undefined) {
        try {
          const emb = await generateEmbedding(sanitizeContent(params.content), config);
          if (emb) {
            updateParams.embedding = emb;
            updateParams.embeddingModel = config.embeddings.model;
            changedFields.push("embedding");
          }
        } catch {
          // FTS-only
        }
      }

      if (changedFields.length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update." }],
          details: { status: "no_change" },
        };
      }

      const updated = repo.update(params.id, updateParams);
      invalidateResultCache();

      return {
        content: [
          {
            type: "text",
            text: `Memory updated: ${params.id}\n  Changed: ${changedFields.join(", ")}`,
          },
        ],
        details: {
          id: params.id,
          status: "updated",
          changed_fields: changedFields,
        },
      };
    },
  });

  // ─── memory_forget ────────────────────────

  pi.registerTool({
    name: "memory_forget",
    label: "Forget Memory",
    description:
      "Archive a memory entry (soft delete). The data is preserved and can be restored later.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to archive" }),
      reason: Type.Optional(
        Type.String({ description: "Why archiving this memory" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { global, project } = getRepos();

      const archived = global.archive(params.id) || (project?.archive(params.id) ?? false);

      if (!archived) {
        return {
          content: [{ type: "text", text: `Memory not found or already archived: ${params.id}` }],
          details: { status: "not_found" },
        };
      }

      invalidateResultCache();
      return {
        content: [{ type: "text", text: `Memory archived: ${params.id}` }],
        details: { id: params.id, status: "archived", reason: params.reason ?? null },
      };
    },
  });

  // ─── memory_promote ──────────────────────

  pi.registerTool({
    name: "memory_promote",
    label: "Promote to Global",
    description:
      "Move a project-level memory to global memory, making it available across all projects.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to promote" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { global, project } = getRepos();

      if (!project) {
        return {
          content: [{ type: "text", text: "No project database available." }],
          details: { status: "no_project_db" },
        };
      }

      const mem = project.findById(params.id);
      if (!mem) {
        // Try global (maybe already global)
        const globalMem = global.findById(params.id);
        if (globalMem) {
          return {
            content: [{ type: "text", text: `Memory is already global: ${params.id}` }],
            details: { status: "already_global" },
          };
        }
        return {
          content: [{ type: "text", text: `Memory not found: ${params.id}` }],
          details: { status: "not_found" },
        };
      }

      // Copy to global DB
      const promoted = global.create({
        content: mem.content,
        category: mem.category,
        tags: mem.tags,
        scope: "global",
        confidence: mem.confidence,
      });

      // Remove from project DB
      project.remove(params.id);

      invalidateResultCache();
      return {
        content: [
          {
            type: "text",
            text: `Memory promoted to global: ${promoted.id}`,
          },
        ],
        details: {
          id: promoted.id,
          old_id: params.id,
          status: "promoted",
          new_scope: "global",
        },
      };
    },
  });

  // ─── memory_demote ───────────────────────

  pi.registerTool({
    name: "memory_demote",
    label: "Demote to Project",
    description: "Move a global memory to the current project's memory.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to demote" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { global, project } = getRepos();

      if (!project) {
        return {
          content: [{ type: "text", text: "No project database available." }],
          details: { status: "no_project_db" },
        };
      }

      const mem = global.findById(params.id);
      if (!mem) {
        return {
          content: [{ type: "text", text: `Global memory not found: ${params.id}` }],
          details: { status: "not_found" },
        };
      }

      // Copy to project DB
      const demoted = project.create({
        content: mem.content,
        category: mem.category,
        tags: mem.tags,
        scope: "project",
        projectPath: ctx.cwd,
        confidence: mem.confidence,
      });

      // Remove from global DB
      global.remove(params.id);

      return {
        content: [
          {
            type: "text",
            text: `Memory demoted to project: ${demoted.id}`,
          },
        ],
        details: {
          id: demoted.id,
          old_id: params.id,
          status: "demoted",
          new_scope: "project",
        },
      };
    },
  });
}
