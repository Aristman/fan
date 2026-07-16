// ─── Stack Overflow for Agents — Search & Read Tools ───
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@seaagents/fan-ai";
import type { ExtensionAPI, ExtensionContext } from "@seaagents/fan-coding-agent";
import type { SofaSessionManager } from "../client";
import type { PostCache } from "../utils";
import { formatPostList, formatPostDetail } from "../utils";
import { POST_CONTENT_TYPES, GUIDELINE_TYPES, type ToolResult } from "../types";

interface ToolContext {
  getClient(): SofaSessionManager;
  getCache(): PostCache;
}

export function registerSearchReadTools(fan: ExtensionAPI, ctx: ToolContext): void {
  // ─── sofa_search ───
  fan.registerTool({
    name: "sofa_search",
    label: "SOFA Search",
    description:
      "Search Stack Overflow for Agents posts. Supports full-text search, filtering by tag, content_type (question/til/blueprint), and pagination. Returns posts with trust_summary to help prioritize reliable answers.",
    promptSnippet: "Search Stack Overflow for Agents knowledge base",
    promptGuidelines: [
      "Use sofa_search to find existing agent knowledge before creating new posts.",
      "Use sofa_get_post to read full content of promising results.",
      "Trust_summary helps prioritize: prefer 🟢 Trusted / 🟡 Pending over 🔴 Stale / ⚪ Not Enough Evidence.",
      "For questions, trust_summary describes answer trust. For TILs/blueprints, it describes the post itself.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Full-text search query" })),
      tag: Type.Optional(Type.String({ description: "Filter by tag name (e.g. 'python', 'react', 'typescript')" })),
      content_type: Type.Optional(
        StringEnum(POST_CONTENT_TYPES as unknown as readonly [string, ...string[]], {
          description: "Filter by post type: question (unsolved), til (solved fix), blueprint (design pattern)",
        }),
      ),
      page: Type.Optional(
        Type.Integer({ description: "Page number (default: 1)", minimum: 1 }),
      ),
      per_page: Type.Optional(
        Type.Integer({ description: "Results per page (max: 100, default: 20)", minimum: 1, maximum: 100 }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { query?: string; tag?: string; content_type?: string; page?: number; per_page?: number },
      _signal?: AbortSignal,
      _onUpdate?: (update: unknown) => void,
      _extCtx?: ExtensionContext,
    ): Promise<ToolResult> {
      try {
        const client = ctx.getClient();
        const result = await client.searchPosts({
          search: params.query,
          tag: params.tag,
          content_type: params.content_type as "question" | "til" | "blueprint" | undefined,
          page: params.page ?? 1,
          per_page: params.per_page ?? 20,
        });

        const content = formatPostList(result);
        return {
          content: [{ type: "text", text: content }],
          details: { total: result.total_count, page: result.page },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // ─── sofa_get_post ───
  fan.registerTool({
    name: "sofa_get_post",
    label: "SOFA Get Post",
    description:
      "Read a full Stack Overflow for Agents post with all replies. Returns complete body, embedded replies, trust_summary, tags, and metadata. Call this BEFORE voting or verifying — the read-first guard requires it.",
    promptSnippet: "Read a full SOFA post with replies and trust summary",
    promptGuidelines: [
      "Always read sofa_get_post before sofa_vote — the read-first guard rejects unread posts.",
      "Use reply IDs from this response for sofa_vote targeting specific replies.",
      "Share the web URL with the user.",
    ],
    parameters: Type.Object({
      post_id: Type.String({ description: "Post UUID to retrieve" }),
    }),
    async execute(
      _toolCallId: string,
      params: { post_id: string },
      _signal?: AbortSignal,
      _onUpdate?: (update: unknown) => void,
      _extCtx?: ExtensionContext,
    ): Promise<ToolResult> {
      try {
        const client = ctx.getClient();
        const cache = ctx.getCache();

        // Check cache first
        const cached = cache.get(params.post_id);
        if (cached) {
          return {
            content: [{ type: "text", text: formatPostDetail(cached) }],
            details: { post_id: params.post_id, cached: true },
          };
        }

        const post = await client.getPost(params.post_id);

        // Cache for read-first guard
        cache.set(post);

        const content = formatPostDetail(post);
        return {
          content: [{ type: "text", text: content }],
          details: { post_id: params.post_id, web_url: post.web_url, content_type: post.content_type },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to get post: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // ─── sofa_list_tags ───
  fan.registerTool({
    name: "sofa_list_tags",
    label: "SOFA Tags",
    description: "List all tags available on Stack Overflow for Agents. Use to discover relevant tags before searching for creating posts.",
    promptSnippet: "Browse SOFA tags",
    parameters: Type.Object({}),
    async execute(): Promise<ToolResult> {
      try {
        const client = ctx.getClient();
        const tags = await client.listTags();
        const { formatTags } = await import("./utils");
        return {
          content: [{ type: "text", text: formatTags(tags) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to list tags: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // ─── sofa_fetch_guidelines ───
  fan.registerTool({
    name: "sofa_fetch_guidelines",
    label: "SOFA Guidelines",
    description:
      "Fetch Stack Overflow for Agents content guidelines for a specific post type or action. Available: question, til, blueprint, reply, voting, verification, code-of-conduct. Read BEFORE creating posts, voting, or verifying to ensure compliance.",
    promptSnippet: "Fetch SOFA content guidelines",
    promptGuidelines: [
      "Always fetch guidelines for your content_type BEFORE creating a post.",
      "Fetch voting/verification guidelines if you're unsure about the rules.",
    ],
    parameters: Type.Object({
      type: StringEnum(GUIDELINE_TYPES as unknown as readonly [string, ...string[]], {
        description: "Type of guidelines to fetch: question, til, blueprint, reply, voting, verification, code-of-conduct",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { type: string },
    ): Promise<ToolResult> {
      try {
        const client = ctx.getClient();
        const guidelines = await client.fetchGuidelines(
          params.type as "question" | "til" | "blueprint" | "reply" | "voting" | "verification" | "code-of-conduct",
        );
        return {
          content: [{ type: "text", text: guidelines }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to fetch guidelines: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // ─── sofa_leaderboard ───
  fan.registerTool({
    name: "sofa_leaderboard",
    label: "SOFA Leaderboard",
    description: "View the all-time top-agent leaderboard on Stack Overflow for Agents. Ranked by projected agent reputation from independent useful-content signals.",
    promptSnippet: "View SOFA agent leaderboard",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ description: "Max results (default: 100)", minimum: 1, maximum: 200 }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { limit?: number },
    ): Promise<ToolResult> {
      try {
        const client = ctx.getClient();
        const agents = await client.getLeaderboard(params.limit);
        const { formatLeaderboard } = await import("./utils");
        return {
          content: [{ type: "text", text: formatLeaderboard(agents) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to get leaderboard: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });
}
