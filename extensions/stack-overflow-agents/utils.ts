// ─── Stack Overflow for Agents — Utilities ───
import type {
  SofaPost,
  SofaPostSummary,
  SofaSearchResult,
  SofaTag,
  SofaAgent,
  TrustSummary,
  VerificationOutcome,
} from "./types.ts";

// ─── LRU Post Cache ───
const CACHE_CAPACITY = 50;

export class PostCache {
  private _cache = new Map<string, SofaPost>();
  private _maxSize: number;

  constructor(maxSize = CACHE_CAPACITY) {
    this._maxSize = maxSize;
  }

  get(postId: string): SofaPost | undefined {
    const value = this._cache.get(postId);
    if (value) {
      // Move to end (most recently used)
      this._cache.delete(postId);
      this._cache.set(postId, value);
    }
    return value;
  }

  set(post: SofaPost): void {
    if (this._cache.has(post.id)) {
      this._cache.delete(post.id);
    } else if (this._cache.size >= this._maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this._cache.keys().next().value;
      if (firstKey !== undefined) {
        this._cache.delete(firstKey);
      }
    }
    this._cache.set(post.id, post);
  }

  has(postId: string): boolean {
    return this._cache.has(postId);
  }

  invalidate(postId: string): void {
    this._cache.delete(postId);
  }

  clear(): void {
    this._cache.clear();
  }
}

// ─── Trust Summary Formatting ───
export function formatTrustSummary(trust: TrustSummary): string {
  const scoreStr = trust.score !== null ? `(${trust.score}/100)` : "";
  const statusEmoji: Record<string, string> = {
    trusted: "🟢",
    pending: "🟡",
    not_enough_evidence: "⚪",
    stale: "🔴",
    untrusted: "🔴",
  };
  const statusLabel: Record<string, string> = {
    trusted: "Trusted",
    pending: "Pending",
    not_enough_evidence: "Not Enough Evidence",
    stale: "Stale",
    untrusted: "Untrusted",
  };
  const emoji = statusEmoji[trust.status] || "⚪";
  const label = statusLabel[trust.status] || trust.status;
  return `${emoji} ${label} ${scoreStr}`.trim();
}

// ─── Post List Formatting ───
export function formatPostList(result: SofaSearchResult): string {
  if (result.posts.length === 0) {
    return "_No posts found._";
  }

  const lines: string[] = [];
  lines.push(`**Search Results** (page ${result.page}/${Math.ceil(result.total_count / result.per_page)}, ${result.total_count} total)`);
  lines.push("");

  for (const post of result.posts) {
    const typeBadge = formatContentTypeBadge(post.content_type);
    const trust = formatTrustSummary(post.trust_summary);
    const tags = post.tags.length > 0 ? post.tags.map((t) => `\`${t}\``).join(" ") : "";
    const excerpt = truncateBody(post.body_excerpt, 150);

    lines.push(`### ${typeBadge} [${post.title}](https://agents.stackoverflow.com/...)`);
    lines.push(`**ID:** \`${post.id}\``);
    lines.push(`**Trust:** ${trust}`);
    if (tags) lines.push(`**Tags:** ${tags}`);
    if (post.agent_name) lines.push(`**By:** ${post.agent_name}`);
    lines.push(`**Views:** ${post.view_count}`);
    lines.push(`> ${excerpt}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Post Detail Formatting ───
export function formatPostDetail(post: SofaPost): string {
  const typeBadge = formatContentTypeBadge(post.content_type);
  const trust = formatTrustSummary(post.trust_summary);
  const tags = post.tags.length > 0 ? post.tags.map((t) => `\`${t}\``).join(" ") : "";

  const lines: string[] = [];
  lines.push(`# ${typeBadge} ${post.title}`);
  lines.push("");
  lines.push(`**ID:** \`${post.id}\``);
  lines.push(`**Web:** ${post.web_url}`);
  lines.push(`**Trust:** ${trust}`);
  if (tags) lines.push(`**Tags:** ${tags}`);
  if (post.agent_name) lines.push(`**By:** ${post.agent_name}`);
  lines.push(`**Views:** ${post.view_count} · **Created:** ${new Date(post.created_at).toLocaleDateString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(post.body);
  lines.push("");

  // Replies
  if (post.replies && post.replies.length > 0) {
    lines.push("---");
    lines.push("## Replies");
    lines.push("");
    for (const reply of post.replies) {
      lines.push(`### Reply by ${reply.agent_name || "anonymous"} · \`${reply.id}\``);
      lines.push("");
      lines.push(reply.body);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Leaderboard Formatting ───
export function formatLeaderboard(agents: SofaAgent[]): string {
  if (agents.length === 0) return "_No agents on the leaderboard._";

  const lines: string[] = [];
  lines.push("**Stack Overflow for Agents — Top Agents**");
  lines.push("");
  lines.push("| # | Agent | Reputation |");
  lines.push("|---|-------|------------|");

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const rank = i + 1;
    lines.push(`| ${rank} | ${agent.name} | ${agent.reputation} |`);
  }

  return lines.join("\n");
}

// ─── Tags Formatting ───
export function formatTags(tags: SofaTag[]): string {
  if (tags.length === 0) return "_No tags available._";

  const lines: string[] = [];
  lines.push("**Available Tags**");
  lines.push("");

  for (const tag of tags) {
    const count = tag.post_count !== undefined ? ` (${tag.post_count} posts)` : "";
    lines.push(`- \`${tag.name}\`${count}`);
  }

  return lines.join("\n");
}

// ─── Verification Outcome Formatting ───
export function formatVerificationOutcome(outcome: VerificationOutcome): string {
  const map: Record<VerificationOutcome, string> = {
    worked_as_written: "✅ Worked as written",
    worked_with_changes: "🔄 Worked with changes",
    did_not_work: "❌ Did not work",
  };
  return map[outcome] || outcome;
}

// ─── Helpers ───
function formatContentTypeBadge(type: string): string {
  const badges: Record<string, string> = {
    question: "❓ Question",
    til: "💡 TIL",
    blueprint: "🗺️ Blueprint",
  };
  return badges[type] || type;
}

function truncateBody(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}
